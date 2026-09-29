# AccountPulse Final Customer Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auditable controlled-live/customer-live boundary, a recoverable organisation-scoped operational-data reset, fresh-Xero-sync reconciliation, and a separately approved final customer rollout without weakening any existing reminder safeguard.

**Architecture:** Keep `sendMode` as the emergency provider-call switch and add `rolloutScope` as the recipient-scope switch. A pure shared send-policy function is called by every outbound path immediately before provider submission. Organisation operational state, reset manifests, and reconciliation records are stored in PostgreSQL. A protected one-off ECS task performs reset preparation/execution while the workflow drains workers and snapshots RDS. The Next.js Admin UI exposes state, evidence, reconciliation, and controlled/customer transitions, but never exposes the destructive reset as an ordinary web button.

**Tech Stack:** TypeScript 6, Next.js 16 App Router, React 19, Drizzle ORM/PostgreSQL 17, pg-boss, Vitest, Playwright, AWS ECS/RDS/GitHub Actions, Sinch Engage APAC, Xero Custom Connections

**Spec:** `docs/superpowers/specs/2026-09-29-accountpulse-final-rollout-design.md`

## Global Constraints

- Existing organisations migrate to `rolloutScope = CONTROLLED`; deployment must not change their current `sendMode`.
- The only persisted sending combinations are dry-run/controlled, live/controlled, and live/customer. Emergency dry-run atomically restores controlled scope.
- Test SMS remains technical-allowlist-only in every rollout scope.
- Customer scope bypasses only the technical launch allowlist. It never bypasses suppression, opt-out, reminder whitelist, pause, dispute, payment promise, invoice eligibility, payment-link, approval, source-version, quiet-hours, provider-limit, idempotency, or unknown-outcome controls.
- Every provider path re-reads policy immediately before its external call.
- The reset is organisation-scoped and transactional; it never uses `TRUNCATE`, deletes configuration/security records, changes live to dry-run, activates customer scope, or promotes a sequence to automatic.
- Reset preparation, reset execution, reset abort, reconciliation acknowledgement, customer activation, return to controlled, and emergency dry-run are immutable audited events without credentials, message bodies, or raw customer destinations.
- A failed reset keeps customer scope disabled and workers paused until an explicitly approved retry or abort.
- Deployment, migration, reset, sync, and reconciliation never auto-activate customer scope.
- Implementation and deployment stop before any production reset or final customer activation. Each operation requires a separate explicit user approval.

## Review Focus

- A scope change racing a claimed send: the worker's last policy read must win and prevent an out-of-scope provider call (Tasks 2 and 3).
- Test SMS in customer scope: a non-allowlisted number must still be recorded as dry-run and never reach Sinch (Tasks 2 and 3).
- Reset isolation: every deleted row must belong to the target organisation, while another organisation and all preserved tables remain byte-for-byte unaffected (Task 6).
- Reset failure: database deletion rolls back, customer scope stays controlled, maintenance remains active, and the snapshot/manifests remain available (Task 6).
- Queued pre-reset work: organisation-owned sync/calculate/send jobs are purged, already-missing records end as safe no-ops, and no retry storm or provider call occurs (Tasks 4-6).
- Reconciliation freshness: another successful Xero sync invalidates the previous acknowledgement, and activation refuses stale evidence (Tasks 4 and 7).
- Compare-and-set transitions: stale pages cannot activate customer scope, restore controlled mode, disable sending, or acknowledge a superseded sync (Task 7).
- Release separation: the standard deployment cannot invoke the reset, and the reset workflow cannot activate customer scope (Task 9).

---

### Task 1: Rollout, maintenance, reset-manifest, and reconciliation persistence

**Files:**
- Modify: `packages/db/src/schema/organisation.ts`
- Create: `packages/db/src/schema/rollout.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/web.ts`
- Modify: `packages/db/src/schema/schema.integration.test.ts`
- Create: `packages/db/drizzle/0006_accountpulse_final_rollout.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/drizzle/meta/0006_snapshot.json`

**Interfaces:**
- Produces `RolloutScope = 'CONTROLLED' | 'CUSTOMER'` and organisation columns `rolloutScope`, `maintenanceMode`, `operationalState`, `operationalStateVersion`, and `latestReconciledSyncAt`.
- `operationalState` values are `READY | RESET_PREPARING | RESET_IN_PROGRESS | SYNC_REQUIRED | RECONCILIATION_REQUIRED | RECONCILED | RESET_FAILED`.
- Produces `operationalResetRuns` with status, target organisation, requesting Admin, deployed commit, snapshot identifier, pre-delete row-count manifest, failure code, and timestamps.
- Produces `rolloutReconciliations` keyed to one exact successful-sync timestamp with active-contact count, outstanding-invoice count, totals by currency, generated-approval count, enabled-sequence count, review-only result, actor, and acknowledgement timestamp.
- Enforces one active reset run per organisation with a partial unique index and unique reconciliation per organisation/sync timestamp.

- [x] **Step 1: Write failing migration and schema tests**

  Cover defaults, accepted enum-like values, active-reset uniqueness, reconciliation uniqueness, foreign keys, and preservation of existing `sendMode`. Seed a live organisation before migration and assert it becomes live/controlled rather than dry-run or customer-live.

- [x] **Step 2: Run the schema tests and verify they fail**

  Run: `pnpm vitest run packages/db/src/schema/schema.integration.test.ts`

  Expected: FAIL because the rollout fields and tables do not exist.

- [x] **Step 3: Implement the additive schema**

  Add typed columns with safe defaults. Keep reset manifests and reconciliations separate from operational receivables so reset deletion cannot remove its own evidence. Export every new type/table from both worker and web database entry points.

- [x] **Step 4: Generate and inspect the named migration**

  Run: `pnpm --filter @bc5000/db db:generate -- --name accountpulse_final_rollout`

  Expected: migration `0006` is additive, backfills `CONTROLLED`, leaves `send_mode` untouched, and contains no destructive table-wide statement.

- [x] **Step 5: Run the schema tests and verify they pass**

  Run: `pnpm vitest run packages/db/src/schema/schema.integration.test.ts`

  Expected: PASS.

- [x] **Step 6: Commit the persistence foundation**

  Run: `git add packages/db && git commit -m "feat: add rollout safety persistence"`

### Task 2: Shared provider-send policy

**Files:**
- Create: `packages/domain/src/send-policy.ts`
- Create: `packages/domain/src/send-policy.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces `evaluateProviderSendPolicy(input)` returning `provider-call | dry-run | blocked` plus a stable reason code.
- Input includes `sendMode`, `liveSendAcknowledged`, `rolloutScope`, `maintenanceMode`, `source`, `channel`, normalised destination, and technical recipient allowlist.
- Sources use the existing canonical values `AUTOMATED_REMINDER | MANUAL_REMINDER | ESCALATION_SMS | INBOX_REPLY | TEST_SMS | XERO_EMAIL`.
- Reason codes distinguish global dry-run, missing acknowledgement, maintenance, controlled-recipient refusal, and Test-SMS allowlist refusal.

- [x] **Step 1: Write the complete policy matrix as failing unit tests**

  Assert all supported send-mode/scope/source combinations, case-insensitive email matching, exact E.164 matching, maintenance refusal, invalid dry-run/customer input safety, and the invariant that `TEST_SMS` never escapes the allowlist.

- [x] **Step 2: Run the policy test and verify it fails**

  Run: `pnpm vitest run packages/domain/src/send-policy.test.ts`

  Expected: FAIL because the policy module does not exist.

- [x] **Step 3: Implement the smallest pure policy**

  Keep business eligibility out of this function; it answers only whether an already-eligible outbound item may call a provider. Treat unknown or unsupported state as blocked.

- [x] **Step 4: Run the policy test and verify it passes**

  Run: `pnpm vitest run packages/domain/src/send-policy.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit the shared policy**

  Run: `git add packages/domain && git commit -m "feat: define shared rollout send policy"`

### Task 3: Enforce the shared policy at every outbound boundary

**Files:**
- Create: `apps/worker/src/services/provider-send-policy.ts`
- Modify: `apps/worker/src/services/pre-send-revalidation.ts`
- Modify: `apps/worker/src/handlers/reminder-execute.ts`
- Modify: `apps/worker/src/handlers/test-sms-execute.ts`
- Modify: `apps/worker/src/handlers/operator-reply-execute.ts`
- Modify: `apps/web/src/server/manual-reminder-service.ts`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/manual-reminder-view.ts`
- Modify: `apps/worker/tests/reminder-execute.integration.test.ts`
- Modify: `apps/worker/tests/test-sms-execute.integration.test.ts`
- Modify: `apps/worker/tests/operator-reply-execute.integration.test.ts`
- Modify: `apps/web/tests/customer-actions.integration.test.ts`
- Modify: `apps/web/tests/manual-reminder-view.test.ts`

**Interfaces:**
- Produces `dispatchWithProviderSendLock(database, input, dispatch)`, which locks and fetches the current organisation row, delegates to Task 2, rechecks suppression, and holds the lock through provider submission.
- Adds `rolloutScope` and maintenance data to reminder revalidation without trusting an earlier page/service read as the final send authority.
- Preserves current dry-run records and error copy while allowing otherwise-eligible customer destinations only in customer scope.

- [x] **Step 1: Add failing worker race and source-coverage tests**

  Cover automated SMS, Xero invoice email, manual customer SMS/email, escalation SMS, Inbox reply, and Test SMS. In each provider handler, mutate scope or maintenance state after the initial claim but before the mocked provider call and assert the second read prevents submission. Assert suppressions and reminder whitelist still win in customer scope.

- [x] **Step 2: Run the focused tests and verify they fail**

  Run: `pnpm vitest run apps/worker/tests/reminder-execute.integration.test.ts apps/worker/tests/test-sms-execute.integration.test.ts apps/worker/tests/operator-reply-execute.integration.test.ts apps/web/tests/customer-actions.integration.test.ts apps/web/tests/manual-reminder-view.test.ts`

  Expected: FAIL because handlers still embed controlled-allowlist logic and do not understand customer scope.

- [x] **Step 3: Replace duplicated send checks with the shared policy**

  Re-read the organisation directly before `sinch.sendSms` and the Xero email call. Map policy refusals to existing dry-run/cancelled terminal states without creating another attempt. Keep Test SMS allowlist-only in both controlled and customer scope. Use the same policy in manual-reminder validation so the page and worker agree.

- [x] **Step 4: Run the focused tests and verify they pass**

  Run: `pnpm vitest run apps/worker/tests/reminder-execute.integration.test.ts apps/worker/tests/test-sms-execute.integration.test.ts apps/worker/tests/operator-reply-execute.integration.test.ts apps/web/tests/customer-actions.integration.test.ts apps/web/tests/manual-reminder-view.test.ts`

  Expected: PASS with zero provider calls for every refused case.

- [x] **Step 5: Commit outbound enforcement**

  Run: `git add packages/domain apps/worker apps/web/src/server/manual-reminder-service.ts apps/web/src/app/'(protected)'/customers apps/web/tests && git commit -m "feat: enforce rollout scope on every send"`

### Task 4: Maintenance gate and post-reset sync lifecycle

**Files:**
- Create: `packages/db/src/repositories/organisation-safety-repository.ts`
- Create: `packages/db/src/repositories/organisation-safety-repository.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/web.ts`
- Modify: `apps/web/src/app/(protected)/approvals/approval-service.ts`
- Modify: `apps/web/src/app/(protected)/settings/integrations/integration-settings.ts`
- Modify: `apps/web/src/server/manual-reminder-service.ts`
- Modify: `apps/web/src/app/(protected)/inbox/inbox-service.ts`
- Modify: `apps/web/src/app/(protected)/escalations/escalation-service.ts`
- Modify: `apps/web/src/app/(protected)/settings/test-sms/test-sms-service.ts`
- Modify: `apps/worker/src/handlers/reminders-calculate.ts`
- Modify: `apps/worker/src/handlers/xero-initial-sync.ts`
- Modify: `apps/worker/src/handlers/xero-incremental-sync.ts`
- Modify: `apps/worker/src/handlers/xero-invoice-refresh.ts`
- Modify: `apps/worker/src/handlers/webhook-process.ts`
- Modify: `apps/web/tests/approvals.integration.test.ts`
- Modify: `apps/web/tests/integration-settings.integration.test.ts`
- Modify: `apps/web/tests/inbox.integration.test.ts`
- Modify: `apps/web/tests/escalations.integration.test.ts`
- Modify: `apps/web/tests/test-sms.integration.test.ts`
- Modify: `apps/worker/tests/reminders-calculate.integration.test.ts`
- Modify: `apps/worker/tests/xero-sync.integration.test.ts`
- Modify: `apps/worker/tests/webhook-process.integration.test.ts`

**Interfaces:**
- Produces `PostgresOrganisationSafetyRepository.assertOperationalMutationAllowed(transactionOrDatabase, organisationId)` and compare-and-set helpers for operational state.
- Operational maintenance blocks new sync, approval, send, operator-reply, reminder calculation, and escalation mutations with `OPERATIONAL_MAINTENANCE`.
- Successful full/incremental sync transitions `SYNC_REQUIRED` to `RECONCILIATION_REQUIRED`, clears `latestReconciledSyncAt`, and records the exact new `lastSuccessfulSyncAt`.
- Webhook receipt remains available; processing a delivery for a reset-deleted record is a safe no-op, while an inbound opt-out can still create/preserve suppression after workers resume.

- [x] **Step 1: Write failing repository and entry-point tests**

  Set maintenance between initial lookup and transactional mutation. Assert every named entry point refuses without partial writes or jobs. Assert a fresh no-cursor sync is full, updates operational state only after success, and invalidates an old reconciliation. Assert reset-deleted webhook targets do not throw or retry.

- [x] **Step 2: Run the focused tests and verify they fail**

  Run: `pnpm vitest run packages/db/src/repositories/organisation-safety-repository.integration.test.ts apps/web/tests/approvals.integration.test.ts apps/web/tests/integration-settings.integration.test.ts apps/web/tests/inbox.integration.test.ts apps/web/tests/escalations.integration.test.ts apps/web/tests/test-sms.integration.test.ts apps/worker/tests/reminders-calculate.integration.test.ts apps/worker/tests/xero-sync.integration.test.ts apps/worker/tests/webhook-process.integration.test.ts`

  Expected: FAIL because maintenance and lifecycle guards are absent.

- [x] **Step 3: Implement transactional maintenance checks**

  Put the final check in the same transaction as each mutation. Do not block sign-in, settings reads, audit reads, provider health tests, or webhook recording. Make missing reset-deleted work return a terminal no-op rather than throw.

- [x] **Step 4: Implement sync-state transitions**

  A null Xero cursor continues to request the full outstanding-invoice set. Set `RECONCILIATION_REQUIRED` only after the invoice/contact write set and sync timestamp succeed. A later sync always invalidates earlier reconciliation evidence.

- [x] **Step 5: Run the focused tests and verify they pass**

  Run: `pnpm vitest run packages/db/src/repositories/organisation-safety-repository.integration.test.ts apps/web/tests/approvals.integration.test.ts apps/web/tests/integration-settings.integration.test.ts apps/web/tests/inbox.integration.test.ts apps/web/tests/escalations.integration.test.ts apps/web/tests/test-sms.integration.test.ts apps/worker/tests/reminders-calculate.integration.test.ts apps/worker/tests/xero-sync.integration.test.ts apps/worker/tests/webhook-process.integration.test.ts`

  Expected: PASS.

- [x] **Step 6: Commit maintenance and sync lifecycle safeguards**

  Run: `git add packages/db apps/web apps/worker && git commit -m "feat: gate operations during reset"`

### Task 5: Organisation job purge administration

**Files:**
- Create: `packages/jobs/src/administration.ts`
- Create: `packages/jobs/src/administration.integration.test.ts`
- Modify: `packages/jobs/src/contracts.ts`
- Modify: `packages/jobs/src/index.ts`
- Modify: `packages/jobs/src/queue.ts`

**Interfaces:**
- Produces `purgeOrganisationOperationalJobs(transaction, { organisationId })` returning counts by job name so queue deletion can share the reset's database transaction.
- Purges only `created`/`retry` jobs whose validated payload belongs to the target organisation and whose names are sync, invoice-refresh, reminder-calculate, reminder-execute, operator-reply, or Test-SMS operational jobs.
- Does not purge active jobs, schedules, provider-test jobs, retention jobs, or persisted webhook evidence.

- [x] **Step 1: Write failing queue-administration tests**

  Seed two organisations and every job state/name. Assert only the target organisation's eligible queued/retry jobs are removed and the returned manifest is exact. Assert SQL uses bound parameters and invalid identifiers are refused.

- [x] **Step 2: Run the queue test and verify it fails**

  Run: `pnpm vitest run packages/jobs/src/administration.integration.test.ts packages/jobs/src/queue.integration.test.ts`

  Expected: FAIL because no organisation purge API exists.

- [x] **Step 3: Implement scoped pg-boss cleanup**

  Use the caller's transaction and the JSON payload's `organisationId`; never delete by queue name alone. Recheck eligible states under lock and return per-name counts for the reset manifest.

- [x] **Step 4: Run the queue tests and verify they pass**

  Run: `pnpm vitest run packages/jobs/src/administration.integration.test.ts packages/jobs/src/queue.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit the queue administration API**

  Run: `git add packages/jobs && git commit -m "feat: purge organisation reset jobs safely"`

### Task 6: Recoverable operational reset service and one-off command

**Files:**
- Create: `apps/worker/src/operations/operational-reset.ts`
- Create: `apps/worker/tests/operational-reset.integration.test.ts`
- Modify: `apps/worker/src/entrypoint.ts`
- Modify: `apps/worker/src/runtime-config.ts`
- Modify: `apps/worker/src/runtime-config.test.ts`
- Modify: `apps/worker/Dockerfile`

**Interfaces:**
- Produces commands `operational-reset prepare`, `operational-reset execute`, and `operational-reset abort` through the existing worker image.
- `prepare` requires organisation ID, reset-run ID, deployed commit, Admin email, and the exact reset acknowledgement; it verifies Admin membership, live/controlled state, no active reset, and customer scope disabled, then atomically enables maintenance and writes request/audit evidence.
- `execute` requires the same run ID plus a completed snapshot identifier, records final pre-delete counts, purges queued organisation jobs through Task 5 in the same transaction, deletes the approved operational tables in that organisation-scoped transaction, resets sequences to `REVIEW`, clears Xero cursor/sync/reconciliation, preserves suppressions and listed configuration/security data, and ends live/controlled in `SYNC_REQUIRED`.
- `abort` requires an Admin email and non-empty reason, records failure/abort evidence, clears maintenance only when no deletion transaction is active, and never activates customer scope.

- [x] **Step 1: Write failing reset precondition and deletion tests**

  Cover exact acknowledgement, Admin verification, live/controlled requirement, active-run exclusion, compare-and-set version, target-organisation isolation, every deleted table, every preserved table, test-SMS history deletion, suppression preservation, sequence review reset, sync-state clearing, row-count manifest, snapshot reference, and audit events.

- [x] **Step 2: Add deterministic rollback and retry tests**

  Inject a failure after several delete statements and assert all deletions roll back, maintenance remains true, operational state becomes `RESET_FAILED`, controlled-live remains unchanged, and a retry with the same run ID is idempotent. Assert duplicate successful execute does not delete new post-reset data.

- [x] **Step 3: Run the reset tests and verify they fail**

  Run: `pnpm vitest run apps/worker/tests/operational-reset.integration.test.ts apps/worker/src/runtime-config.test.ts`

  Expected: FAIL because the reset operation and commands do not exist.

- [x] **Step 4: Implement prepare, execute, and abort**

  Take a PostgreSQL advisory lock for the target organisation and lock its organisation/reset rows. Delete in explicit foreign-key order with `organisation_id = $target` on every statement; do not use dynamic table names or `TRUNCATE`. Store counts and references only, not message bodies, credentials, phone numbers, or email addresses.

- [x] **Step 5: Wire the commands into the bundled worker entrypoint**

  Parse fixed subcommands and validated environment/arguments before starting pg-boss or provider clients. Exit non-zero on failed preconditions so the protected workflow stops.

- [x] **Step 6: Run the reset tests and verify they pass**

  Run: `pnpm vitest run apps/worker/tests/operational-reset.integration.test.ts apps/worker/src/runtime-config.test.ts`

  Expected: PASS.

- [x] **Step 7: Commit the reset operation**

  Run: `git add apps/worker && git commit -m "feat: add protected operational reset"`

### Task 7: Reconciliation and customer-rollout transitions

**Files:**
- Modify: `apps/web/src/app/(protected)/settings/sending/sending-settings.ts`
- Modify: `apps/web/tests/sending-safeguards.integration.test.ts`
- Modify: `apps/web/tests/integration-settings.integration.test.ts`

**Interfaces:**
- Keeps `activateLive` as controlled-live activation and adds `acknowledgeReconciliation`, `activateCustomerRollout`, `returnToControlledLive`, and `disableAllProviderSending`.
- Produces `CUSTOMER_ROLLOUT_ACKNOWLEDGEMENT` distinct from the existing controlled-live acknowledgement.
- Produces `getCustomerRolloutReadiness(database, { organisationId, now })` with a result for every approved gate and evidence identifiers/timestamps safe to render.
- Reconciliation metrics are active contacts, outstanding authorised ACCREC invoices with positive balance, totals by currency, pending approvals, enabled sequences, and all-enabled-sequences-review.

- [x] **Step 1: Write failing reconciliation and activation tests**

  Assert Admin-only access, exact current-sync acknowledgement, non-empty post-reset data, both provider checks under 24 hours, sync under 15 minutes, accepted/delivered allowlisted Test SMS under seven days, no maintenance/reset, every enabled sequence in `REVIEW`, exact final acknowledgement, and CAS refusal on stale state/version.

- [x] **Step 2: Write failing rollback-control tests**

  Assert return-to-controlled requires a reason and preserves live plus allowlist. Assert emergency disable requires a reason and atomically sets dry-run/controlled. Assert neither transition changes sequences or deletes data. Verify complete audit payloads omit PII/content.

- [x] **Step 3: Run the safeguard tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/sending-safeguards.integration.test.ts apps/web/tests/integration-settings.integration.test.ts`

  Expected: FAIL because reconciliation/customer transitions do not exist.

- [x] **Step 4: Implement reconciliation and readiness queries**

  Record one immutable reconciliation row tied to `lastSuccessfulSyncAt`; compare displayed metrics again in the transaction before acknowledgement. Query Test-SMS evidence from canonical Outbox and require its destination to still be on the technical allowlist.

- [x] **Step 5: Implement compare-and-set state transitions and audits**

  Re-evaluate all gates inside the activation transaction, update only from live/controlled plus the expected operational-state version, and write `CUSTOMER_ROLLOUT_ACTIVATED`. Add audited `CUSTOMER_ROLLOUT_RETURNED_TO_CONTROLLED` and `ALL_PROVIDER_SENDING_DISABLED` paths.

- [x] **Step 6: Run the safeguard tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/sending-safeguards.integration.test.ts apps/web/tests/integration-settings.integration.test.ts`

  Expected: PASS.

- [x] **Step 7: Commit rollout transitions**

  Run: `git add apps/web/src/app/'(protected)'/settings/sending apps/web/tests && git commit -m "feat: add customer rollout approval gates"`

### Task 8: Sending controls, reset status, and reconciliation UI

**Files:**
- Modify: `apps/web/src/app/(protected)/settings/sending/actions.ts`
- Modify: `apps/web/src/app/(protected)/settings/sending/page.tsx`
- Create: `apps/web/src/components/rollout-gate-list.tsx`
- Create: `apps/web/src/components/reconciliation-summary.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/tests/sending-safeguards.integration.test.ts`
- Create: `apps/web/tests/sending-controls-ui.test.tsx`
- Modify: `apps/web/e2e/safeguards.spec.ts`

**Interfaces:**
- Produces server actions for reconciliation acknowledgement, customer activation, return to controlled-live, and emergency dry-run.
- Displays exactly `Dry run`, `Controlled live`, or `Customer live`, plus reset phase, snapshot/deletion completion, fresh-sync need, reconciliation status, SMS evidence, and each gate's corrective action.
- Contains no destructive reset button and no live Xero-email test requirement.

- [x] **Step 1: Read the installed Next.js 16 guidance before changing web code**

  Read completely: `apps/web/node_modules/next/dist/docs/01-app/02-guides/forms.md`, `apps/web/node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `apps/web/node_modules/next/dist/docs/01-app/02-guides/redirecting.md`, and `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/04-functions/revalidatePath.md`.

  Expected: implementation follows the installed-version server-action, redirect, and revalidation behaviour.

- [x] **Step 2: Write failing page-model, action, and browser tests**

  Assert the three labels, controlled allowlist explanation, no Xero-email test gate/copy, safe evidence display, reset lifecycle display, reconciliation metrics, exact acknowledgement fields, Admin-only actions, actionable failure copy, and visible rollback controls.

- [x] **Step 3: Run the UI tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/sending-controls-ui.test.tsx apps/web/tests/sending-safeguards.integration.test.ts && pnpm --filter @bc5000/web test:e2e -- safeguards.spec.ts`

  Expected: FAIL because the final-rollout interface is absent.

- [x] **Step 4: Implement the AccountPulse controls and status panels**

  Keep the technical allowlist editable only as a controlled-testing safeguard. Render counts/totals without customer PII. Require exact text for customer activation and a non-empty reason for both rollback actions. After each action, revalidate `/settings/sending` and redirect with a stable success/error code.

- [x] **Step 5: Run the UI tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/sending-controls-ui.test.tsx apps/web/tests/sending-safeguards.integration.test.ts && pnpm --filter @bc5000/web test:e2e -- safeguards.spec.ts`

  Expected: PASS.

- [x] **Step 6: Commit the Admin experience**

  Run: `git add apps/web && git commit -m "feat: add final rollout controls"`

### Task 9: Protected reset workflow, infrastructure outputs, and runbooks

**Files:**
- Create: `.github/workflows/operational-reset.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `infra/lib/data-stack.ts`
- Modify: `infra/lib/service-stack.ts`
- Modify: `infra/test/stacks.test.ts`
- Modify: `infra/test/deployment-workflow.test.ts`
- Create: `infra/test/operational-reset-workflow.test.ts`
- Modify: `apps/worker/src/shutdown.ts`
- Modify: `apps/worker/tests/runtime.integration.test.ts`
- Modify: `docs/runbooks/controlled-launch.md`
- Modify: `docs/runbooks/launch-checklist.md`
- Create: `docs/runbooks/operational-reset.md`

**Interfaces:**
- Produces CloudFormation outputs for the RDS instance identifier and ECS worker cluster/service/task definition needed by a one-off reset workflow.
- Produces a manual `operational-reset.yml` with `staging | production` target, organisation ID, Admin email, deployed commit, exact acknowledgement, and `reset | abort` operation. Production uses the protected `production` GitHub environment and the existing non-cancelling production concurrency group.
- `reset` verifies the deployed worker image commit, invokes the prepare command, drains the worker service to zero and waits for tasks to stop, creates and waits for an encrypted RDS snapshot, invokes the execute command, restores the previous desired count only after success, waits for service stability, and runs readiness checks. `abort` invokes only the audited abort command and restores workers after it succeeds.
- On any execute failure, the workflow leaves workers paused and prints the approved retry/abort runbook; it does not auto-abort or auto-restore sending.
- Standard `deploy.yml` continues to deploy/migrate/smoke-test only and contains no reset or customer-activation command.

- [x] **Step 1: Write failing infrastructure and workflow contract tests**

  Assert outputs exist, worker shutdown drains before closing, reset workflow is dispatch-only, production environment approval is required, deployed SHA is checked, RDS snapshot completes before reset, worker desired count reaches zero before deletion, failure does not restart workers, and no command can set `rolloutScope=CUSTOMER`.

- [x] **Step 2: Run the infrastructure tests and verify they fail**

  Run: `pnpm vitest run infra/test/stacks.test.ts infra/test/deployment-workflow.test.ts infra/test/operational-reset-workflow.test.ts apps/worker/tests/runtime.integration.test.ts`

  Expected: FAIL because the outputs and protected reset workflow do not exist.

- [x] **Step 3: Implement outputs, drain timing, and the manual workflow**

  Preserve the service's original desired count and include a bounded wait. Snapshot identifiers use the environment, organisation-safe suffix, and GitHub run ID. Pass only identifiers/acknowledgement to the task; never echo database credentials or provider secrets. Document the extra deployment-role permissions required for `rds:CreateDBSnapshot`, `rds:DescribeDBSnapshots`, ECS service scaling/run-task, and CloudFormation output reads.

- [x] **Step 4: Update launch/reset documentation**

  Remove the live Xero-email test requirement. Document controlled-live as the state before/during reset, the deleted/preserved table classes, staging drill, failure recovery, fresh-sync reconciliation, separate final customer approval, first-cohort observation, return-to-controlled, and emergency dry-run.

- [x] **Step 5: Run the infrastructure tests and verify they pass**

  Run: `pnpm vitest run infra/test/stacks.test.ts infra/test/deployment-workflow.test.ts infra/test/operational-reset-workflow.test.ts apps/worker/tests/runtime.integration.test.ts`

  Expected: PASS.

- [x] **Step 6: Commit release automation and runbooks**

  Run: `git add .github infra apps/worker/src/shutdown.ts apps/worker/tests/runtime.integration.test.ts docs/runbooks && git commit -m "feat: protect production operational reset"`

### Task 10: End-to-end safety journeys and release verification

**Files:**
- Modify: `apps/web/e2e/safeguards.spec.ts`
- Modify: `apps/web/e2e/automatic-sequence.spec.ts`
- Modify: `packages/testing/src/launch-fixture.ts`
- Create: `packages/testing/src/final-rollout-scenarios.ts`
- Modify: `packages/testing/src/index.ts`
- Modify: `docs/superpowers/plans/2026-09-29-accountpulse-final-rollout.md` checkboxes as tasks complete
- Modify only files required by review findings; do not add unrelated scope.

**Interfaces:**
- Produces deterministic launch fixtures for dry-run, controlled-live, reset/sync-required, reconciled/ready, customer-live, and emergency rollback.
- Produces browser coverage for failed gates, successful reconciliation, exact final acknowledgement, customer activation, controlled rollback, emergency dry-run, Test-SMS allowlist retention, and review-mode first cohort.
- Produces a verified branch that can be deployed without running the reset or activating customer scope.

- [x] **Step 1: Write the missing end-to-end journeys and verify they fail before final wiring**

  Run: `pnpm --filter @bc5000/web test:e2e -- safeguards.spec.ts automatic-sequence.spec.ts`

  Expected: FAIL on at least the new reset/reconciliation/customer-rollout journeys before fixtures and final wiring are complete.

- [x] **Step 2: Complete fixtures and minimal wiring, then rerun browser tests**

  Run: `pnpm --filter @bc5000/web test:e2e -- safeguards.spec.ts automatic-sequence.spec.ts`

  Expected: PASS.

- [x] **Step 3: Run static verification**

  Run: `pnpm lint && pnpm typecheck`

  Expected: PASS.

- [x] **Step 4: Run the full unit/integration suite**

  Run: `pnpm test && pnpm test:integration`

  Expected: PASS with a test count greater than the 320-test baseline recorded before this plan.

- [x] **Step 5: Build all packages and production applications**

  Run: `pnpm build`

  Expected: PASS, including the Next.js production build and bundled reset-capable worker image.

- [x] **Step 6: Inspect migration, workflow, and branch diff**

  Run: `git diff origin/main...HEAD --check && git status --short && git log --oneline origin/main..HEAD`

  Expected: no whitespace errors, secrets, customer data, unexpected generated files, reset invocation in the deployment workflow, or customer-live default.

- [x] **Step 7: Run the required whole-branch review**

  Use `superpowers:requesting-code-review`. Give special attention to send races, organisation scoping, deletion order, preserved suppressions, reset failure state, workflow failure paths, audit PII, and deployment/reset/activation separation. Resolve findings test-first and rerun affected checks.

- [x] **Step 8: Commit verification fixes**

  Run: `git add <reviewed-files> && git commit -m "fix: address final rollout review"`

- [x] **Step 9: Stop for deployment approval**

  Do not push, merge, deploy, reset, sync, reconcile, or activate customer scope unless separately authorised. After an approved deployment, verify production remains live/controlled and the technical allowlist is unchanged, then request the user's explicit production-reset approval.

### Task 11: Approved post-deployment operations (not part of build execution)

**Files:**
- No source changes expected. Record evidence in the protected workflow, application audit trail, and change record only.

**Interfaces:**
- Consumes the deployed and verified build from Task 10.
- Produces a reset production dataset, a fresh reconciled Xero import, and—only after another explicit approval—customer-live scope.

- [ ] **Step 1: After explicit reset approval, run the protected production reset**

  Verify the deployed commit, production remains live/controlled, the allowlist is intact, reset acknowledgement matches, worker drain succeeds, snapshot is available, delete manifest is recorded, reset completes, and production ends live/controlled plus `SYNC_REQUIRED`.

- [ ] **Step 2: Request and monitor a fresh Xero sync**

  Confirm the sync starts with no cursor and completes without sending to non-allowlisted destinations. Compare active contacts, outstanding invoices, totals by currency, approvals, and enabled review-only sequences with Xero.

- [ ] **Step 3: Record reconciliation and re-run rollout gates**

  Send a new allowlisted Test SMS if reset removed the previous evidence. Confirm Accepted/Delivered status, fresh Xero/Sinch health, fresh sync, non-empty data, no maintenance, and all enabled sequences in `REVIEW`.

- [ ] **Step 4: Stop and ask for explicit customer-live approval**

  Present the gate results and reconciliation totals. Do not type the customer-rollout acknowledgement or activate customer scope until the user explicitly approves this separate operation.

- [ ] **Step 5: On approval, activate and observe the first review-mode cohort**

  Verify the `CUSTOMER_ROLLOUT_ACTIVATED` audit event, observe initial provider submissions and outcomes, and keep immediate return-to-controlled and emergency dry-run controls ready. Do not promote any sequence to `AUTOMATIC` as part of this rollout.
