# AccountPulse Voice Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, privacy-safe AccountPulse voice-reminder workflow that combines a customer's eligible overdue invoices, uses one locked generic Retell call flow, reads approved invoice details after option 1, transfers to a representative after option 2, and records a safe operational audit trail.

**Architecture:** The web app prepares immutable invoice snapshots and records an operator's approved call intent; it never places the phone call directly. A worker revalidates every safeguard, claims the request idempotently, and calls a provider-neutral Retell adapter, while signed Retell webhooks and reconciliation move the internal state machine forward. Retell supplies the AI conversation flow and VoIPline supplies the verified outbound identity, SIP transport, and office transfer destination.

**Tech Stack:** Node.js `>=24 <25`, pnpm `10.20.0`, TypeScript, Next.js `16.3.6`, React `19.3.0`, PostgreSQL, Drizzle ORM `0.45.2`, Vitest `4.1.2`, Playwright `1.55.1`, AWS CDK `2.259.0`, Retell AI, VoIPline SIP, Luxon.

**Spec:** `docs/superpowers/specs/2026-10-06-accountpulse-voice-reminders-design.md`

## Global Constraints

- Keep the existing AccountPulse Customer Live state, `send_mode`, `live_send_acknowledged`, rollout scope, SMS, email, Xero sync, and Inbox behaviour unchanged.
- Voice calling has its own organisation-level feature switch, defaults to disabled, and cannot be enabled until provider configuration passes the controlled release checks.
- Version 1 is manual and single-call only: no bulk calls, automatic sequence calls, automatic retries, or automatic redials.
- One call combines all and only the customer's currently eligible overdue invoices; financial facts come from the stored Xero snapshot and are revalidated immediately before provider submission.
- Retell is the voice/call-orchestration provider; VoIPline remains the SIP carrier, verified caller identity, office queue/ring group, and fallback office number.
- Require explicit operator approval of the destination and exact account facts before queueing a call; do not generate or edit a customer-specific script.
- Every call uses the same pinned generic opening. Option 1 explicitly confirms that the recipient is the account holder or authorised representative before Retell reads invoice numbers and amounts.
- Option 2 warm-transfers at the opening or after the details and must never disclose account facts before office staff perform their normal identity checks.
- Voicemail is generic and must not contain a customer name, balance, invoice number, payment link, or statement that money is owed.
- Do not persist customer audio or conversational transcripts; persist only the pinned call-flow version/hash, approved immutable invoice snapshot, safe structured milestones, identifiers, outcomes, and audit metadata.
- Calling is permitted only Monday-Friday from `09:00` through `17:00` in the organisation's IANA timezone and is blocked on national and configured public holidays.
- Enforce no more than three provider-accepted attempts in a rolling seven-day period and ten in a rolling calendar month.
- Identity, destination, suppression, dispute, promise, pause, whitelist, calling-window, frequency, permission, freshness, and duplicate-call checks are non-bypassable.
- Accept voice destinations only after E.164 normalisation and voice-callable classification.
- Store private Retell credentials only in AWS Secrets Manager and expose only a domain-restricted Retell public preview key to the browser.
- Use the repository's established organisation-scoped database, audit, background-job, server-action, integration-adapter, and test patterns.
- Follow test-driven development. Every task begins with a failing test and ends with focused verification and a commit.

## Review Focus

1. Two concurrent or repeated confirmations for the same idempotency key must produce exactly one Retell call.
2. Any material invoice, customer, contact, safeguard, call-flow version, or voice-setting change after fact approval must cancel before dialling as `STALE_ACCOUNT_DATA` or the specific blocking code.
3. Duplicate and out-of-order Retell events must be idempotent and must never regress a terminal call state.
4. Daylight-saving changes, public holidays, rolling-seven-day boundaries, and calendar-month boundaries must calculate the correct next permitted call time.
5. Opening option 2, wrong-person, no-response, and voicemail paths must disclose no financial information; wrong-person must immediately suppress that destination and create a review task.

---

## File map

### Domain and authorisation

- Create `packages/domain/src/voice-calls.ts` for voice draft facts, protected Retell detail variables, policy decisions, states, and transition rules.
- Create `packages/domain/src/voice-calls.test.ts` for pure policy and state-machine tests.
- Modify `packages/domain/src/index.ts` to export voice types and functions.
- Modify `packages/auth/src/authorise.ts` and `packages/auth/src/authorise.test.ts` for explicit voice permissions.

### Persistence and jobs

- Create `packages/db/src/schema/voice.ts` for settings, calls, snapshots, and events.
- Create `packages/db/src/repositories/voice-call-repository.ts` and integration tests.
- Modify existing schemas to add `VOICE`, `RETELL`, and voice task kinds.
- Create `packages/db/drizzle/0007_accountpulse_voice_calls.sql` plus the matching Drizzle journal/snapshot changes.
- Modify `packages/jobs/src/names.ts` and `packages/jobs/src/payloads.ts` for execution and reconciliation jobs.

### Retell integration

- Create `packages/integrations/src/retell/types.ts`, `client.ts`, `webhook.ts`, `index.ts` and focused tests.
- Modify `packages/integrations/package.json` to export `./retell`.

### Web

- Create the settings service, actions, page, and form under `apps/web/src/app/(protected)/settings/voice/`.
- Create the fact-preparation service, actions, and approval panel under `apps/web/src/app/(protected)/customers/[customerId]/voice/`.
- Modify the customer page and customer timeline to expose and display the workflow.
- Create `apps/web/src/app/api/webhooks/retell/route.ts`.

### Worker and infrastructure

- Create `apps/worker/src/handlers/voice-call-execute.ts` and `voice-call-reconcile.ts`.
- Extend `apps/worker/src/handlers/webhook-process.ts` for Retell events.
- Modify worker registration/runtime configuration.
- Modify the data, service, and observability CDK stacks for the Retell secret, task access, and alarms.
- Add `docs/runbooks/accountpulse-voice-reminders.md` for provider setup and controlled release.

---

### Task 1: Voice policy, protected fact variables, and state machine

**Progress:** Baseline committed as `9b61978`; the fixed-flow scope correction is applied in Task 5.

**Files:**
- Create: `packages/domain/src/voice-calls.ts`
- Create: `packages/domain/src/voice-calls.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces:
  - `buildCombinedVoiceDraft(input: VoiceDraftInput): VoiceDraftResult`
  - `buildVoiceCallDetailVariables(input: VoiceCallDetailInput): VoiceCallDetailVariables`
  - `evaluateVoiceContactPolicy(input: VoiceContactPolicyInput): VoiceContactPolicyDecision`
  - `transitionVoiceCallState(current: VoiceCallState, event: VoiceCallEvent): VoiceCallTransition`
  - exported `VoiceCallState`, `VoiceCallOutcome`, `VoiceCallEvent`, `VoicePolicyBlockCode`, and input/result types.
- Consumes: existing `createBusinessCalendar` and eligibility conventions from `calendar.ts` and `eligibility.ts`.

- [ ] **Step 1: Write failing draft and privacy tests**

Add tests named:

- `buildCombinedVoiceDraft includes every eligible invoice exactly once and totals Decimal amounts by currency`;
- `buildCombinedVoiceDraft lists paid, future, disputed, promised, paused, whitelisted, and inactive-chase invoices with stable exclusion codes`;
- `fixedVoiceCallCopy exposes one generic opening with option 1 details and option 2 transfer and contains no customer-specific fields`;
- `buildVoiceCallDetailVariables produces deterministic protected invoice variables without an editable script`.

Assert the approved generic voicemail exactly identifies Mott Appliance Repairs and its callback number, without a customer name, amount, invoice number, payment link, or the words "debt"/"overdue". Assert the generic opening contains the exact option 1 identity attestation, option 2 representative transfer, and spoken wrong-number instruction from the spec.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm exec vitest run packages/domain/src/voice-calls.test.ts`
Expected: FAIL because `voice-calls.ts` and its exports do not exist.

- [ ] **Step 3: Implement draft and protected-variable types/functions**

In `voice-calls.ts` implement the two functions above plus exported locked generic opening/transfer/voicemail copy. Money remains string/Decimal at boundaries; never use binary floating point for totals. Sort included invoice detail records by due date then invoice number so the same snapshot always produces the same `approvedFactsHash` input. No input or output contains editable wording or a customer name.

- [ ] **Step 4: Write failing policy boundary tests**

Add table-driven tests proving:

- Sydney `09:00` and `17:00` weekday boundary behaviour;
- an Australia/Sydney daylight-saving transition and a configured public holiday return the exact next permitted local time;
- three accepted attempts in the prior seven days block until the oldest attempt expires;
- ten accepted attempts in the current calendar month block until the first local instant of the next month;
- pre-acceptance cancellation does not consume an attempt;
- suppression, dispute, promise, pause, whitelist, invalid number, disabled feature, stale data, and permissions each block with a stable code;
- an in-flight call for the organisation blocks another call.

- [ ] **Step 5: Implement `evaluateVoiceContactPolicy`**

Use Luxon and the existing business-calendar abstraction. Return `{ allowed, blockCode, nextPermittedAt, includedInvoiceIds, excludedInvoices }`; do not throw for an expected policy block.

- [ ] **Step 6: Write failing state-transition tests**

Test every forward path from `DRAFT` directly to `APPROVED`, then through `COMPLETED` and terminal `CANCELLED`/`FAILED`/`UNKNOWN` paths. Assert there is no per-call `PREVIEWED` state, duplicate events are no-ops, late non-terminal events cannot regress terminal states, `WRONG_PERSON` and `VOICEMAIL_LEFT` retain safe outcomes, and `UNKNOWN` cannot transition to a new submission.

- [ ] **Step 7: Implement `transitionVoiceCallState` and export the module**

Use an explicit transition table. Allow later safe outcome enrichment only where the table names it; return `{ state, outcome, changed, ignoredReason }`.

- [ ] **Step 8: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/domain/src/voice-calls.test.ts packages/domain/src/calendar.test.ts packages/domain/src/eligibility.test.ts
pnpm --filter @bc5000/domain typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/domain/src/voice-calls.ts packages/domain/src/voice-calls.test.ts packages/domain/src/index.ts
git commit -m "feat: add voice reminder domain policy"
```

---

### Task 2: Voice persistence model and migration

**Progress:** Baseline committed as `117b742`; the fixed-flow column correction is applied in Task 5 before any deployment.

**Files:**
- Create: `packages/db/src/schema/voice.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/messaging.ts`
- Modify: `packages/db/src/schema/operations.ts`
- Modify: `packages/db/src/schema/organisation.ts`
- Modify: `packages/db/src/schema/schema.integration.test.ts`
- Create: `packages/db/drizzle/0007_accountpulse_voice_calls.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Create: matching `packages/db/drizzle/meta/0007_snapshot.json`

**Interfaces:**
- Produces: Drizzle tables `organisationVoiceSettings`, `voiceCallRequests`, `voiceCallInvoices`, and `voiceCallEvents`.
- Extends: contact/suppression channels with `VOICE`; provider/webhook provider with `RETELL`; task kinds with `VOICE_CONTACT_REVIEW` and `VOICE_OUTCOME_REVIEW`.
- Consumes: domain state/outcome values from Task 1 as database enum/check values.

- [ ] **Step 1: Write failing schema integration tests**

Assert:

- one settings row per organisation;
- `previewPublicKey` exists and is non-secret text;
- raw API keys and SIP passwords have no columns;
- `voiceCallRequests` has unique `(organisationId, idempotencyKey)` and nullable unique provider call identity scoped to Retell;
- `voiceCallInvoices` is unique by `(voiceCallId, invoiceId)` and stores the approved Xero/sync snapshot;
- `voiceCallEvents` is unique by `(organisationId, provider, providerEventKey)`;
- `voiceCallRequests` stores `callFlowVersion`, `callFlowHash`, and `approvedFactsHash`, with no generated script or per-call preview column;
- approved facts and a pinned flow version are required before `APPROVED`;
- `VOICE`/`RETELL`/voice task-kind values round-trip.

- [ ] **Step 2: Run the schema test and confirm it fails**

Run: `pnpm exec vitest run packages/db/src/schema/schema.integration.test.ts`
Expected: FAIL because the new tables and enum values do not exist.

- [ ] **Step 3: Add the schema**

Define the spec fields, foreign keys, indexes for organisation/customer/state/provider-call lookups, safe transfer label, `voiceSettingsUpdatedAt`, approval timestamps, failure code/detail, pinned call-flow/fact hashes, and immutable invoice snapshot. Store `combinedAmount` with the repository's exact numeric-money convention.

- [ ] **Step 4: Generate, review, and name the migration**

Run: `pnpm db:generate`. Rename the generated migration to `0007_accountpulse_voice_calls.sql` if Drizzle chooses a generated suffix, preserving the journal entry. Inspect the SQL to ensure it only adds the planned objects and enum/check extensions and does not rewrite existing customer data or live-sending settings.

- [ ] **Step 5: Verify migration and schema**

Run:

```bash
pnpm exec vitest run packages/db/src/schema/schema.integration.test.ts
pnpm --filter @bc5000/db typecheck
pnpm --filter @bc5000/db build
```

Expected: PASS, with the generated SQL containing no destructive `DROP TABLE` or live-mode update.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema packages/db/drizzle
git commit -m "feat: add voice reminder persistence"
```

---

### Task 3: Organisation-scoped repository, permissions, and job contracts

**Progress:** Baseline committed as `776cde0`; the per-call preview method and script fields are removed in Task 5.

**Files:**
- Create: `packages/db/src/repositories/voice-call-repository.ts`
- Create: `packages/db/src/repositories/voice-call-repository.integration.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/web.ts`
- Modify: `packages/auth/src/authorise.ts`
- Modify: `packages/auth/src/authorise.test.ts`
- Modify: `packages/jobs/src/names.ts`
- Modify: `packages/jobs/src/payloads.ts`
- Create: `packages/jobs/src/voice-call-payloads.test.ts`

**Interfaces:**
- Produces repository methods:
  - `createDraft(input: CreateVoiceCallDraftInput): Promise<VoiceCallAggregate>`
  - `approveAndQueue(input: ApproveVoiceCallInput): Promise<{ voiceCallId: string; created: boolean }>`
  - `loadForExecution(organisationId: string, voiceCallId: string): Promise<VoiceCallExecutionAggregate | null>`
  - `claimForSubmission(input: ClaimVoiceCallInput): Promise<VoiceCallClaimResult>`
  - `recordProviderAccepted(input: ProviderAcceptedInput): Promise<void>`
  - `appendEvent(input: AppendVoiceCallEventInput): Promise<{ created: boolean }>`
  - `recentProviderAcceptedAttempts(input: RecentVoiceAttemptsInput): Promise<ReadonlyArray<VoiceAttempt>>`
  - `findByProviderCallId(organisationId: string, providerCallId: string): Promise<VoiceCallAggregate | null>`
- Produces permissions `voice-call.read`, `voice-call.prepare`, `voice-call.place`, `voice-contact.override`, `voice-suppression.clear`, `voice-settings.manage`.
- Produces job payloads `VoiceCallExecutePayload` and `VoiceCallReconcilePayload`.

- [ ] **Step 1: Write failing repository integration tests**

Cover organisation isolation for every read/write, immutable approved snapshots, recent accepted-attempt selection, unknown-outcome redial blocking, and unique provider events. The concurrency test must issue two `approveAndQueue`/`claimForSubmission` operations with the same idempotency key and assert one call row, one queued job intent, and one winning submission claim.

- [ ] **Step 2: Run repository tests and confirm they fail**

Run: `pnpm exec vitest run packages/db/src/repositories/voice-call-repository.integration.test.ts`
Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the repository**

Use explicit transactions and organisation predicates on every query. `approveAndQueue` must return the existing call for a duplicate key. `claimForSubmission` must use a conditional state update/advisory locking consistent with the repository's existing transaction helpers and enforce one in-flight call per organisation.

- [ ] **Step 4: Write and implement permission tests**

Assert Administrator and Operator can read/prepare/place calls; only Administrator can manage settings or clear a wrong-person suppression; the existing controlled Operator contact-override capability is unchanged. Add the permission names without widening any unrelated role.

- [ ] **Step 5: Write and implement job-contract tests**

Add names `voice-call.execute` and `voice-call.reconcile`. Payloads contain only organisation/call IDs and correlation metadata; they must not contain scripts, phone numbers, invoice amounts, Retell keys, or transcripts.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/db/src/repositories/voice-call-repository.integration.test.ts packages/auth/src/authorise.test.ts packages/jobs/src/voice-call-payloads.test.ts
pnpm --filter @bc5000/db typecheck
pnpm --filter @bc5000/auth typecheck
pnpm --filter @bc5000/jobs typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/db/src packages/auth/src packages/jobs/src
git commit -m "feat: add voice call repository and permissions"
```

---

### Task 4: Retell provider adapter and webhook verification

**Progress:** Baseline committed as `f07b6c0`; the outbound variable contract is tightened and independently reviewed with Task 5.

**Files:**
- Create: `packages/integrations/src/retell/types.ts`
- Create: `packages/integrations/src/retell/client.ts`
- Create: `packages/integrations/src/retell/client.test.ts`
- Create: `packages/integrations/src/retell/webhook.ts`
- Create: `packages/integrations/src/retell/webhook.test.ts`
- Create: `packages/integrations/src/retell/index.ts`
- Modify: `packages/integrations/package.json`

**Interfaces:**
- Produces:
  - `RetellClient.createPhoneCall(input: RetellCreatePhoneCallInput): Promise<{ callId: string; callStatus: string }>`
  - `RetellClient.getCall(callId: string): Promise<RetellCallStatus>`
  - `verifyRetellWebhook(input: { rawBody: Uint8Array; signature: string; apiKey: string; now: Date; toleranceMs?: number }): boolean`
  - `parseRetellWebhook(rawBody: Uint8Array): RetellWebhookEvent`
- Error classes: `RetellPermanentError`, `RetellAuthenticationError`, `RetellRateLimitedError`, `RetellTransientError`, `RetellUnknownDispatchError`.

- [ ] **Step 1: Write failing outbound contract tests**

Against a deterministic fake HTTP endpoint, assert `POST https://api.retellai.com/v2/create-phone-call` sends Bearer authentication, `from_number`, `to_number`, AccountPulse `idempotency_key`, `honor_internal_dnc: true`, pinned `override_agent_id`/`override_agent_version`, approved dynamic variables, safe metadata, and no recording/transcript-retention request. Assert `GET /v2/get-call/{callId}` reads only a known call.

- [ ] **Step 2: Run client tests and confirm they fail**

Run: `pnpm exec vitest run packages/integrations/src/retell/client.test.ts`
Expected: FAIL because the Retell adapter does not exist.

- [ ] **Step 3: Implement client and error mapping**

Build on `packages/integrations/src/http.ts`. Map validation/auth/rate-limit/5xx errors explicitly. If the connection may have failed after request dispatch and acceptance is unknowable, throw `RetellUnknownDispatchError`; never label it safe to retry.

- [ ] **Step 4: Write failing webhook security tests**

Use official `X-Retell-Signature` fixtures in the form `v={timestamp},d={hex_digest}`. Assert HMAC-SHA256 over the exact raw body plus timestamp, constant-time comparison, five-minute default skew, malformed/stale rejection, duplicate-header rejection, and no JSON canonicalisation before verification. Parse `call_started`, `call_ended`, and `call_analyzed` into safe event types without exposing transcript or recording URL fields.

- [ ] **Step 5: Implement verification and parser**

Derive a stable event key from provider event/call/type/timestamp fields. Permit only documented events. Preserve structured outcome fields needed for identity, voicemail, wrong-person, transfer, and final result; discard transcript and recording fields.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/integrations/src/retell
pnpm --filter @bc5000/integrations typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/integrations
git commit -m "feat: add Retell voice provider adapter"
```

---

### Task 5: Fixed generic call-flow realignment

**Files:**
- Modify: `packages/domain/src/voice-calls.ts`
- Modify: `packages/domain/src/voice-calls.test.ts`
- Modify: `packages/db/src/schema/voice.ts`
- Modify: `packages/db/src/schema/schema.integration.test.ts`
- Modify: `packages/db/drizzle/0007_accountpulse_voice_calls.sql`
- Modify: `packages/db/drizzle/meta/0007_snapshot.json`
- Modify: `packages/db/src/repositories/voice-call-repository.ts`
- Modify: `packages/db/src/repositories/voice-call-repository.integration.test.ts`
- Modify: `packages/integrations/src/retell/client.test.ts`

**Interfaces:**
- Replaces generated-script functions with locked `fixedVoiceCallCopy` and `buildVoiceCallDetailVariables(input): VoiceCallDetailVariables`.
- Removes per-call `PREVIEWED` state and repository `markPreviewed` operations.
- Stores immutable `callFlowVersion`, `callFlowHash`, and `approvedFactsHash` instead of approved script text or script hashes.
- Limits Retell outbound variables to the AccountPulse call identifier, approved invoice-detail values, callback number, and safe transfer configuration.

- [ ] **Step 1: Write failing fixed-flow domain tests**

Assert the opening and voicemail exactly match the approved specification, contain no customer name or editable wording, and give option 1 for identity/authority attestation plus details and option 2 for transfer. Assert detail variables are deterministic, invoice facts are sorted, and the state machine moves directly from `DRAFT` to `APPROVED` with no `PREVIEWED` state.

- [ ] **Step 2: Write failing schema and repository tests**

Assert there are no generated-script or per-call-preview fields/methods. Assert approval atomically pins the call-flow version/hash and approved-facts hash, approved snapshots cannot be changed, and duplicate approval uses the original idempotency record.

- [ ] **Step 3: Run the focused tests and confirm the old baseline fails**

Run:

```bash
pnpm exec vitest run packages/domain/src/voice-calls.test.ts packages/db/src/schema/schema.integration.test.ts packages/db/src/repositories/voice-call-repository.integration.test.ts packages/integrations/src/retell/client.test.ts
```

Expected: FAIL on the old script/preview contract.

- [ ] **Step 4: Correct the domain, migration, schema, and repository**

Remove editable/generated script data and preview timestamps from the undeployed migration and snapshot. Implement the fixed copy, protected detail variables, direct fact approval, flow/fact hashes, and corresponding persistence methods. Do not add a compatibility migration because `0007` has not been deployed.

- [ ] **Step 5: Tighten the Retell outbound contract**

Assert the outbound request sends the pinned agent/version and only approved fact variables, safe transfer/callback values, and call ID. It must not send a generated script, customer name, customer speech, audio, transcript, or payment commentary.

- [ ] **Step 6: Verify, independently review, and commit**

Run:

```bash
pnpm exec vitest run packages/domain/src/voice-calls.test.ts packages/db/src/schema/schema.integration.test.ts packages/db/src/repositories/voice-call-repository.integration.test.ts packages/integrations/src/retell
pnpm --filter @bc5000/domain typecheck
pnpm --filter @bc5000/db typecheck
pnpm --filter @bc5000/integrations typecheck
pnpm lint
git diff --check
```

Expected: PASS. Request an independent review of Tasks 4-5, with particular attention to privacy, webhook verification, provider retry semantics, and the absence of legacy per-call preview/script behaviour. Resolve all material findings before continuing.

Commit:

```bash
git add packages/domain packages/db packages/integrations
git commit -m "refactor: use fixed voice call flow"
```

---

### Task 6: Administrator voice settings and generic-flow setup preview

**Files:**
- Create: `apps/web/src/app/(protected)/settings/voice/voice-settings.ts`
- Create: `apps/web/src/app/(protected)/settings/voice/actions.ts`
- Create: `apps/web/src/app/(protected)/settings/voice/voice-settings-form.tsx`
- Create: `apps/web/src/app/(protected)/settings/voice/generic-flow-preview.tsx`
- Create: `apps/web/src/app/(protected)/settings/voice/page.tsx`
- Create: `apps/web/tests/voice-settings.integration.test.ts`
- Create: `apps/web/tests/voice-settings-view.test.tsx`
- Modify: `apps/web/src/app/(protected)/settings/settings-cards.ts`
- Modify: `apps/web/src/server/runtime.ts`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces `createVoiceSettingsService(deps)` with:
  - `get(organisationId: string): Promise<VoiceSettingsView>`
  - `save(input: SaveVoiceSettingsInput): Promise<VoiceSettingsView>`
  - `setEnabled(input: SetVoiceEnabledInput): Promise<VoiceSettingsView>`
  - `testConnection(input: TestVoiceConnectionInput): Promise<VoiceConnectionTestResult>`
  - `recordGenericFlowTest(input: RecordGenericFlowTestInput): Promise<GenericFlowTestResult>`
- The browser setup preview uses a domain-restricted Retell public key and conspicuously fictional invoice data.

- [ ] **Step 1: Write failing settings-service tests**

Assert an Administrator can save provider, secret ARN, domain-restricted public preview key, pinned agent/call-flow version, voice ID/label, E.164 outbound/fallback numbers, optional SIP URI, destination label, timezone, and `09:00`/`17:00` window. Assert an Operator cannot mutate settings, private keys are never returned, invalid phone/timezone/SIP inputs fail safely, and audit events list changed field names without secret values.

Assert a successful setup test records the current call-flow hash, agent version, and voice identifier. Changing any of them makes the test stale and disables voice until an Administrator tests and enables the new pinned version.

- [ ] **Step 2: Run settings tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts`
Expected: FAIL because the settings service does not exist.

- [ ] **Step 3: Implement settings service/actions**

`testConnection` checks Retell authentication and the configured agent/version without dialling. `recordGenericFlowTest` accepts only the server-issued setup-preview session for the current flow hash. `setEnabled(true)` requires complete configuration, a recent connection test, and a successful generic-flow test for the current pinned version; it must not change Customer Live or any SMS/email sending setting.

- [ ] **Step 4: Write failing settings-view and setup-preview tests**

Assert the page uses plain language, separates enabled state from provider readiness, never renders the private key, and displays the locked generic opening and voicemail. The preview must use fictional sample invoice data, a pinned agent/version/voice, `preview_mode: "true"`, and disabled outbound/transfer tools. It must not accept a customer ID or telephone destination or retain preview audio/transcripts.

- [ ] **Step 5: Implement the settings page and preview**

Add `retell-client-js-sdk` at a pinned compatible version. Return the public preview key only to an authorised Administrator on this settings page. Restrict the key to the production and controlled staging hostnames and enable provider reCAPTCHA where supported. Require typed confirmation before enabling voice and state clearly that this enables only manual, one-at-a-time voice calls.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm install --lockfile-only
pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts apps/web/tests/voice-settings-view.test.tsx
pnpm --filter @bc5000/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/app/\(protected\)/settings apps/web/src/server/runtime.ts apps/web/tests/voice-settings* apps/web/package.json pnpm-lock.yaml
git commit -m "feat: add voice provider settings"
```

---

### Task 7: Customer preparation and fact approval

**Files:**
- Create: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-call-service.ts`
- Create: `apps/web/src/app/(protected)/customers/[customerId]/voice/actions.ts`
- Create: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-reminder-panel.tsx`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/page.tsx`
- Create: `apps/web/tests/voice-call-service.integration.test.ts`
- Create: `apps/web/tests/voice-reminder-view.test.tsx`

**Interfaces:**
- Produces `createVoiceCallService(deps)` with:
  - `prepare(input: PrepareVoiceCallInput): Promise<VoiceCallDraftView>`
  - `approveAndQueue(input: ApproveAndQueueVoiceCallInput): Promise<{ voiceCallId: string; created: boolean }>`
- Consumes the locked call-flow summary and protected fact builder from Task 5; it has no per-customer script or preview API.

- [ ] **Step 1: Write failing service integration tests**

Assert preparation combines every eligible invoice, shows stable reasons for excluded invoices, normalises/selects a `VOICE` number, returns recent attempt counts and next permitted time, pins the flow version/hash, and rejects cross-organisation IDs. Assert the approved facts hash changes when any protected invoice fact changes and that approved snapshots cannot be edited.

- [ ] **Step 2: Run service tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/tests/voice-call-service.integration.test.ts`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service and server actions**

`prepare` calls the domain policy/fact functions and repository. `approveAndQueue` rechecks permission and policy, uses the page-generated idempotency key, stores the approved fact snapshot and pinned flow hash, publishes through the durable outbox pattern, and returns the existing record for a repeated submission.

- [ ] **Step 4: Write failing customer-view tests**

Assert:

- one customer-level `Create voice reminder` button appears;
- blocked cases display the exact reason and contact-fix link;
- included/excluded invoice rows, combined balance, destination, caller identity, transfer label, attempt counts, and next permitted time are visible;
- the locked option 1/option 2/wrong-person/voicemail summary and call-flow version are visible;
- no editable script, per-customer voice preview, Retell public key, or generated wording appears;
- final confirmation repeats customer, destination, exact invoice facts, caller ID, flow version, and transfer destination;
- a double click reuses the same idempotency key.

- [ ] **Step 5: Implement the approval panel**

Use the current AccountPulse visual patterns. Keep all invoice facts read-only, label option 1 as the identity/authority confirmation path, label option 2 as transfer, and show the next permitted time without silently scheduling a call outside the permitted window.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/web/tests/voice-call-service.integration.test.ts apps/web/tests/voice-reminder-view.test.tsx
pnpm --filter @bc5000/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web packages/db
git commit -m "feat: add customer voice reminder workflow"
```

---

### Task 8: Idempotent worker execution and final revalidation

**Files:**
- Create: `apps/worker/src/handlers/voice-call-execute.ts`
- Create: `apps/worker/tests/voice-call-execute.integration.test.ts`
- Modify: `apps/worker/src/register-handlers.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/src/entrypoint.ts`
- Modify: `apps/worker/src/runtime-config.ts`
- Modify: `apps/worker/src/runtime-config.test.ts`

**Interfaces:**
- Produces `executeVoiceCall(deps: VoiceCallExecutionDependencies, payload: VoiceCallExecutePayload): Promise<VoiceCallExecutionResult>`.
- Consumes Task 1 policy, Task 3 repository/job contract, and Task 4 Retell client.

- [ ] **Step 1: Write failing happy-path and duplicate tests**

Create a fully eligible approved request and assert the handler revalidates, atomically claims, submits one Retell call with the AccountPulse idempotency key, records provider acceptance, and publishes safe activity. Invoke two handlers concurrently and assert the fake Retell endpoint receives exactly one request.

- [ ] **Step 2: Run the focused worker test and confirm it fails**

Run: `pnpm exec vitest run apps/worker/tests/voice-call-execute.integration.test.ts`
Expected: FAIL because the handler is unregistered.

- [ ] **Step 3: Implement the execution path**

Fetch the Retell API key through the configured Secrets Manager reference. Log only organisation/call/correlation IDs and safe codes. Pass the protected approved detail variables, safe callback/transfer configuration, caller/destination, pinned agent/version, `honor_internal_dnc: true`, and the provider idempotency key. Do not pass a generated script or customer name.

- [ ] **Step 4: Add failing final-revalidation tests**

Between fact approval and execution, independently mutate invoice amount/status/due date/contact/sync version, customer phone, suppression, dispute, promise, pause, whitelist, initiating membership, voice settings, flow version, feature state, calling time, holiday, frequency count, and organisation in-flight state. Assert no provider request and the exact safe cancellation code. The material invoice/customer/settings cases must assert `STALE_ACCOUNT_DATA`.

- [ ] **Step 5: Implement cancellation and failure semantics**

Known provider validation/rejection becomes `FAILED` without retry. A connection loss after possible dispatch becomes `UNKNOWN` and queues reconciliation only. Never automatically run `voice-call.execute` again after submission starts.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/worker/tests/voice-call-execute.integration.test.ts apps/worker/src/runtime-config.test.ts
pnpm --filter @bc5000/worker typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/worker
git commit -m "feat: execute voice reminders safely"
```

---

### Task 9: Retell webhook processing, reconciliation, and wrong-person protection

**Files:**
- Create: `apps/web/src/app/api/webhooks/retell/route.ts`
- Modify: `apps/web/src/server/webhook-runtime.ts`
- Modify: `apps/web/src/server/webhook-handlers.ts`
- Modify: `apps/web/tests/webhooks.integration.test.ts`
- Modify: `apps/worker/src/handlers/webhook-process.ts`
- Create: `apps/worker/src/handlers/voice-call-reconcile.ts`
- Create: `apps/worker/tests/voice-webhook-process.integration.test.ts`
- Create: `apps/worker/tests/voice-call-reconcile.integration.test.ts`
- Modify: `apps/worker/src/register-handlers.ts`

**Interfaces:**
- Public endpoint: `POST /api/webhooks/retell`.
- Produces `reconcileVoiceCall(deps, payload: VoiceCallReconcilePayload): Promise<VoiceCallReconcileResult>`.
- Consumes Task 4 raw-body verifier/parser and Task 1 transition table.

- [ ] **Step 1: Write failing route tests**

Assert the route reads the unmodified body, verifies before parsing, rejects missing/invalid/stale signatures, stores the protected raw event with provider `RETELL`, deduplicates a repeated provider event, publishes asynchronous processing, and returns promptly. Assert logs do not contain the body, destination, invoice-detail variables, transcript, or API key.

- [ ] **Step 2: Run webhook route tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/tests/webhooks.integration.test.ts`
Expected: FAIL for the new Retell cases.

- [ ] **Step 3: Implement the route and runtime wiring**

Use the same durable webhook/event-processing pattern as Sinch/Xero, but Retell verification must receive the raw bytes and API key. Do not pass transcript/recording fields into normalised jobs or audit logs.

- [ ] **Step 4: Write failing processing tests**

Assert duplicate and deliberately out-of-order `call_started`, `call_ended`, and `call_analyzed` events remain idempotent and monotonic. Assert structured outcomes distinguish option 1 identity/authority confirmation, option 2 transfer before details, option 2 transfer after details, identity not confirmed, voicemail, spoken wrong person, transfer requested/transferred/unanswered, no answer, busy, failure, and completed. For opening option 2 and wrong person, assert no financial-disclosure milestone exists. For wrong person, assert an active `VOICE` suppression is inserted immediately and one `VOICE_CONTACT_REVIEW` task is created.

- [ ] **Step 5: Implement event processing**

Use only the Retell flow's explicit structured outcome variables. Ignore transcript text and recording URLs even if the provider includes them. Append safe customer activity and create `VOICE_OUTCOME_REVIEW` when provider outcome is incomplete or contradictory.

- [ ] **Step 6: Write and implement reconciliation tests**

For accepted/unknown calls lacking a terminal event, query only the stored provider call ID, map the safe status, and never create a replacement call. Assert a reconciled `UNKNOWN` may become known terminal metadata, but no reconciliation path calls `createPhoneCall`.

- [ ] **Step 7: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/web/tests/webhooks.integration.test.ts apps/worker/tests/voice-webhook-process.integration.test.ts apps/worker/tests/voice-call-reconcile.integration.test.ts
pnpm --filter @bc5000/web typecheck
pnpm --filter @bc5000/worker typecheck
```

Expected: PASS.

Request an independent review of Tasks 8-9, focused on final revalidation, exactly-once submission, out-of-order events, reconciliation without redial, and pre-option-1 privacy. Resolve all material findings before continuing.

Commit:

```bash
git add apps/web apps/worker
git commit -m "feat: process Retell voice outcomes"
```

---

### Task 10: Customer history, operational visibility, secrets, and alarms

**Files:**
- Modify: `packages/db/src/repositories/activity-repository.ts`
- Create: `apps/web/tests/voice-customer-timeline.test.tsx`
- Modify: `apps/web/src/components/customer-timeline.tsx`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/page.tsx`
- Modify: `infra/lib/data-stack.ts`
- Modify: `infra/lib/service-stack.ts`
- Modify: `infra/lib/observability-stack.ts`
- Modify: `infra/test/stacks.test.ts`

**Interfaces:**
- Produces safe customer timeline rows and metrics:
  - `voice_unknown_outcomes_total`
  - `voice_provider_failures_total`
  - `retell_webhook_signature_failures_total`
  - queue age/webhook lag metrics under the existing namespace.
- Consumes Tasks 2, 3, 8, and 9.

- [ ] **Step 1: Write failing timeline tests**

Assert the customer timeline displays facts approved, queued, accepted, identity/authority confirmed, voicemail, wrong-person, transfer, completed, failed, unknown, reconciled, and suppression events with actor/time/safe labels. Assert it never displays the full destination, dynamic invoice-detail values, raw payload, customer speech, transcript, or recording URL.

- [ ] **Step 2: Implement activity aggregation and UI**

Add voice entries to the existing customer timeline aggregation. Display operational state, safe outcome, included invoice references, and contact-review links. Keep existing SMS/email/inbox timeline entries unchanged.

- [ ] **Step 3: Write failing CDK tests**

Assert:

- DataStack creates a production/staging Retell secret initialized only with a non-working placeholder;
- worker receives private API-key access;
- web receives only the same secret for server-side webhook verification, never as a public environment variable;
- task roles are scoped to the Retell secret;
- alarms exist for repeated authentication/signature failure, provider failure spikes, unknown backlog, and stale voice jobs;
- no stack change mutates existing sending mode or customer-live settings.

- [ ] **Step 4: Implement infrastructure and metrics**

Inject the secret ARN/value through the existing secret pattern. The browser public preview key remains organisation configuration returned only on the authorised Administrator settings-preview page. Add metric filters/alarms using safe codes rather than raw provider payloads.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/web/tests/voice-customer-timeline.test.tsx infra/test/stacks.test.ts
pnpm --filter @bc5000/web typecheck
pnpm --filter @bc5000/infra typecheck
pnpm --filter @bc5000/infra build
```

Expected: PASS.

Commit:

```bash
git add packages/db/src/repositories/activity-repository.ts apps/web infra
git commit -m "feat: add voice call visibility and infrastructure"
```

---

### Task 11: Provider runbook, end-to-end coverage, and release verification

**Files:**
- Create: `apps/web/e2e/voice-reminder.spec.ts`
- Create: `docs/runbooks/accountpulse-voice-reminders.md`
- Modify: `apps/web/e2e/fixtures.ts`

**Interfaces:**
- Validates all prior task interfaces together.
- Produces the operator/provider setup and release procedure; no new runtime API.

- [ ] **Step 1: Write the failing end-to-end scenario**

Cover Administrator setup with voice still disabled, fictional-data generic-flow testing, stale setup after the pinned version changes, enablement gating, operator fact preparation, included/excluded invoices, confirmation, duplicate submission, live state/timeline update, wrong-person suppression, and an Administrator clearing suppression after recording verified correction/re-consent. Assert the customer flow has no script editor or preview and existing SMS/email controls still work.

- [ ] **Step 2: Run the E2E test and confirm it fails before fixture wiring**

Run: `pnpm --filter @bc5000/web test:e2e -- voice-reminder.spec.ts`
Expected: FAIL until the fake Retell/webhook fixtures and complete UI flow are connected.

- [ ] **Step 3: Complete deterministic E2E fixtures**

Use a fake Retell endpoint and signed webhook fixtures. Exercise option 1 details, option 2 transfer at the opening, option 2 transfer after details, no response, spoken wrong person, voicemail, successful warm transfer, unanswered transfer, busy/no answer/invalid destination, provider rejection, unknown dispatch, reconciliation, stale account data, calling-window block, and frequency block without contacting a real number. Assert outbound variables are fact-only and contain no customer name or generated script.

- [ ] **Step 4: Write the provider and release runbook**

Document:

1. Retell account/agent/version creation and Australian-English voice selection;
2. VoIPline inbound/outbound SIP trunk configuration and verified Australian caller identity;
3. the Administrator-only fictional setup preview and conversation branches for option 1 identity/authority confirmation plus details, option 2 warm transfer before or after details, spoken wrong person, fallback number, no response, and generic voicemail;
4. explicit no-recording/minimal-data settings and confirmation that AccountPulse ignores transcripts/recording URLs;
5. dynamic-variable and structured-outcome names used by the adapter;
6. public preview-key domain allow-list for `billchaser.motts.com.au` and the controlled staging hostname, plus reCAPTCHA where supported, with the key exposed only on the authorised settings-preview page;
7. signed webhook registration and health check;
8. Secrets Manager population without writing secrets to source, logs, tickets, or PostgreSQL;
9. the ten staging scenarios from the spec;
10. one staff-controlled production call and one real office warm-transfer call;
11. comparison of AccountPulse, Retell, and VoIPline records;
12. final Administrator enablement and voice-only rollback.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
git diff --check
```

Expected: every command exits zero. Treat any existing baseline failure separately and document it with evidence; do not waive a voice-related failure.

Request a final independent release-readiness review against the approved specification. Resolve all material findings and rerun the affected verification commands before any deployment or provider enablement.

- [ ] **Step 6: Perform controlled release checks without changing Customer Live**

Deploy database/web/worker changes with voice disabled. Configure Retell/VoIPline, verify webhook signatures, perform the staff-controlled call and office warm transfer, confirm no audio/transcript retention, then request the user's explicit approval before enabling the independent production voice switch. A rollback disables only voice and preserves its audit history.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e docs/runbooks
git commit -m "test: verify voice reminder release"
```

---

## Completion criteria

- Every focused and full verification command passes.
- The migration is non-destructive and leaves all current Customer Live values unchanged.
- Two concurrent confirmations cause one provider request.
- Every safeguard is rechecked at execution and cannot be overridden.
- Every call uses the identical locked generic opening; AccountPulse generates no customer-specific script.
- Option 1 explicitly confirms identity/authority before invoice details, and option 2 transfers at the opening or after details.
- Customer operators approve immutable facts and do not perform a per-call voice preview.
- Pre-option-1, opening option-2, wrong-person, no-response, and voicemail paths reveal no financial data.
- Retell events remain correct when duplicated or delivered out of order.
- No AccountPulse table, log, event, activity row, or job payload stores customer audio or transcript text.
- The Retell agent uses VoIPline verified identity and warm-transfers to the configured office destination.
- A staff-controlled call and an office transfer pass before the Administrator enables the independent voice feature.
- SMS, email, Xero synchronisation, Inbox, and existing Customer Live sending continue unchanged.
