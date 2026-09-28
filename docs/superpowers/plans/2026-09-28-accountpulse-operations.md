# AccountPulse Operations Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified Outbox, durable client/invoice reminder whitelist, Administrator test SMS, escalation call/SMS controls, and linked client/invoice views without weakening AccountPulse's existing send safeguards.

**Architecture:** Extend `outbound_messages` into the canonical history for all new outgoing activity and add a separate lifecycle-preserving `reminder_whitelist_entries` table. Shared services enforce organisation permissions and cancellation, while both reminder calculation and final send claiming check the whitelist. Web pages remain server-rendered Next.js routes with server actions; all provider work stays in the worker queue.

**Tech Stack:** TypeScript 6, Next.js App Router, React 19, Drizzle ORM/PostgreSQL, pg-boss jobs, Vitest, Sinch Engage, Xero Custom Connections

**Spec:** `docs/superpowers/specs/2026-09-28-accountpulse-operations-design.md`

## Global Constraints

- "Whitelist" means stop all current and future reminders; it never bypasses approval or permits sending.
- Operators and Administrators can add whitelist entries; only Administrators can remove them.
- Adding an entry immediately expires applicable approvals and cancels unsent stages, queued messages, and open escalation tasks.
- Removing an entry schedules immediate recalculation and never revives an old approval.
- Client and invoice whitelist entries overlap independently; an invoice resumes only when no active entry covers it.
- Every calculation and the final provider-send claim must check the whitelist.
- Test and manual SMS must retain suppression, live/dry-run, technical recipient allowlist, segment-limit, idempotency, and payment-link controls applicable to that source.
- Every new SMS stores the exact submitted content. Xero entries describe the invoice-email request and never claim to contain Xero's rendered email body.
- Provider-accepted messages are immutable history and cannot be recalled.
- All queries and mutations are organisation-scoped.
- The AI recovery-call script, Xero line-item sync, and proof of completed phone calls are out of scope.

## Review Focus

- A whitelist addition racing a send claim: one operation wins the shared target lock; the loser must not create a second or unsafe provider submission (Task 3).
- Overlapping client and invoice entries: removing either entry alone must leave the invoice excluded (Tasks 2 and 3).
- Repeated form submissions or worker retries: the same request identifier must produce one Outbox record and at most one provider submission (Tasks 1, 4, and 5).
- Historical or Xero-email content: the UI must show an honest fallback instead of fabricated message text (Task 6).
- A valid identifier from another organisation: services and pages must return not-found/forbidden without reading or mutating the foreign record (Tasks 2, 6, 7, 8, and 9).

---

### Task 1: Persistence and authorisation contracts

**Files:**
- Create: `packages/db/src/schema/reminder-whitelist.ts`
- Create: `packages/db/src/repositories/reminder-whitelist-repository.ts`
- Create: `packages/db/src/repositories/message-repository.integration.test.ts`
- Modify: `packages/db/src/schema/messaging.ts`
- Modify: `packages/db/src/schema/reminders.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/repositories/message-repository.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/web.ts`
- Modify: `packages/db/src/schema/schema.integration.test.ts`
- Modify: `packages/auth/src/authorise.ts`
- Modify: `packages/auth/src/authorise.test.ts`
- Create: `packages/db/drizzle/0005_accountpulse_operations.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/drizzle/meta/0005_snapshot.json`

**Interfaces:**
- Produces: `reminderWhitelistEntries`, `ReminderWhitelistScope`, `OutboundSource` values `AUTOMATED_REMINDER | MANUAL_REMINDER | ESCALATION_SMS | INBOX_REPLY | TEST_SMS | XERO_EMAIL`, and stage `origin` values `AUTOMATION | MANUAL_REMINDER | ESCALATION_SMS`.
- Produces: `PostgresReminderWhitelistRepository.findActive(input)`, `.lockTarget(transaction, input)`, `.add(transaction, input)`, and `.remove(transaction, input)`; every input includes `organisationId`, `contactId`, and optional `invoiceId`.
- Produces: `PostgresMessageRepository.beginReminder(input)`, `.queueDirect(input)`, `.claimDirect(input)`, and stage-optional terminal state methods.
- Produces permissions `outbox.read`, `reminder-whitelist.add`, `reminder-whitelist.remove`, and `message.test-sms`.

- [x] **Step 1: Write failing schema, repository, and permission tests**

  Assert active-entry uniqueness, removed-entry history, client/invoice target constraints, stage-less Outbox rows, `ON DELETE SET NULL`, exact-content persistence, direct-send idempotency, and the approved role matrix.

- [x] **Step 2: Run the focused tests and verify they fail**

  Run: `pnpm vitest run packages/db/src/schema/schema.integration.test.ts packages/db/src/repositories/message-repository.integration.test.ts packages/auth/src/authorise.test.ts`

  Expected: FAIL because the new schema, repository APIs, columns, and permissions do not exist.

- [x] **Step 3: Implement the schema and repository contracts**

  `reminder_whitelist_entries` retains removed rows and uses partial unique indexes for active client and invoice targets. `outbound_messages` gains source, content, actor/contact/invoice associations, nullable stage/source version, and failure reason. `operator_replies.outbound_message_id` is nullable and unique. Stage origin defaults to `AUTOMATION`.

- [x] **Step 4: Generate and inspect the named migration**

  Run: `pnpm --filter @bc5000/db db:generate -- --name accountpulse_operations`

  Expected: migration and snapshot contain additive/backfilled changes, preserve existing rows, and change the stage foreign key to `ON DELETE SET NULL`.

- [x] **Step 5: Run the focused tests and verify they pass**

  Run: `pnpm vitest run packages/db/src/schema/schema.integration.test.ts packages/db/src/repositories/message-repository.integration.test.ts packages/auth/src/authorise.test.ts`

  Expected: PASS.

- [x] **Step 6: Commit the persistence foundation**

  Run: `git add packages/db packages/auth && git commit -m "feat: add operations persistence contracts"`

### Task 2: Reminder Whitelist mutation service

**Files:**
- Create: `apps/web/src/server/reminder-whitelist-service.ts`
- Create: `apps/web/tests/reminder-whitelist.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 repository and `JobPublisher`.
- Produces: `createReminderWhitelistService({ database, publisher, clock })` with `add(session, input)`, `remove(session, input)`, and `list(session, input)`.
- `add` input: `{ organisationId, scope, contactId, invoiceId?, reason? }`; output includes `{ entryId, created, cancelledApprovals, cancelledStages, cancelledMessages, cancelledTasks }`.
- `remove` input: `{ organisationId, entryId }`; output includes `{ removed, recalculationJobId? }`.

- [x] **Step 1: Write failing service integration tests**

  Cover client-wide cancellation, invoice-only cancellation, pending and approved approvals, queued but not provider-accepted messages, open escalation cancellation, repeated add as a no-op, overlapping entries, Administrator-only removal, fresh recalculation publication, and foreign-organisation identifiers.

- [x] **Step 2: Run the service tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/reminder-whitelist.integration.test.ts`

  Expected: FAIL because the service does not exist.

- [x] **Step 3: Implement transactional add, remove, and list operations**

  Use `lockTarget` before inserting/removing or cancelling. Expire `PENDING` and `APPROVED` approvals; cancel only unsent stages/messages and matching `OPEN` tasks; leave accepted/delivered history unchanged. Write correlated audit events with affected counts. Removal publishes `reminders.calculate` with an organisation singleton key.

- [x] **Step 4: Run the service tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/reminder-whitelist.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit the whitelist service**

  Run: `git add apps/web/src/server/reminder-whitelist-service.ts apps/web/tests/reminder-whitelist.integration.test.ts && git commit -m "feat: add reminder whitelist lifecycle"`

### Task 3: Calculation and final-send whitelist enforcement

**Files:**
- Modify: `apps/worker/src/handlers/reminders-calculate.ts`
- Modify: `apps/worker/src/services/pre-send-revalidation.ts`
- Modify: `apps/worker/src/handlers/reminder-execute.ts`
- Modify: `apps/worker/tests/reminders-calculate.integration.test.ts`
- Modify: `apps/worker/tests/reminder-execute.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `PostgresReminderWhitelistRepository` and message claim API.
- Produces: `StopReason` value `REMINDER_WHITELISTED`.
- Produces the invariant that `beginReminder` obtains the target lock and repeats the active-whitelist check in the same transaction as the idempotent send claim.

- [x] **Step 1: Write failing calculator and execution tests**

  Assert client and invoice entries prevent approvals, daily SMS and escalation tasks; overlapping entries remain blocked; pre-send revalidation returns `REMINDER_WHITELISTED`; and a deterministic concurrent add/send test proves a whitelist that wins the lock prevents claim/provider submission.

- [x] **Step 2: Run the worker tests and verify they fail**

  Run: `pnpm vitest run apps/worker/tests/reminders-calculate.integration.test.ts apps/worker/tests/reminder-execute.integration.test.ts`

  Expected: FAIL because eligibility and send claiming do not consult the whitelist.

- [x] **Step 3: Add calculation, revalidation, and atomic-claim checks**

  Filter covered invoices before occurrence creation. Revalidate before rendering and treat the repository's locked claim as authoritative. If the claim reports a new whitelist entry, cancel the stage/approval with `REMINDER_WHITELISTED` and never call Sinch or Xero.

- [x] **Step 4: Run the worker tests and verify they pass**

  Run: `pnpm vitest run apps/worker/tests/reminders-calculate.integration.test.ts apps/worker/tests/reminder-execute.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit worker enforcement**

  Run: `git add apps/worker && git commit -m "feat: enforce reminder whitelist before sends"`

### Task 4: Canonical Outbox records for existing transports

**Files:**
- Modify: `apps/worker/src/handlers/reminder-execute.ts`
- Modify: `apps/worker/src/handlers/operator-reply-execute.ts`
- Modify: `apps/worker/src/services/delivery-service.ts`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/customer-operations.ts`
- Modify: `apps/worker/tests/reminder-execute.integration.test.ts`
- Modify: `apps/worker/tests/operator-reply-execute.integration.test.ts`
- Modify: `apps/web/tests/customer-actions.integration.test.ts`
- Modify: `apps/web/tests/webhooks.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 canonical message repository and stage origin.
- Produces: each automated/manual reminder and Inbox reply has one `outbound_messages` row with source, exact SMS content, associations, actor when applicable, and provider attempts.
- Produces: delivery callbacks update both canonical Outbox state and linked `operator_replies` state transactionally.

- [x] **Step 1: Write failing transport-history tests**

  Assert automated, customer-manual, Xero-email and Inbox-reply sources; exact SMS content; Xero request description; actor/contact/invoice links; one row on repeated jobs; nullable stage delivery handling; and linked Inbox reply callback state.

- [x] **Step 2: Run the focused transport tests and verify they fail**

  Run: `pnpm vitest run apps/worker/tests/reminder-execute.integration.test.ts apps/worker/tests/operator-reply-execute.integration.test.ts apps/web/tests/customer-actions.integration.test.ts apps/web/tests/webhooks.integration.test.ts`

  Expected: FAIL on missing canonical associations and reply linkage.

- [x] **Step 3: Route existing transports through the canonical repository**

  Preserve current reminder stage state transitions. Set manual stage origin/actor when customer operations create the stage. Link Inbox replies to their canonical row. Skip stage updates for stage-less messages and retain the existing unknown-outcome rule.

- [x] **Step 4: Run the focused transport tests and verify they pass**

  Run: `pnpm vitest run apps/worker/tests/reminder-execute.integration.test.ts apps/worker/tests/operator-reply-execute.integration.test.ts apps/web/tests/customer-actions.integration.test.ts apps/web/tests/webhooks.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit canonical transport history**

  Run: `git add apps/worker apps/web/src/app/'(protected)'/customers apps/web/tests && git commit -m "feat: record outgoing activity in Outbox"`

### Task 5: Administrator test-SMS pipeline

**Files:**
- Modify: `packages/jobs/src/names.ts`
- Modify: `packages/jobs/src/payloads.ts`
- Create: `apps/worker/src/handlers/test-sms-execute.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/tests/test-sms-execute.integration.test.ts`
- Create: `apps/web/src/app/(protected)/settings/test-sms/test-sms-service.ts`
- Create: `apps/web/tests/test-sms.integration.test.ts`

**Interfaces:**
- Produces job `test-sms.execute` with `{ organisationId, outboundMessageId }`.
- Produces `createTestSmsService({ database, publisher, clock }).queue(session, { organisationId, destination, content, confirmed, requestId })`.
- Produces `executeTestSms(dependencies, payload)` returning `dry-run | cancelled | sent | rejected | unknown | in-progress`.

- [x] **Step 1: Write failing service, payload, and worker tests**

  Assert Administrator-only access, AU number normalisation, confirmation, segment cap, suppression, technical allowlist dry run, live accepted send, provider rejection, exact content, `TEST_SMS_QUEUED` audit history, repeated request/job idempotency, unknown outcome without retry, and foreign-organisation outbound IDs.

- [x] **Step 2: Run the test-SMS tests and verify they fail**

  Run: `pnpm vitest run packages/jobs/src/queue.integration.test.ts apps/web/tests/test-sms.integration.test.ts apps/worker/tests/test-sms-execute.integration.test.ts`

  Expected: FAIL because the contract and handler do not exist.

- [x] **Step 3: Implement queued test SMS and worker registration**

  The web service writes a `QUEUED` `TEST_SMS` Outbox record before publishing. The worker atomically claims it, rechecks suppression and organisation sending controls, records one attempt, and calls Sinch only when live sending is allowed.

- [x] **Step 4: Run the test-SMS tests and verify they pass**

  Run: `pnpm vitest run packages/jobs/src/queue.integration.test.ts apps/web/tests/test-sms.integration.test.ts apps/worker/tests/test-sms-execute.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit the test-SMS pipeline**

  Run: `git add packages/jobs apps/worker apps/web/src/app/'(protected)'/settings/test-sms apps/web/tests/test-sms.integration.test.ts && git commit -m "feat: add safe test SMS pipeline"`

### Task 6: Outbox query and page

**Files:**
- Create: `apps/web/src/app/(protected)/outbox/outbox-query.ts`
- Create: `apps/web/src/app/(protected)/outbox/page.tsx`
- Create: `apps/web/src/components/outbox-table.tsx`
- Modify: `apps/web/src/components/app-shell.tsx`
- Modify: `apps/web/src/app/globals.css`
- Create: `apps/web/tests/outbox.integration.test.ts`
- Modify: `apps/web/tests/app-shell.test.tsx`

**Interfaces:**
- Consumes: Task 1 canonical Outbox fields.
- Produces: `queryOutbox(database, { organisationId, search?, channel?, source?, status?, from?, to?, cursor?, limit })` returning `{ rows, nextCursor }`.
- Produces `/outbox` and primary navigation item immediately after Inbox.

- [x] **Step 1: Read the bundled Next.js App Router and server-component guides relevant to search parameters and links**

  Run: `rg -n "searchParams|Server Component|Link" node_modules/next/dist/docs -g '*.md'`

  Expected: identify and read the exact installed-version guidance before page code is written.

- [x] **Step 2: Write failing query and navigation tests**

  Assert organisation isolation, source/channel/status/date filters, client/invoice/recipient search, stable cursor pagination, historical null-content fallback, Xero body disclaimer, foreign identifiers not leaking, and Outbox placement after Inbox.

- [x] **Step 3: Run the Outbox tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/outbox.integration.test.ts apps/web/tests/app-shell.test.tsx`

  Expected: FAIL because the query, page and navigation item do not exist.

- [x] **Step 4: Implement the query, page, table, filters, and AccountPulse styling**

  Render newest first; include recipient, linked client/invoice, source, actor, timestamps, provider result and safe content. Use created-time plus ID cursor semantics and preserve active filters in pagination links.

- [x] **Step 5: Run the Outbox tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/outbox.integration.test.ts apps/web/tests/app-shell.test.tsx`

  Expected: PASS.

- [x] **Step 6: Commit the Outbox UI**

  Run: `git add apps/web && git commit -m "feat: add unified Outbox"`

### Task 7: Reminder Whitelist settings and approval controls

**Files:**
- Create: `apps/web/src/components/reminder-whitelist-controls.tsx`
- Create: `apps/web/src/app/(protected)/settings/reminder-whitelist/page.tsx`
- Create: `apps/web/src/app/(protected)/settings/reminder-whitelist/actions.ts`
- Modify: `apps/web/src/app/(protected)/settings/page.tsx`
- Modify: `apps/web/src/app/(protected)/approvals/page.tsx`
- Modify: `apps/web/src/components/approval-table.tsx`
- Modify: `apps/web/src/app/(protected)/approvals/actions.ts`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/tests/approvals.integration.test.ts`
- Create: `apps/web/tests/reminder-whitelist-ui.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 service.
- Produces server actions `addApprovalTargetToWhitelist(formData)`, `addWhitelistEntry(formData)`, and `removeWhitelistEntry(formData)`.
- Produces reusable controls whose confirmation copy says that current and future reminders will stop immediately.

- [x] **Step 1: Write failing permission, action, and page-model tests**

  Assert approval rows include contact/invoice IDs and links; both stop-reminder scopes require confirmation and accept an optional reason; Operators can add; only Administrators can access/remove in Settings; client and invoice lists are separate and searchable; reason/actor/date are shown; overlapping entries are separately listed; and foreign IDs are rejected.

- [x] **Step 2: Run the whitelist UI tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/approvals.integration.test.ts apps/web/tests/reminder-whitelist-ui.integration.test.ts`

  Expected: FAIL because the actions and settings page do not exist.

- [x] **Step 3: Implement approval controls and Administrator settings management**

  Revalidate Approvals, Escalations, client/invoice pages, Outbox, and whitelist Settings after mutations. Label actions **Stop reminders for invoice/client**; reserve **Reminder Whitelist** for the management page.

- [x] **Step 4: Run the whitelist UI tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/approvals.integration.test.ts apps/web/tests/reminder-whitelist-ui.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit whitelist UI controls**

  Run: `git add apps/web && git commit -m "feat: add reminder whitelist controls"`

### Task 8: Invoice detail and consistent record links

**Files:**
- Create: `apps/web/src/app/(protected)/invoices/[invoiceId]/page.tsx`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/page.tsx`
- Modify: `apps/web/src/app/(protected)/escalations/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Create: `apps/web/tests/invoice-details.integration.test.ts`

**Interfaces:**
- Consumes: canonical Outbox and active whitelist fields.
- Produces `/invoices/[invoiceId]`, showing only stored Xero fields, related outgoing history, whitelist/chase state, client link, and optional online-invoice link.

- [x] **Step 1: Write failing invoice-page tests**

  Assert accurate stored fields, no fabricated line items, optional Xero link, message history, whitelist state, client link, organisation isolation, and not-found behaviour for foreign/unknown IDs.

- [x] **Step 2: Run the invoice tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/invoice-details.integration.test.ts`

  Expected: FAIL because the route does not exist.

- [x] **Step 3: Implement invoice details and add invoice links to customer/escalation surfaces**

  Reuse the AccountPulse page/card styling and money/date formatters. Keep existing customer links and make invoice numbers clickable wherever the page has the required ID.

- [x] **Step 4: Run the invoice tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/invoice-details.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit linked invoice details**

  Run: `git add apps/web && git commit -m "feat: add linked invoice details"`

### Task 9: Escalation call and manual-SMS actions

**Files:**
- Create: `apps/web/src/server/manual-reminder-service.ts`
- Create: `apps/web/src/components/call-client-button.tsx`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/customer-operations.ts`
- Modify: `apps/web/src/app/(protected)/escalations/escalation-service.ts`
- Modify: `apps/web/src/app/(protected)/escalations/actions.ts`
- Modify: `apps/web/src/app/(protected)/escalations/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/tests/customer-actions.integration.test.ts`
- Modify: `apps/web/tests/escalations.integration.test.ts`

**Interfaces:**
- Produces `createManualReminderService({ database, publisher, clock }).queue(session, { organisationId, customerId, invoiceId, channel, message?, confirmed, requestId, origin })`.
- `origin` is `CUSTOMER_PAGE | ESCALATION`; it maps to `MANUAL_REMINDER | ESCALATION_SMS` stage/Outbox source.
- Produces escalation actions `sendEscalationSms(formData)` and `recordCallLinkOpened(formData)`.

- [x] **Step 1: Write failing shared-service and escalation tests**

  Assert escalation SMS is editable and confirmed, contains the current payment link, obeys whitelist/suppression/segment/live controls, queues idempotently with `ESCALATION_SMS`, records `ESCALATION_SMS_QUEUED`, and rejects stale or foreign invoices. Assert the call action requires a usable phone, authorises `chase.operate`, records `CALL_LINK_OPENED`, and returns a normalised `tel:` target without claiming call completion.

- [x] **Step 2: Run the escalation tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/customer-actions.integration.test.ts apps/web/tests/escalations.integration.test.ts`

  Expected: FAIL because shared manual service and escalation actions do not exist.

- [x] **Step 3: Extract the existing customer manual-send rules and add escalation controls**

  Keep customer behaviour unchanged while delegating both surfaces to the shared service. Add View client, View invoice, Call client, Send SMS, and both stop-reminders controls to each escalation card with clear unavailable reasons. The call component durably records the launch intent before assigning the browser to the returned `tel:` target; it never labels that event as a completed call.

- [x] **Step 4: Run the escalation tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/customer-actions.integration.test.ts apps/web/tests/escalations.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit escalation operations**

  Run: `git add apps/web && git commit -m "feat: add escalation contact actions"`

### Task 10: Test SMS settings interface

**Files:**
- Create: `apps/web/src/app/(protected)/settings/test-sms/page.tsx`
- Create: `apps/web/src/app/(protected)/settings/test-sms/actions.ts`
- Create: `apps/web/src/components/test-sms-form.tsx`
- Modify: `apps/web/src/app/(protected)/settings/page.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `apps/web/tests/test-sms.integration.test.ts`

**Interfaces:**
- Consumes: Task 5 `createTestSmsService`.
- Produces `queueTestSms(formData)` and an Administrator-only form with phone, editable content, encoding/segment preview, confirmation, and queued result guidance.

- [x] **Step 1: Write failing page/action tests**

  Assert Administrator-only rendering, required confirmation, stable page-generated request ID, segment preview, validation feedback, successful queueing, dry-run explanation, and no secret/provider credentials in rendered output.

- [x] **Step 2: Run the test-SMS web tests and verify they fail**

  Run: `pnpm vitest run apps/web/tests/test-sms.integration.test.ts`

  Expected: FAIL because the page, form and action do not exist.

- [x] **Step 3: Implement the Settings card, form, action, and result copy**

  Generate the idempotency request ID once per rendered form and submit it unchanged on repeated clicks. Explain that non-allowlisted recipients become dry runs and direct the user to Outbox for final provider status.

- [x] **Step 4: Run the test-SMS web tests and verify they pass**

  Run: `pnpm vitest run apps/web/tests/test-sms.integration.test.ts`

  Expected: PASS.

- [x] **Step 5: Commit the Test SMS settings UI**

  Run: `git add apps/web && git commit -m "feat: add Test SMS settings"`

### Task 11: Whole-feature verification and release readiness

**Files:**
- Modify as required by verification findings only; do not add unrelated scope.
- Update: `docs/superpowers/plans/2026-09-28-accountpulse-operations.md` checkboxes as tasks complete.

**Interfaces:**
- Consumes every prior task.
- Produces a clean branch ready for review, push, and the existing deployment pipeline.

- [x] **Step 1: Run formatting and static verification**

  Run: `pnpm lint && pnpm typecheck`

  Expected: PASS with no warnings promoted to errors.

- [x] **Step 2: Run all automated tests**

  Run: `pnpm test`

  Expected: all unit and integration tests pass; count is greater than the 264-test baseline.

- [x] **Step 3: Build every package and application**

  Run: `pnpm build`

  Expected: PASS, including the Next.js production build and worker packages.

- [x] **Step 4: Inspect the migration and branch diff**

  Run: `git diff origin/main...HEAD --check && git status --short && git log --oneline origin/main..HEAD`

  Expected: no whitespace errors, no unexpected generated/secrets files, and only approved feature changes.

- [x] **Step 5: Run the required whole-branch review**

  Use `superpowers:requesting-code-review`, resolve findings with test-first changes, and rerun affected verification.

- [x] **Step 6: Commit any verification fixes**

  Run: `git add <reviewed-files> && git commit -m "fix: address AccountPulse operations review"`

- [x] **Step 7: Stop for explicit push/deployment approval if it has not already been given for the completed branch**

  Production smoke checks must use an approved technical allowlist destination and cover login, Outbox, whitelist add/remove, one Test SMS, one escalation SMS, callback status, and duplicate prevention.
