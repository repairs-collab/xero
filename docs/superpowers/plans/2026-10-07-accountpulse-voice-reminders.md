# AccountPulse Voice Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, privacy-safe AccountPulse voice-reminder workflow that combines a customer's eligible overdue invoices, previews a controlled Retell voice script, places one outbound call through the organisation's VoIPline SIP service, and records a safe operational audit trail.

**Architecture:** The web app prepares immutable invoice snapshots and records an operator's approved call intent; it never places the phone call directly. A worker revalidates every safeguard, claims the request idempotently, and calls a provider-neutral Retell adapter, while signed Retell webhooks and reconciliation move the internal state machine forward. Retell supplies the AI conversation flow and VoIPline supplies the verified outbound identity, SIP transport, and office transfer destination.

**Tech Stack:** Node.js `>=24 <25`, pnpm `10.20.0`, TypeScript, Next.js `16.3.6`, React `19.3.0`, PostgreSQL, Drizzle ORM `0.45.2`, Vitest `4.1.2`, Playwright `1.55.1`, AWS CDK `2.259.0`, Retell AI, VoIPline SIP, Luxon.

**Spec:** `docs/superpowers/specs/2026-10-06-accountpulse-voice-reminders-design.md`

## Global Constraints

- Keep the existing AccountPulse Customer Live state, `send_mode`, `live_send_acknowledged`, rollout scope, SMS, email, Xero sync, and Inbox behaviour unchanged.
- Voice calling has its own organisation-level feature switch, defaults to disabled, and cannot be enabled until provider configuration passes the controlled release checks.
- Version 1 is manual and single-call only: no bulk calls, automatic sequence calls, automatic retries, or automatic redials.
- One call combines all and only the customer's currently eligible overdue invoices; financial facts come from the stored Xero snapshot and are revalidated immediately before provider submission.
- Retell is the voice/call-orchestration provider; VoIPline remains the SIP carrier, verified caller identity, office queue/ring group, and fallback office number.
- Require explicit operator approval and a current browser voice preview before queueing a call.
- Before identity confirmation, the prompt may name the intended customer but must not disclose a balance, invoice number, debt, or other account fact.
- Voicemail is generic and must not contain a customer name, balance, invoice number, payment link, or statement that money is owed.
- Do not persist customer audio or conversational transcripts; persist only the approved script, immutable invoice snapshot, safe structured milestones, identifiers, outcomes, and audit metadata.
- Calling is permitted only Monday-Friday from `09:00` through `17:00` in the organisation's IANA timezone and is blocked on national and configured public holidays.
- Enforce no more than three provider-accepted attempts in a rolling seven-day period and ten in a rolling calendar month.
- Identity, destination, suppression, dispute, promise, pause, whitelist, calling-window, frequency, permission, freshness, and duplicate-call checks are non-bypassable.
- Accept voice destinations only after E.164 normalisation and voice-callable classification.
- Store private Retell credentials only in AWS Secrets Manager and expose only a domain-restricted Retell public preview key to the browser.
- Use the repository's established organisation-scoped database, audit, background-job, server-action, integration-adapter, and test patterns.
- Follow test-driven development. Every task begins with a failing test and ends with focused verification and a commit.

## Review Focus

1. Two concurrent or repeated confirmations for the same idempotency key must produce exactly one Retell call.
2. Any material invoice, customer, contact, safeguard, or voice-setting change after preview must cancel before dialling as `STALE_ACCOUNT_DATA` or the specific blocking code.
3. Duplicate and out-of-order Retell events must be idempotent and must never regress a terminal call state.
4. Daylight-saving changes, public holidays, rolling-seven-day boundaries, and calendar-month boundaries must calculate the correct next permitted call time.
5. Wrong-person, no-response, and voicemail paths must disclose no financial information; wrong-person must immediately suppress that destination and create a review task.

---

## File map

### Domain and authorisation

- Create `packages/domain/src/voice-calls.ts` for voice draft facts, policy decisions, scripts, states, and transition rules.
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
- Create the preparation service, actions, and client panel under `apps/web/src/app/(protected)/customers/[customerId]/voice/`.
- Modify the customer page and customer timeline to expose and display the workflow.
- Create `apps/web/src/app/api/webhooks/retell/route.ts`.

### Worker and infrastructure

- Create `apps/worker/src/handlers/voice-call-execute.ts` and `voice-call-reconcile.ts`.
- Extend `apps/worker/src/handlers/webhook-process.ts` for Retell events.
- Modify worker registration/runtime configuration.
- Modify the data, service, and observability CDK stacks for the Retell secret, task access, and alarms.
- Add `docs/runbooks/accountpulse-voice-reminders.md` for provider setup and controlled release.

---

### Task 1: Voice policy, scripts, and state machine

**Files:**
- Create: `packages/domain/src/voice-calls.ts`
- Create: `packages/domain/src/voice-calls.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces:
  - `buildCombinedVoiceDraft(input: VoiceDraftInput): VoiceDraftResult`
  - `renderVoiceCallScript(input: VoiceScriptInput): VoiceCallScript`
  - `evaluateVoiceContactPolicy(input: VoiceContactPolicyInput): VoiceContactPolicyDecision`
  - `transitionVoiceCallState(current: VoiceCallState, event: VoiceCallEvent): VoiceCallTransition`
  - exported `VoiceCallState`, `VoiceCallOutcome`, `VoiceCallEvent`, `VoicePolicyBlockCode`, and input/result types.
- Consumes: existing `createBusinessCalendar` and eligibility conventions from `calendar.ts` and `eligibility.ts`.

- [ ] **Step 1: Write failing draft and privacy tests**

Add tests named:

- `buildCombinedVoiceDraft includes every eligible invoice exactly once and totals Decimal amounts by currency`;
- `buildCombinedVoiceDraft lists paid, future, disputed, promised, paused, whitelisted, and inactive-chase invoices with stable exclusion codes`;
- `renderVoiceCallScript keeps customer name in the private identity prompt but keeps balance and invoice facts out of pre-confirmation and voicemail text`;
- `renderVoiceCallScript produces deterministic protected facts and marks ordinary explanatory text as editable`.

Assert the approved generic voicemail exactly identifies Mott Appliance Repairs and its callback number, without a customer name, amount, invoice number, payment link, or the words “debt”/“overdue”.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm exec vitest run packages/domain/src/voice-calls.test.ts`
Expected: FAIL because `voice-calls.ts` and its exports do not exist.

- [ ] **Step 3: Implement draft and script types/functions**

In `voice-calls.ts` implement the two functions above. Money remains string/Decimal at boundaries; never use binary floating point for totals. Sort included invoice lines by due date then invoice number so the same snapshot always produces the same script and `scriptHash` input.

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

Test every forward path from `DRAFT` through `COMPLETED` and terminal `CANCELLED`/`FAILED`/`UNKNOWN` paths. Assert duplicate events are no-ops, late non-terminal events cannot regress terminal states, `WRONG_PERSON` and `VOICEMAIL_LEFT` retain safe outcomes, and `UNKNOWN` cannot transition to a new submission.

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
- approved facts are required before `APPROVED`;
- `VOICE`/`RETELL`/voice task-kind values round-trip.

- [ ] **Step 2: Run the schema test and confirm it fails**

Run: `pnpm exec vitest run packages/db/src/schema/schema.integration.test.ts`
Expected: FAIL because the new tables and enum values do not exist.

- [ ] **Step 3: Add the schema**

Define the spec fields, foreign keys, indexes for organisation/customer/state/provider-call lookups, safe transfer label, `voiceSettingsUpdatedAt`, preview/approval timestamps, failure code/detail, and immutable invoice snapshot. Store `combinedAmount` with the repository's exact numeric-money convention.

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
  - `markPreviewed(input: PreviewVoiceCallInput): Promise<VoiceCallAggregate>`
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

### Task 5: Administrator voice settings and safe preview configuration

**Files:**
- Create: `apps/web/src/app/(protected)/settings/voice/voice-settings.ts`
- Create: `apps/web/src/app/(protected)/settings/voice/actions.ts`
- Create: `apps/web/src/app/(protected)/settings/voice/voice-settings-form.tsx`
- Create: `apps/web/src/app/(protected)/settings/voice/page.tsx`
- Create: `apps/web/tests/voice-settings.integration.test.ts`
- Create: `apps/web/tests/voice-settings-view.test.tsx`
- Modify: `apps/web/src/app/(protected)/settings/settings-cards.ts`
- Modify: `apps/web/src/server/runtime.ts`

**Interfaces:**
- Produces `createVoiceSettingsService(deps)` with:
  - `get(organisationId: string): Promise<VoiceSettingsView>`
  - `save(input: SaveVoiceSettingsInput): Promise<VoiceSettingsView>`
  - `setEnabled(input: SetVoiceEnabledInput): Promise<VoiceSettingsView>`
  - `testConnection(input: TestVoiceConnectionInput): Promise<VoiceConnectionTestResult>`
- Consumes the permissions from Task 3 and the Retell adapter from Task 4.

- [ ] **Step 1: Write failing settings-service tests**

Assert an Administrator can save provider, secret ARN, public preview key, agent/version, voice ID/label, E.164 outbound/fallback numbers, optional SIP URI, destination label, timezone, `09:00`/`17:00` window, and voicemail template. Assert an Operator cannot mutate settings, private keys are never returned, invalid phone/timezone/SIP inputs fail safely, and an audit event records actor and changed field names without secret values.

- [ ] **Step 2: Run settings tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts`
Expected: FAIL because the settings service does not exist.

- [ ] **Step 3: Implement settings service/actions**

`testConnection` verifies Retell authentication and configured agent/version without placing a telephone call. `setEnabled(true)` requires a recent successful connection result and all required configuration, but does not change Customer Live or other sending settings.

- [ ] **Step 4: Write failing view tests**

Assert the settings card and page use plain language, display enabled/disabled/provider readiness separately, label the public key as domain-restricted rather than secret, never render the private key, and show the exact safe voicemail wording.

- [ ] **Step 5: Implement the page and form**

Follow existing integration/sending settings patterns. Require a typed confirmation before enabling voice customer calls and clearly state that enabling voice does not enable bulk or automatic voice calls.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts apps/web/tests/voice-settings-view.test.tsx
pnpm --filter @bc5000/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/app/\(protected\)/settings apps/web/src/server/runtime.ts apps/web/tests/voice-settings*
git commit -m "feat: add voice provider settings"
```

---

### Task 6: Customer preparation, script approval, and browser preview

**Files:**
- Create: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-call-service.ts`
- Create: `apps/web/src/app/(protected)/customers/[customerId]/voice/actions.ts`
- Create: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-reminder-panel.tsx`
- Create: `apps/web/src/app/(protected)/customers/[customerId]/voice/retell-preview.tsx`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/page.tsx`
- Modify: `apps/web/package.json`
- Create: `apps/web/tests/voice-call-service.integration.test.ts`
- Create: `apps/web/tests/voice-reminder-view.test.tsx`

**Interfaces:**
- Produces `createVoiceCallService(deps)` with:
  - `prepare(input: PrepareVoiceCallInput): Promise<VoiceCallDraftView>`
  - `markPreviewed(input: MarkVoicePreviewedInput): Promise<VoiceCallDraftView>`
  - `approveAndQueue(input: ApproveAndQueueVoiceCallInput): Promise<{ voiceCallId: string; created: boolean }>`
- Browser preview uses `retell-client-js-sdk` with `new RetellClient({ key: publicKey })` and `createWebCall({ agent_id, agent_version, retell_llm_dynamic_variables, metadata, hooks })`.

- [ ] **Step 1: Write failing service integration tests**

Assert preparation combines every eligible invoice, shows stable reasons for excluded invoices, normalises/selects a `VOICE` number, returns recent attempt counts and next permitted time, and rejects cross-organisation IDs. Assert editing ordinary wording changes `scriptHash` and clears `previewedAt`; protected financial facts cannot be edited. Assert approval requires the current hash to have been previewed.

- [ ] **Step 2: Run service tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/tests/voice-call-service.integration.test.ts`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service and server actions**

`prepare` calls Task 1 policy/script functions and Task 3 repository methods. `approveAndQueue` rechecks permission and policy, uses the page-generated idempotency key, durably records the approved request and job in the same transactional/outbox pattern used by existing jobs, and returns the existing record for duplicate submissions.

- [ ] **Step 4: Write failing customer-view and preview tests**

Assert:

- one customer-level `Create voice reminder` button appears;
- blocked cases display the exact reason and contact-fix link;
- included/excluded invoice rows, combined balance, destination, caller identity, transfer label, attempt counts, and next permitted time are visible;
- preview passes `preview_mode: "true"`, no telephone destination, pinned agent/version, `transcript: false`, current script variables, and the draft ID;
- only a domain-restricted public key reaches browser props;
- changing text after preview disables confirmation;
- confirmation repeats customer, destination, total, invoice list, caller ID, and transfer destination;
- a double click reuses the idempotency key.

- [ ] **Step 5: Implement the panel and browser preview**

Add `retell-client-js-sdk` at a pinned compatible version. Restrict the Retell key to the production hostname (and explicit staging hostname) in provider setup; enable provider reCAPTCHA where supported. The preview branch must never expose outbound calling or transfer tools and AccountPulse must not store preview audio/transcripts.

- [ ] **Step 6: Verify and commit**

Run:

```bash
pnpm install --lockfile-only
pnpm exec vitest run apps/web/tests/voice-call-service.integration.test.ts apps/web/tests/voice-reminder-view.test.tsx
pnpm --filter @bc5000/web typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web packages/db pnpm-lock.yaml
git commit -m "feat: add customer voice reminder workflow"
```

---

### Task 7: Idempotent worker execution and final revalidation

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

Fetch the Retell API key through the configured Secrets Manager reference. Log only organisation/call/correlation IDs and safe codes. Pass approved script variables, caller/destination, pinned agent/version, `honor_internal_dnc: true`, and the provider idempotency key.

- [ ] **Step 4: Add failing final-revalidation tests**

Between preview/approval and execution, independently mutate invoice amount/status/due date/contact/sync version, customer phone, suppression, dispute, promise, pause, whitelist, initiating membership, voice settings, feature state, calling time, holiday, frequency count, and organisation in-flight state. Assert no provider request and the exact safe cancellation code. The material invoice/customer/settings cases must assert `STALE_ACCOUNT_DATA`.

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

### Task 8: Retell webhook processing, reconciliation, and wrong-person protection

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

Assert the route reads the unmodified body, verifies before parsing, rejects missing/invalid/stale signatures, stores the protected raw event with provider `RETELL`, deduplicates a repeated provider event, publishes asynchronous processing, and returns promptly. Assert logs do not contain the body, destination, script, transcript, or API key.

- [ ] **Step 2: Run webhook route tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/tests/webhooks.integration.test.ts`
Expected: FAIL for the new Retell cases.

- [ ] **Step 3: Implement the route and runtime wiring**

Use the same durable webhook/event-processing pattern as Sinch/Xero, but Retell verification must receive the raw bytes and API key. Do not pass transcript/recording fields into normalised jobs or audit logs.

- [ ] **Step 4: Write failing processing tests**

Assert duplicate and deliberately out-of-order `call_started`, `call_ended`, and `call_analyzed` events remain idempotent and monotonic. Assert structured outcomes map to identity confirmed/not confirmed, voicemail, wrong person, transfer requested/transferred/unanswered, no answer, busy, failure, and completed. For wrong person, assert no financial-disclosure milestone exists, an active `VOICE` suppression is inserted immediately, and one `VOICE_CONTACT_REVIEW` task is created.

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

Commit:

```bash
git add apps/web apps/worker
git commit -m "feat: process Retell voice outcomes"
```

---

### Task 9: Customer history, operational visibility, secrets, and alarms

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
- Consumes Tasks 2, 3, 7, and 8.

- [ ] **Step 1: Write failing timeline tests**

Assert the customer timeline displays previewed, approved, queued, accepted, identity, voicemail, wrong-person, transfer, completed, failed, unknown, reconciled, and suppression events with actor/time/safe labels. Assert it never displays the full destination, script, raw payload, customer speech, transcript, or recording URL.

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

Inject the secret ARN/value through the existing secret pattern. The browser public preview key remains organisation configuration returned only on authorised preview pages. Add metric filters/alarms using safe codes rather than raw provider payloads.

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

### Task 10: Provider runbook, end-to-end coverage, and release verification

**Files:**
- Create: `apps/web/e2e/voice-reminder.spec.ts`
- Create: `docs/runbooks/accountpulse-voice-reminders.md`
- Modify: `apps/web/e2e/fixtures.ts`

**Interfaces:**
- Validates all prior task interfaces together.
- Produces the operator/provider setup and release procedure; no new runtime API.

- [ ] **Step 1: Write the failing end-to-end scenario**

Cover Administrator setup with voice still disabled, enablement gating, operator preparation, included/excluded invoices, preview, stale-preview after edit, confirmation, duplicate submission, live state/timeline update, wrong-person suppression, and an Administrator clearing suppression after recording verified correction/re-consent. Assert existing SMS/email controls still work.

- [ ] **Step 2: Run the E2E test and confirm it fails before fixture wiring**

Run: `pnpm --filter @bc5000/web test:e2e -- voice-reminder.spec.ts`
Expected: FAIL until the fake Retell/webhook fixtures and complete UI flow are connected.

- [ ] **Step 3: Complete deterministic E2E fixtures**

Use a fake Retell endpoint and signed webhook fixtures. Exercise human confirmation, no response, wrong person, voicemail, successful warm transfer, unanswered transfer, busy/no answer/invalid destination, provider rejection, unknown dispatch, reconciliation, stale account data, calling-window block, and frequency block without contacting a real number.

- [ ] **Step 4: Write the provider and release runbook**

Document:

1. Retell account/agent/version creation and Australian-English voice selection;
2. VoIPline inbound/outbound SIP trunk configuration and verified Australian caller identity;
3. the conversation-flow branches for browser preview, identity confirmation, wrong person, combined reminder, press-1 warm transfer, fallback number, no response, and generic voicemail;
4. explicit no-recording/minimal-data settings and confirmation that AccountPulse ignores transcripts/recording URLs;
5. dynamic-variable and structured-outcome names used by the adapter;
6. public preview-key domain allow-list for `billchaser.motts.com.au` and the controlled staging hostname, plus reCAPTCHA where supported;
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
- Pre-confirmation, wrong-person, no-response, and voicemail paths reveal no financial data.
- Retell events remain correct when duplicated or delivered out of order.
- No AccountPulse table, log, event, activity row, or job payload stores customer audio or transcript text.
- The Retell agent uses VoIPline verified identity and warm-transfers to the configured office destination.
- A staff-controlled call and an office transfer pass before the Administrator enables the independent voice feature.
- SMS, email, Xero synchronisation, Inbox, and existing Customer Live sending continue unchanged.
