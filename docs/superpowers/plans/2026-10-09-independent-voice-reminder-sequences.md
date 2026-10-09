# Independent Voice Reminder Sequences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently managed Voice Reminder sequences and an obvious customer-level automated-call action while guaranteeing one consolidated, auditable call per customer occurrence.

**Architecture:** Existing reminder sequences gain a `MESSAGING` or `VOICE` kind, while voice-call requests gain immutable sequence-source metadata and remain the approval record for customer-level calls. A shared preparation service is consumed by the web action and the worker; separate calculation and dispatch jobs group invoices, revalidate facts, and submit at most one call per organisation after the configured cooldown.

**Tech Stack:** TypeScript 6, Next.js 16 server components/actions, React 19, PostgreSQL, Drizzle ORM/Kit, pg-boss, Vitest, Asterisk/ARI, VoIPcloud, Docker Compose on OVH.

**Spec:** `docs/superpowers/specs/2026-10-09-independent-voice-reminder-sequences-design.md`

## Global Constraints

- Existing production sequences migrate to `MESSAGING`; existing voice calls migrate to `MANUAL`.
- A sequence version may contain messaging actions or voice actions, never both.
- A voice occurrence produces at most one call per organisation, version, stage, customer, local date and currency.
- Automatic voice remains disabled by default and is never enabled by a migration or deployment.
- Customer voice acceptance remains off during construction and deployment.
- Existing SMS/email state must remain `live | CUSTOMER`; no task may lower it or enter dry-run mode.
- One organisation may have only one submitted voice call at a time; uncertain provider outcomes are never retried blindly.
- AccountPulse never receives or stores card details; the future Stripe option-3 upgrade is out of scope.
- Do not stage or modify the unrelated `.release/` or `.tmp/` directories.

## Review Focus

- Concurrent calculation runs for several invoices belonging to one customer must converge on one voice request; Task 5 adds the concurrency/idempotency test.
- Approval followed by payment, pause, dispute, suppression or invoice-value change must prevent the stale call; Task 6 adds fresh-facts tests.
- Disabling a Voice sequence or automatic voice after calls are prepared must prevent dispatch without affecting Messaging; Task 7 adds both assertions.
- A delayed terminal event or `UNKNOWN` provider state must keep later batch calls from starting; Task 7 adds the in-flight/uncertain-outcome test.
- Sydney DST, closed windows, non-business days and cooldown boundaries must schedule the next valid instant; Tasks 2 and 7 add literal timestamp tests.

---

### Task 1: Safe schema and migration

**Files:**
- Modify: `packages/db/src/schema/reminders.ts`
- Modify: `packages/db/src/schema/voice.ts`
- Modify: `packages/db/src/schema/schema.integration.test.ts`
- Create: `packages/db/drizzle/0011_independent_voice_sequences.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/drizzle/meta/0011_snapshot.json`

**Interfaces:**
- Produces: `SequenceKind = 'MESSAGING' | 'VOICE'` on `reminderSequences.kind`.
- Produces: `VoiceCallSource = 'MANUAL' | 'SEQUENCE_REVIEW' | 'SEQUENCE_AUTOMATIC'` on `voiceCallRequests.source`.
- Produces: nullable `sequenceId`, `sequenceVersionId`, `stageKey`, `scheduledAt`, and `localOccurrenceDate` call-source metadata.
- Produces: `organisationVoiceSettings.automaticEnabled: boolean` defaulting to `false`.

- [ ] **Step 1: Write failing schema integration tests**

Add tests named `defaults existing-compatible records to messaging, manual and automatic voice off` and `round-trips an auditable scheduled voice call source`. Assert exact default values and all sequence metadata, and assert the database rejects a scheduled source missing its sequence/version/stage/date fields.

- [ ] **Step 2: Run the schema tests and verify RED**

Run: `pnpm exec vitest run packages/db/src/schema/schema.integration.test.ts`

Expected: FAIL because the new columns and exported types do not exist.

- [ ] **Step 3: Add the typed columns, checks, foreign keys and indexes**

Add a check restricting sequence kind, a check restricting call source, and a check requiring the full sequence metadata tuple only for sequence sources. Index due sequence calls by organisation, state and scheduled time. Preserve all existing defaults.

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm db:generate`

Expected: a migration that backfills safe defaults, makes the three discriminator fields non-null, adds constraints/indexes, and does not update live-send or rollout fields.

- [ ] **Step 5: Run the schema tests and verify GREEN**

Run: `pnpm exec vitest run packages/db/src/schema/schema.integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add packages/db && git commit -m "feat: add independent voice sequence schema"`

### Task 2: Voice sequence domain rules and customer grouping

**Files:**
- Modify: `packages/domain/src/reminders.ts`
- Modify: `packages/domain/src/reminders.test.ts`
- Create: `packages/domain/src/voice-sequences.ts`
- Create: `packages/domain/src/voice-sequences.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces: `ReminderStageChannel` including `VOICE`.
- Produces: `groupVoiceSequenceCandidates(input: VoiceSequenceGroupingInput): VoiceSequenceCandidate[]`.
- Produces: `voiceSequenceIdempotencyKey(candidate: VoiceSequenceCandidate): string` containing organisation, version, stage, customer, local date and currency.
- Produces: `nextVoiceDispatchAt(input: VoiceDispatchWindowInput): Date` for Sydney window/cooldown calculations.

- [ ] **Step 1: Write failing pure-domain tests**

Cover two invoices for one customer becoming one candidate, two customers becoming two candidates, duplicate invoices appearing once, AUD and NZD remaining separate, deterministic input ordering, the literal Sydney DST conversion `2026-10-04 09:00 -> 2026-10-03T22:00:00.000Z`, and the next weekday/cooldown boundary.

- [ ] **Step 2: Run the domain tests and verify RED**

Run: `pnpm exec vitest run packages/domain/src/reminders.test.ts packages/domain/src/voice-sequences.test.ts`

Expected: FAIL because `VOICE` and the grouping/scheduling functions do not exist.

- [ ] **Step 3: Implement the minimal pure functions and types**

Use stable sorting and a map keyed by the exact idempotency dimensions. Keep provider, database and UI concerns out of this module.

- [ ] **Step 4: Run the domain tests and verify GREEN**

Run: `pnpm exec vitest run packages/domain/src/reminders.test.ts packages/domain/src/voice-sequences.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add packages/domain && git commit -m "feat: model customer-level voice sequence occurrences"`

### Task 3: Shared voice preparation service

**Files:**
- Create: `packages/db/src/services/voice-call-preparation.ts`
- Create: `packages/db/src/services/voice-call-preparation.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/web.ts`
- Modify: `packages/db/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-call-service.ts`
- Modify: `apps/web/tests/voice-call-service.integration.test.ts`

**Interfaces:**
- Produces: `createVoicePreparationService(dependencies): VoicePreparationService`.
- Produces: `VoicePreparationService.evaluate(input: VoicePreparationInput): Promise<VoiceCallDraftView>`.
- Produces: `VoicePreparationService.create(input: VoicePreparationInput): Promise<VoiceCallDraftView>` with source metadata and a caller-supplied initial state of `DRAFT` or `APPROVED`.
- Consumes: existing `PostgresVoiceCallRepository`, policy rules and immutable invoice snapshot model.

- [ ] **Step 1: Write failing integration tests for the shared boundary**

Prove that manual and sequence inputs produce the same eligibility decision and facts hash; prove a sequence call stores every invoice once and exact source metadata; prove invalid phone, suppression, whitelist, dispute, promise and stale organisation state return the established block codes.

- [ ] **Step 2: Run the new and existing service tests and verify RED**

Run: `pnpm exec vitest run packages/db/src/services/voice-call-preparation.integration.test.ts apps/web/tests/voice-call-service.integration.test.ts`

Expected: FAIL because the shared service does not exist.

- [ ] **Step 3: Extract preparation without changing manual behaviour**

Move database gathering, phone normalisation, policy evaluation, snapshot construction and hashing behind the shared service. Keep authorisation, redirects and job publication in the web layer. Add `libphonenumber-js` to `@bc5000/db` rather than duplicating normalisation.

- [ ] **Step 4: Run the service tests and verify GREEN**

Run: `pnpm exec vitest run packages/db/src/services/voice-call-preparation.integration.test.ts apps/web/tests/voice-call-service.integration.test.ts`

Expected: PASS with the current manual call contract unchanged.

- [ ] **Step 5: Commit**

Run: `git add packages/db apps/web/src/app/'(protected)'/customers/'[customerId]'/voice apps/web/tests/voice-call-service.integration.test.ts pnpm-lock.yaml && git commit -m "refactor: share voice call preparation"`

### Task 4: Independent sequence administration and two-tab UI

**Files:**
- Modify: `apps/web/src/app/(protected)/sequences/sequence-service.ts`
- Modify: `apps/web/src/app/(protected)/sequences/actions.ts`
- Modify: `apps/web/src/app/(protected)/sequences/page.tsx`
- Modify: `apps/web/src/app/(protected)/sequences/[sequenceId]/page.tsx`
- Modify: `apps/web/src/components/sequence-editor.tsx`
- Create: `apps/web/src/components/sequence-tabs.tsx`
- Modify: `apps/web/tests/sequences.integration.test.ts`
- Create: `apps/web/tests/sequence-tabs-view.test.tsx`
- Modify: `apps/web/e2e/automatic-sequence.spec.ts`

**Interfaces:**
- Produces: `SequenceDraft.kind: SequenceKind` and voice-only `maxCallsPerRun`, `cooldownSeconds` configuration.
- Produces: `createStandardVoiceSequence(session, { organisationId })`.
- Produces: `/sequences?tab=messaging|voice`, defaulting to `messaging`.

- [ ] **Step 1: Write failing service and view tests**

Assert Messaging and Voice rows appear only on their tab; Xero email/task remain Messaging; a Voice draft accepts only `VOICE`; a Messaging draft rejects `VOICE`; `maxCallsPerRun` and `cooldownSeconds` enforce conservative positive ranges; and enabling/disabling one kind does not change the other.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run apps/web/tests/sequences.integration.test.ts apps/web/tests/sequence-tabs-view.test.tsx`

Expected: FAIL because kind-aware services and tabs do not exist.

- [ ] **Step 3: Implement kind-aware service, actions, tabs and editors**

Use the existing immutable-version flow. Present the existing channel editor for Messaging and an overdue-stage/capacity editor for Voice. Preserve query tab selection when linking to details and back.

- [ ] **Step 4: Run unit/integration and browser-flow tests**

Run: `pnpm exec vitest run apps/web/tests/sequences.integration.test.ts apps/web/tests/sequence-tabs-view.test.tsx && pnpm --filter @bc5000/web test:e2e -- automatic-sequence.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web && git commit -m "feat: separate messaging and voice sequences"`

### Task 5: Customer-level voice calculation and idempotent preparation

**Files:**
- Create: `apps/worker/src/handlers/voice-reminders-calculate.ts`
- Create: `apps/worker/tests/voice-reminders-calculate.integration.test.ts`
- Modify: `packages/db/src/repositories/task-repository.ts`
- Modify: `packages/db/src/repositories/task-repository.integration.test.ts`
- Modify: `packages/jobs/src/names.ts`
- Modify: `packages/jobs/src/payloads.ts`
- Modify: `packages/jobs/src/schedules.ts`
- Modify: `packages/jobs/src/administration.ts`
- Modify: `packages/jobs/src/voice-call-payloads.test.ts`
- Modify: `packages/jobs/src/administration.integration.test.ts`
- Modify: `apps/worker/src/entrypoint.ts`

**Interfaces:**
- Produces: `jobNames.voiceRemindersCalculate = 'voice-reminders.calculate'` scheduled every five minutes.
- Produces: `calculateVoiceReminderWork(dependencies, organisationId): Promise<VoiceCalculationSummary>`.
- Consumes: `groupVoiceSequenceCandidates`, `voiceSequenceIdempotencyKey`, and `VoicePreparationService.create`.

- [ ] **Step 1: Write failing calculation and job-contract tests**

Seed concurrent runs with several due invoices for one customer and assert one request with all invoice snapshots; assert Review creates `DRAFT`, Automatic creates `APPROVED`, recalculation is idempotent, different customers remain separate, disabled/retired Voice sequences create nothing, missing or invalid phone data creates one deduplicated `VOICE_CONTACT_REVIEW` task, and Messaging calculation results are unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run apps/worker/tests/voice-reminders-calculate.integration.test.ts packages/jobs/src/voice-call-payloads.test.ts packages/jobs/src/administration.integration.test.ts`

Expected: FAIL because the job and calculator do not exist.

- [ ] **Step 3: Implement calculation and register the recurring job**

Use a database transaction plus the deterministic unique idempotency key for concurrency. Do not publish provider work from calculation. Create or refresh a deduplicated `VOICE_CONTACT_REVIEW` task for a customer whose otherwise eligible occurrence cannot be called because its phone data is missing or invalid. Record safe audit events with counts and identifiers only.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm exec vitest run apps/worker/tests/voice-reminders-calculate.integration.test.ts packages/db/src/repositories/task-repository.integration.test.ts packages/jobs/src/voice-call-payloads.test.ts packages/jobs/src/administration.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/worker packages/jobs && git commit -m "feat: calculate consolidated voice sequence calls"`

### Task 6: Voice approvals and pre-call freshness

**Files:**
- Create: `apps/web/src/app/(protected)/approvals/voice-approval-service.ts`
- Modify: `apps/web/src/app/(protected)/approvals/approval-service.ts`
- Modify: `apps/web/src/app/(protected)/approvals/actions.ts`
- Modify: `apps/web/src/app/(protected)/approvals/page.tsx`
- Modify: `apps/web/src/components/approval-table.tsx`
- Modify: `apps/web/tests/approvals.integration.test.ts`
- Modify: `apps/worker/src/handlers/voice-call-execute.ts`
- Modify: `apps/worker/tests/voice-call-execute.integration.test.ts`

**Interfaces:**
- Produces: `createVoiceApprovalService(dependencies)` with `approve`, `reject`, and `bulkApprove` methods operating on sequence `voiceCallRequests`.
- Produces: a discriminated approval-row view with `kind: 'MESSAGE' | 'VOICE'`.
- Consumes: shared preparation for approval and execution-time facts validation.

- [ ] **Step 1: Write failing approval and freshness tests**

Assert one Voice row lists every included invoice and combined total; approval transitions `DRAFT -> APPROVED` without immediate provider submission; rejection transitions to `CANCELLED`; bulk decisions isolate stale rows; and payment, amount change, pause, dispute, suppression or whitelist after approval prevents execution.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run apps/web/tests/approvals.integration.test.ts apps/worker/tests/voice-call-execute.integration.test.ts`

Expected: FAIL because Voice approvals are not represented and sequence calls currently use the manual queue path.

- [ ] **Step 3: Implement Voice approvals and shared pre-call revalidation**

Keep message approvals unchanged. Scheduled approvals store actor/time and wait in `APPROVED`. Expire stale facts rather than silently rebuilding an already approved call.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm exec vitest run apps/web/tests/approvals.integration.test.ts apps/worker/tests/voice-call-execute.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web apps/worker && git commit -m "feat: review scheduled voice reminders"`

### Task 7: Throttled voice dispatcher and independent activation

**Files:**
- Create: `apps/worker/src/handlers/voice-reminders-dispatch.ts`
- Create: `apps/worker/tests/voice-reminders-dispatch.integration.test.ts`
- Modify: `packages/jobs/src/names.ts`
- Modify: `packages/jobs/src/payloads.ts`
- Modify: `packages/jobs/src/schedules.ts`
- Modify: `packages/jobs/src/administration.ts`
- Modify: `apps/worker/src/entrypoint.ts`
- Modify: `packages/db/src/repositories/voice-call-repository.ts`
- Modify: `packages/db/src/repositories/voice-call-repository.integration.test.ts`
- Modify: `deploy/ovh/docker-compose.yml`

**Interfaces:**
- Produces: `jobNames.voiceRemindersDispatch = 'voice-reminders.dispatch'` scheduled every minute.
- Produces: `dispatchDueVoiceReminders(dependencies, organisationId): Promise<VoiceDispatchSummary>`.
- Produces: `PostgresVoiceCallRepository.queueApprovedScheduledCall(...)` as an atomic `APPROVED -> QUEUED` transition.
- Consumes: worker `acceptCustomerVoiceCalls` configuration, `automaticEnabled`, sequence enabled/version status, capacity and cooldown settings.

- [ ] **Step 1: Write failing dispatcher tests**

Assert only the oldest due eligible call is published; a second call waits for terminal state plus cooldown; `UNKNOWN` and active calls block the batch; disabled sequence/version, automatic gate, deployment gate, run cap and closed window prevent submission; the next Sydney business-window instant is exact; and none of these paths changes Messaging stage states or organisation live-send fields.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run apps/worker/tests/voice-reminders-dispatch.integration.test.ts packages/db/src/repositories/voice-call-repository.integration.test.ts`

Expected: FAIL because dispatcher and atomic queue transition do not exist.

- [ ] **Step 3: Implement the locked, one-at-a-time dispatcher**

Acquire an organisation-scoped advisory transaction lock, re-read all gates under lock, atomically queue one call, then publish `voice-call.execute` after commit. If publication is uncertain, leave the request reconcilable rather than selecting another customer.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm exec vitest run apps/worker/tests/voice-reminders-dispatch.integration.test.ts packages/db/src/repositories/voice-call-repository.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/worker packages/jobs packages/db deploy/ovh/docker-compose.yml && git commit -m "feat: throttle automatic voice reminder dispatch"`

### Task 8: Automatic-voice control and customer call button

**Files:**
- Modify: `apps/web/src/app/(protected)/settings/voice/voice-settings.ts`
- Modify: `apps/web/src/app/(protected)/settings/voice/voice-settings-form.tsx`
- Modify: `apps/web/src/app/(protected)/settings/voice/actions.ts`
- Modify: `apps/web/tests/voice-settings.integration.test.ts`
- Modify: `apps/web/tests/voice-settings-view.test.tsx`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-reminder-panel.tsx`
- Modify: `apps/web/tests/voice-reminder-view.test.tsx`
- Modify: `apps/web/e2e/voice-reminder.spec.ts`

**Interfaces:**
- Produces: `setAutomaticVoiceCalls(session, { organisationId, enabled, confirmation })` requiring Admin and exact confirmation `ENABLE AUTOMATIC VOICE CALLS` when enabling.
- Produces: customer CTA label **Make automated call** using the existing review-and-confirm action.

- [ ] **Step 1: Write failing permissions, view and audit tests**

Assert Operator cannot enable automation; wrong confirmation is rejected; disable needs no activation phrase; enable/disable emits audit events; deployment defaults render Automatic Voice off; and the customer page offers exactly one **Make automated call** action followed by the immutable review.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts apps/web/tests/voice-settings-view.test.tsx apps/web/tests/voice-reminder-view.test.tsx`

Expected: FAIL because the independent control and new CTA do not exist.

- [ ] **Step 3: Implement the setting and button copy**

Keep manual voice enablement independent. Revalidate Settings, Sequences and Approvals after an automatic-mode change.

- [ ] **Step 4: Run unit/integration and browser-flow tests**

Run: `pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts apps/web/tests/voice-settings-view.test.tsx apps/web/tests/voice-reminder-view.test.tsx && pnpm --filter @bc5000/web test:e2e -- voice-reminder.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web && git commit -m "feat: control automatic voice reminders independently"`

### Task 9: Operational visibility, deployment and proof

**Files:**
- Modify: `packages/db/src/repositories/activity-repository.ts`
- Modify: `packages/db/src/repositories/activity-repository.integration.test.ts`
- Modify: `apps/web/tests/voice-customer-timeline.test.tsx`
- Modify: `apps/worker/tests/ovh-deployment.test.ts`
- Modify: `docs/runbooks/voipcloud-capability-test.md`

**Interfaces:**
- Produces: customer activity labels that identify Manual, Sequence review and Sequence automatic call sources without private provider content.
- Produces: a runbook for a fictional, staff-number sequence batch with automatic customer voice still disabled.

- [ ] **Step 1: Write failing activity and deployment tests**

Assert scheduled call history shows sequence/stage/source and all invoice links; contact-review tasks are presented without exposing private provider content; resolved configuration keeps `VOICE_GATEWAY_ACCEPT_CALLS=false`; and no migration or Compose default enables `automaticEnabled`.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm exec vitest run packages/db/src/repositories/activity-repository.integration.test.ts apps/web/tests/voice-customer-timeline.test.tsx apps/worker/tests/ovh-deployment.test.ts`

Expected: FAIL for missing source visibility and new deployment assertions.

- [ ] **Step 3: Implement safe activity presentation and update the runbook**

Document preparation, migration, staff-number override, one-call-at-a-time proof, rollback, and the prohibition on enabling customer voice during deployment.

- [ ] **Step 4: Run the targeted tests and full verification**

Run: `pnpm exec vitest run packages/db/src/repositories/activity-repository.integration.test.ts apps/web/tests/voice-customer-timeline.test.tsx apps/worker/tests/ovh-deployment.test.ts`

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: all commands exit 0. Report any pre-existing or environmental failure by exact test name rather than hiding it.

- [ ] **Step 5: Deploy with both customer voice gates off**

Apply migration backup/restore procedures, deploy the web/worker/voice images, and verify:

- `send_mode=live`, `rollout_scope=CUSTOMER`, `live_send_acknowledged=true`;
- `VOICE_GATEWAY_ACCEPT_CALLS=false`;
- `organisation_voice_settings.automatic_enabled=false`;
- Asterisk and voice gateway healthy;
- zero active voice channels; and
- current SMS/email queue processing remains healthy.

- [ ] **Step 6: Run the controlled staff-number batch**

Temporarily allow only the approved staff-number test, use fictional invoice facts, verify consolidation and cooldown, then immediately restore `VOICE_GATEWAY_ACCEPT_CALLS=false`. Do not enable customer automatic voice.

- [ ] **Step 7: Commit and push the verified branch**

Run: `git add packages/db apps/web apps/worker docs/runbooks && git commit -m "docs: verify independent voice sequence rollout"`

Run: `git push origin codex/voipline-voice-reminders`

Expected: the remote branch matches local HEAD and production retains Customer-live messaging with customer voice disabled.
