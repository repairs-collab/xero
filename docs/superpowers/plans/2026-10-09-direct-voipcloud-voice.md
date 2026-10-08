# Direct VoIPcloud Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Retell runtime with a VoIPcloud-initiated, OVH-hosted voice gateway while fixing voice enablement errors and preserving the approved privacy and safety controls.

**Architecture:** AccountPulse records and validates each manual call, then sends a signed command to an internal Node/TypeScript gateway. The gateway uses VoIPcloud's Australian click-to-call API, a dedicated SIP user registered to Asterisk, and local Piper speech; it emits signed safe events back to AccountPulse. Work is gated after the settings fix and again after a real staff-only carrier capability test, with voice disabled throughout.

**Tech Stack:** TypeScript 6, Node.js 24, Next.js 16 server actions, PostgreSQL 17/Drizzle, Vitest, Docker Compose on OVH, Asterisk, Piper 1.8, HMAC-SHA256.

**Spec:** `docs/superpowers/specs/2026-10-09-accountpulse-direct-voipcloud-voice-design.md`

## Global Constraints

- Existing SMS, email, Xero sync, Inbox, and Customer Live settings remain unchanged.
- The independent voice feature remains disabled until final explicit approval.
- New call creation accepts `VOIPCLOUD` only; legacy `RETELL` rows remain readable for audit.
- Before option 1, the locked human greeting may speak only the approved account name; invoice numbers, amounts, balances, debt, and overdue status remain protected. Voicemail remains generic.
- The gateway may process only one pending/active call per configured VoIPcloud user.
- Customer audio, recordings, and transcripts are never captured or retained.
- Customer-specific generated audio lives in memory-backed temporary storage and is purged on terminal state or within one hour after a crash.
- A provider timeout or ambiguous dispatch becomes `UNKNOWN` and never automatically redials.
- The VoIPcloud Australian base URL is fixed; API/SIP/gateway secrets are never stored in PostgreSQL or rendered in the browser.

## Review Focus

- An enable form submitted before configuration must show inline requirements and must never throw into Next.js's generic error/not-found page; Task 1 tests this.
- Two requests for the same VoIPcloud user must produce one provider submission and one safe duplicate result; Tasks 4 and 7 test this.
- A provider response without a usable provider call ID must still remain correlated by the pre-created gateway call ID and become `UNKNOWN`; Tasks 3, 4, and 7 test this.
- Out-of-order or replayed gateway/provider events must not regress terminal state or repeat wrong-number suppression; Task 8 tests this.
- A crash during synthesis or calling must not leave invoice audio on disk or permit an automatic redial; Tasks 5 and 9 test this.

---

### Task 1: Fix voice settings enablement errors independently

**Files:**
- Modify: `apps/web/src/app/(protected)/settings/voice/actions.ts`
- Modify: `apps/web/src/app/(protected)/settings/voice/voice-settings-form.tsx`
- Modify: `apps/web/src/app/(protected)/settings/voice/page.tsx`
- Modify: `apps/web/tests/voice-settings.integration.test.ts`
- Modify: `apps/web/tests/voice-settings-view.test.tsx`

**Interfaces:**
- Produces `VoiceSettingsActionState = { status: 'idle' | 'success' | 'error'; code?: VoiceSettingsActionErrorCode; message?: string }`.
- Produces `setVoiceEnabled(previousState: VoiceSettingsActionState, formData: FormData): Promise<VoiceSettingsActionState>`.
- Consumes the existing `VoiceSettingsView.configured`, `connectionReady`, and `genericFlowReady` readiness flags.

- [x] **Step 1: Write failing service-action and view tests**

Assert known `VOICE_ENABLE_CONFIRMATION_REQUIRED`, `VOICE_SETTINGS_NOT_CONFIGURED`, and `VOICE_SETTINGS_NOT_READY` failures return stable inline messages. Assert an unexpected error still reaches the application error boundary. Assert the enable button is disabled when any readiness flag is false and its unmet requirements are visible.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts apps/web/tests/voice-settings-view.test.tsx`

Expected: FAIL because the server action throws and the button remains actionable before readiness.

- [x] **Step 3: Implement typed action results and readiness gating**

Follow the installed Next.js 16 server-action guidance in `apps/web/node_modules/next/dist/docs/` when wiring `useActionState`. Map only known domain errors to public messages. Keep disable confirmation and audit behaviour unchanged.

- [x] **Step 4: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts apps/web/tests/voice-settings-view.test.tsx
pnpm --filter @bc5000/web typecheck
```

Expected: PASS.

Commit: `fix: keep voice setup errors on the settings page`

---

### Task 2: Add provider-neutral schema with VoIPcloud as the new provider

**Files:**
- Create: `packages/db/drizzle/0010_direct_voipcloud_voice.sql`
- Create: `packages/db/drizzle/meta/0010_snapshot.json`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema/voice.ts`
- Modify: `packages/db/src/schema/schema.integration.test.ts`
- Modify: `packages/db/src/repositories/voice-call-repository.ts`
- Modify: `packages/db/src/repositories/voice-call-repository.integration.test.ts`
- Modify: `packages/jobs/src/payloads.ts`
- Modify: `packages/jobs/src/voice-call-payloads.test.ts`

**Interfaces:**
- Produces `VoiceProvider = 'RETELL' | 'VOIPCLOUD'` for reads and `NewVoiceProvider = 'VOIPCLOUD'` for creation.
- Adds settings fields `voipcloudUserNumber`, `ttsVoiceId`, `gatewayFlowVersion`, `lastGatewayTestedAt`, `lastGatewayTestSucceeded`, and `lastControlledFlowTestedAt`.
- Adds call snapshot fields `accountName`, `voipcloudUserNumber`, `ttsVoiceId`, and `gatewayFlowVersion`; `accountName` is checked against and pinned from the reviewed Xero contact.
- Adds `voiceGatewaySessions` with `gatewayCallId`, `organisationId`, `voiceCallId`, `providerUserNumber`, `idempotencyKey`, `commandHash`, `state`, `lastEventSequence`, `safeFailureCode`, `createdAt`, and `updatedAt`; it stores no approved invoice fact payload.
- Changes `VoiceCallExecutePayload.provider` to `'VOIPCLOUD'` for new jobs.

- [x] **Step 1: Write failing schema and repository tests**

Assert legacy Retell call/event rows remain readable, new rows accept `VOIPCLOUD`, new creation rejects `RETELL`, gateway sessions enforce one idempotent session per voice call and contain no invoice-fact column, and the migration disables voice plus invalidates old Retell readiness evidence without touching organisation sending state.

- [x] **Step 2: Run the migration tests and confirm they fail**

Run: `pnpm exec vitest run packages/db/src/schema/schema.integration.test.ts packages/db/src/repositories/voice-call-repository.integration.test.ts packages/jobs/src/voice-call-payloads.test.ts`

Expected: FAIL because the schema permits only `RETELL`.

- [x] **Step 3: Implement and generate the additive migration**

Make Retell-specific settings/request columns nullable legacy fields. Preserve historical rows. Update existing organisation voice settings to `provider = 'VOIPCLOUD'`, `enabled = false`, and cleared readiness timestamps; do not copy a Retell secret reference into the VoIPcloud configuration.

- [x] **Step 4: Verify migration forward and rollback safety**

Run:

```bash
pnpm --filter @bc5000/db db:generate
pnpm exec vitest run packages/db/src/schema/schema.integration.test.ts packages/db/src/repositories/voice-call-repository.integration.test.ts packages/jobs/src/voice-call-payloads.test.ts
pnpm --filter @bc5000/db typecheck
pnpm --filter @bc5000/jobs typecheck
```

Expected: PASS and no destructive statement affecting non-voice tables.

Commit: `feat: add direct VoIPcloud voice schema`

---

### Task 3: Implement and harden the VoIPcloud API adapter

**Files:**
- Create: `packages/integrations/src/voipcloud/types.ts`
- Create: `packages/integrations/src/voipcloud/client.ts`
- Create: `packages/integrations/src/voipcloud/client.test.ts`
- Create: `packages/integrations/src/voipcloud/index.ts`
- Modify: `packages/integrations/package.json`
- Modify: `packages/testing/src/provider-harness.ts`
- Modify: `packages/testing/src/provider-clients.test.ts`

**Interfaces:**
- Produces `VoipcloudClient.callToNumber(input: { userNumber: string; numberToCall: string; callerId?: string }): Promise<VoipcloudCallLaunchResult>`.
- Produces `VoipcloudClient.getUserCalls(input: { userNumber: string; from: Date; to: Date }): Promise<VoipcloudUserCall[]>`.
- Produces error classes `VoipcloudAuthenticationError`, `VoipcloudLicenceError`, `VoipcloudRateLimitedError`, `VoipcloudPermanentError`, `VoipcloudTransientError`, and `VoipcloudUnknownDispatchError`.
- Uses fixed default base URL `https://au.voipcloud.online/api/integration/v2`.

- [ ] **Step 1: Write failing contract tests against a fake HTTP transport**

Pin the provider's exact user number, E.164 destination, optional caller ID, API-key header, response parsing, redaction, timeout classification, malformed-success handling, 401/403, licensing failure, 429, 5xx, and call-history parsing. Assert no API key appears in thrown messages.

- [ ] **Step 2: Run the adapter tests and confirm they fail**

Run: `pnpm exec vitest run packages/integrations/src/voipcloud/client.test.ts packages/testing/src/provider-clients.test.ts`

Expected: FAIL because the VoIPcloud module does not exist.

- [ ] **Step 3: Implement the minimal adapter**

Keep all provider request/response shapes inside `packages/integrations/src/voipcloud`. Treat connection loss after a POST begins as unknown dispatch. Do not invent a provider call ID when the response omits one.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/integrations/src/voipcloud/client.test.ts packages/testing/src/provider-clients.test.ts
pnpm --filter @bc5000/integrations typecheck
```

Expected: PASS.

Commit: `feat: add VoIPcloud calling adapter`

---

### Task 4: Build the gateway control plane and deterministic call state machine

**Files:**
- Create: `apps/voice-gateway/package.json`
- Create: `apps/voice-gateway/tsconfig.json`
- Create: `apps/voice-gateway/src/contracts.ts`
- Create: `apps/voice-gateway/src/signatures.ts`
- Create: `apps/voice-gateway/src/call-state.ts`
- Create: `apps/voice-gateway/src/session-store.ts`
- Create: `apps/voice-gateway/src/server.ts`
- Create: `apps/voice-gateway/tests/signatures.test.ts`
- Create: `apps/voice-gateway/tests/call-state.test.ts`
- Create: `apps/voice-gateway/tests/server.integration.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `vitest.config.ts`

**Interfaces:**
- Accepts `POST /v1/calls` with `CreateGatewayCallCommand` and returns `{ gatewayCallId, state, created }`.
- Exposes `GET /v1/calls/:gatewayCallId` and `GET /health/ready` only on the private network.
- Produces `GatewayCallEvent` values with stable `eventId`, `gatewayCallId`, monotonic sequence, safe type, safe code, and timestamp.
- Produces `advanceGatewayCall(state, event): GatewayCallState` as a pure monotonic transition function.

- [ ] **Step 1: Write failing HMAC, replay, idempotency, and state tests**

Assert timestamp windows, constant-time signature verification, body integrity, replay rejection, same-idempotency reuse, different-command conflict, one active call per user, terminal-state monotonicity, and no protected fields in event metadata.

- [ ] **Step 2: Run the gateway tests and confirm they fail**

Run: `pnpm exec vitest run apps/voice-gateway/tests`

Expected: FAIL because the app does not exist.

- [ ] **Step 3: Implement the control API and repository**

Persist the session before provider submission using PostgreSQL and return the local gateway call ID even when the provider result is ambiguous. The route validates a locked flow version and rejects arbitrary script or audio content.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/voice-gateway/tests
pnpm --filter @bc5000/voice-gateway typecheck
```

Expected: PASS.

Commit: `feat: add private voice gateway control plane`

---

### Task 5: Add deterministic speech rendering and automatic audio cleanup

**Files:**
- Create: `apps/voice-gateway/src/speech/formatter.ts`
- Create: `apps/voice-gateway/src/speech/piper.ts`
- Create: `apps/voice-gateway/src/speech/audio-store.ts`
- Create: `apps/voice-gateway/tests/speech-formatter.test.ts`
- Create: `apps/voice-gateway/tests/piper.test.ts`
- Create: `apps/voice-gateway/tests/audio-store.test.ts`
- Create: `apps/voice-gateway/Dockerfile`
- Create: `apps/voice-gateway/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Produces `formatProtectedDetails(facts: ApprovedVoiceFacts): readonly SpeechSegment[]`.
- Produces `PiperRenderer.render(input: { voiceId: string; segments: readonly SpeechSegment[]; outputId: string }): Promise<RenderedAudio>`.
- Produces `TemporaryAudioStore.purge(callId)` and `purgeExpired(maxAgeMs)`.

- [ ] **Step 1: Write failing formatter and safety tests**

Assert controlled pronunciation for the approved account name, letters, digits, punctuation, zero values, cents, multiple invoices, maximum invoice count, unsupported characters, and oversized duration. Assert that only the approved account name reaches the opening and no overdue claim, fee, threat, negotiation text, or unapproved field reaches any speech segment.

- [ ] **Step 2: Write failing renderer and cleanup tests**

Use a fake Piper executable to assert argument safety, pinned voice/model lookup, mono WAV validation, 8 kHz Asterisk conversion, tmpfs-only paths, terminal purge, startup purge, one-hour expiry, and cleanup after synthesis failure.

- [ ] **Step 3: Implement with pinned Piper 1.8 and licensed voice assets**

Pin image dependencies and checksums. Record the Piper GPL licence and the selected model card; do not add a voice model until its commercial-use terms have been reviewed. Never pass untrusted text through a shell command string.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/voice-gateway/tests/speech-formatter.test.ts apps/voice-gateway/tests/piper.test.ts apps/voice-gateway/tests/audio-store.test.ts
pnpm --filter @bc5000/voice-gateway typecheck
docker build -f apps/voice-gateway/Dockerfile .
```

Expected: PASS and a renderable synthetic sample in the container smoke test.

Commit: `feat: render private voice prompts locally`

---

### Task 6: Integrate Asterisk and prove the VoIPcloud bridge on a staff number

**Files:**
- Create: `apps/voice-gateway/src/asterisk/ari-client.ts`
- Create: `apps/voice-gateway/src/asterisk/session-controller.ts`
- Create: `apps/voice-gateway/tests/asterisk-session.test.ts`
- Create: `deploy/ovh/asterisk/Dockerfile`
- Create: `deploy/ovh/asterisk/asterisk.conf`
- Create: `deploy/ovh/asterisk/extensions.conf`
- Create: `deploy/ovh/asterisk/pjsip.conf.template`
- Modify: `deploy/ovh/docker-compose.yml`
- Modify: `.env.example`
- Create: `docs/runbooks/voipcloud-capability-test.md`

**Interfaces:**
- Produces `AsteriskSessionController.start(session)` and consumes ARI channel/bridge/DTMF/playback events.
- Uses a dedicated VoIPcloud SIP user and `VoipcloudClient.callToNumber`.
- Emits safe gateway events through Task 4; provider-specific SIP/ARI details do not escape this adapter.

- [ ] **Step 1: Write failing simulated ARI tests**

Assert leg pairing by configured user plus single in-flight session, no prompt before bridge readiness, human/voicemail paths, DTMF 1/2/9, invalid/no input, protected-detail sequencing, successful/unanswered transfer, hangup, duplicate events, and cleanup.

- [ ] **Step 2: Implement the Asterisk adapter and locked dialplan**

Keep Asterisk/ARI ports private. Template SIP credentials at container start from secrets. Restrict SIP/RTP at the host firewall after confirming VoIPcloud ranges. Do not enable MixMonitor or recording modules in the call path.

- [ ] **Step 3: Run deterministic tests and deploy the capability stack with voice disabled**

Run:

```bash
pnpm exec vitest run apps/voice-gateway/tests/asterisk-session.test.ts
docker compose -f deploy/ovh/docker-compose.yml config
```

Expected: PASS; AccountPulse voice remains disabled.

- [ ] **Step 4: Execute the ten-item staff-only proof-of-capability checklist**

Use a product-owner supplied test mobile and the dedicated gateway user. Capture safe evidence for answer timing, caller ID, DTMF, detail clarity, transfer, voicemail, correlation, and purge. Do not call a customer.

- [ ] **Step 5: Stop on a failed mandatory capability**

If answer timing, DTMF, or transfer is unreliable, leave voice disabled, stop further customer integration, and document whether VoIPcloud can provide a supported outbound SIP trunk/route. Do not restore Retell.

- [ ] **Step 6: Commit only after the capability result is recorded**

Commit: `feat: connect the private gateway to VoIPcloud`

---

### Task 7: Replace Retell settings, preview, execution, and reconciliation

**Files:**
- Modify: `apps/web/src/app/(protected)/settings/voice/voice-settings.ts`
- Modify: `apps/web/src/app/(protected)/settings/voice/voice-settings-form.tsx`
- Modify: `apps/web/src/app/(protected)/settings/voice/actions.ts`
- Modify: `apps/web/src/app/(protected)/settings/voice/page.tsx`
- Modify: `apps/web/src/app/(protected)/settings/voice/free-voice-flow.ts`
- Modify: `apps/web/src/app/(protected)/settings/voice/free-voice-flow-preview.tsx`
- Delete: `apps/web/src/app/(protected)/settings/voice/generic-flow-preview.tsx`
- Modify: `apps/web/tests/voice-settings.integration.test.ts`
- Modify: `apps/web/tests/voice-settings-view.test.tsx`
- Modify: `apps/worker/src/handlers/voice-call-execute.ts`
- Modify: `apps/worker/src/handlers/voice-call-reconcile.ts`
- Modify: `apps/worker/tests/voice-call-execute.integration.test.ts`
- Modify: `apps/worker/tests/voice-call-reconcile.integration.test.ts`
- Create: `packages/integrations/src/voice-gateway/client.ts`
- Create: `packages/integrations/src/voice-gateway/client.test.ts`
- Modify: `packages/integrations/package.json`

**Interfaces:**
- Produces `SaveVoiceSettingsInput.provider: 'VOIPCLOUD'` and VoIPcloud/gateway readiness evidence.
- Produces `VoiceGatewayClient.createCall(command)` and `getCall(gatewayCallId)` using HMAC-signed internal requests.
- `executeVoiceCall` retains its current final-revalidation contract but submits to the gateway instead of `RetellClient`.

- [ ] **Step 1: Write failing settings and preview tests**

Assert there are no Retell labels, keys, agent IDs, agent versions, or browser SDKs. Assert the Australian endpoint, user number, caller ID, office target, TTS voice, gateway health, fictional-data preview, typed enablement errors, and all readiness gates are present.

- [ ] **Step 2: Write failing execution/reconciliation tests**

Assert one signed gateway request after final revalidation, same idempotency key reuse, unknown-dispatch handling without redial, status lookup by gateway call ID, provider-user concurrency protection, and no Retell calls/imports.

- [ ] **Step 3: Implement the new settings and worker paths**

Resolve `VOIPCLOUD_API_KEY` only in the gateway and `VOICE_GATEWAY_SHARED_SECRET` only in worker/gateway. The browser preview streams fictional sample audio generated by the gateway renderer and cannot accept a customer ID, phone number, or real invoice.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/web/tests/voice-settings.integration.test.ts apps/web/tests/voice-settings-view.test.tsx apps/worker/tests/voice-call-execute.integration.test.ts apps/worker/tests/voice-call-reconcile.integration.test.ts packages/integrations/src/voice-gateway/client.test.ts
pnpm --filter @bc5000/web typecheck
pnpm --filter @bc5000/worker typecheck
pnpm --filter @bc5000/integrations typecheck
```

Expected: PASS.

Commit: `feat: route voice reminders through VoIPcloud gateway`

---

### Task 8: Replace Retell webhooks with signed gateway events

**Files:**
- Create: `apps/web/src/app/api/webhooks/voice-gateway/route.ts`
- Delete: `apps/web/src/app/api/webhooks/retell/route.ts`
- Modify: `apps/web/src/server/webhook-runtime.ts`
- Modify: `apps/web/src/server/webhook-handlers.ts`
- Modify: `apps/web/tests/webhooks.integration.test.ts`
- Modify: `apps/worker/src/handlers/webhook-process.ts`
- Modify: `apps/worker/tests/voice-webhook-process.integration.test.ts`
- Delete: `packages/integrations/src/retell/client.ts`
- Delete: `packages/integrations/src/retell/types.ts`
- Delete: `packages/integrations/src/retell/webhook.ts`
- Delete: `packages/integrations/src/retell/index.ts`
- Delete: `packages/integrations/src/retell/client.test.ts`
- Delete: `packages/integrations/src/retell/webhook.test.ts`
- Modify: `packages/integrations/package.json`

**Interfaces:**
- Public endpoint: `POST /api/webhooks/voice-gateway` with raw-body HMAC verification, timestamp window, and stable event ID.
- Consumes `GatewayCallEvent` and maps only safe structured fields into existing voice state/outcome/audit rows.

- [ ] **Step 1: Write failing route and processing tests**

Assert missing/invalid/stale/replayed signatures are rejected; duplicate and out-of-order events are idempotent; option 1 gates disclosure; option 9 creates one suppression/task; transfer and voicemail map correctly; raw body, destinations, invoice details, and audio paths never enter logs or safe metadata.

- [ ] **Step 2: Implement gateway webhook ingestion and processing**

Retain the current durable store-then-publish webhook pattern. Historical Retell events remain readable but there is no active Retell route or client export.

- [ ] **Step 3: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/web/tests/webhooks.integration.test.ts apps/worker/tests/voice-webhook-process.integration.test.ts
pnpm --filter @bc5000/web typecheck
pnpm --filter @bc5000/worker typecheck
pnpm --filter @bc5000/integrations typecheck
```

Expected: PASS and `rg -n "createPhoneCall|api.retellai.com|RETELL_API_KEY|/webhooks/retell" apps packages deploy .env.example` returns no active runtime match.

Commit: `feat: process signed voice gateway outcomes`

---

### Task 9: Harden OVH deployment, monitoring, and cleanup

**Files:**
- Modify: `deploy/ovh/docker-compose.yml`
- Modify: `docker-compose.yml`
- Modify: `deploy/ovh/accountpulse-voice-log-monitor.sh`
- Modify: `deploy/ovh/accountpulse-voice-monitor.service`
- Modify: `.env.example`
- Modify: `apps/worker/tests/ovh-deployment.test.ts`
- Modify: `apps/worker/tests/voice-monitor.test.ts`
- Modify: `docs/runbooks/accountpulse-voice-reminders.md`

**Interfaces:**
- Adds private `voice-gateway` and `asterisk` services, a memory-backed audio filesystem, health checks, and least-secret environment injection.
- Adds safe alarms for gateway authentication failures, stale pending sessions, provider failures, unknown outcomes, event lag, and failed audio purge.

- [ ] **Step 1: Write failing deployment and monitor tests**

Assert no public gateway/ARI/SIP management port, no Retell secret, tmpfs audio, read-only containers where possible, health dependencies, pinned images, restart policy, gateway secret scoping, and no `SEND_MODE`/Customer Live mutation.

- [ ] **Step 2: Implement deployment and alarms**

Keep Caddy unaware of the private gateway. Expose only the minimum SIP/RTP host ports needed for VoIPcloud and document firewall allow-list evidence. Add a startup/periodic expired-audio purge.

- [ ] **Step 3: Verify and commit**

Run:

```bash
pnpm exec vitest run apps/worker/tests/ovh-deployment.test.ts apps/worker/tests/voice-monitor.test.ts
docker compose -f deploy/ovh/docker-compose.yml config
git diff --check
```

Expected: PASS.

Commit: `ops: harden OVH voice gateway deployment`

---

### Task 10: Update customer workflow, end-to-end tests, and release controls

**Files:**
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-call-service.ts`
- Modify: `apps/web/src/app/(protected)/customers/[customerId]/voice/voice-reminder-panel.tsx`
- Modify: `apps/web/tests/voice-call-service.integration.test.ts`
- Modify: `apps/web/tests/voice-reminder-view.test.tsx`
- Modify: `apps/web/tests/voice-customer-timeline.test.tsx`
- Modify: `apps/web/e2e/voice-reminder.spec.ts`
- Delete: `apps/web/e2e/fake-retell-server.mjs`
- Create: `apps/web/e2e/fake-voice-gateway.mjs`
- Modify: `apps/web/e2e/fixtures.ts`
- Modify: `docs/runbooks/accountpulse-voice-reminders.md`

**Interfaces:**
- Existing `prepare` and `approveAndQueue` interfaces remain stable for the customer page.
- Customer-facing status names remain provider neutral; provider labels may say `VoIPcloud` only in Administrator diagnostics.

- [ ] **Step 1: Write failing customer and timeline tests**

Assert the same immutable facts and safeguards, provider-neutral statuses, option 9 wrong-number wording, direct VoIPcloud readiness blocking, no Retell text, and no change to SMS/email controls.

- [ ] **Step 2: Update the customer workflow and fixtures**

Preserve all current eligibility/freshness/idempotency checks. Replace only provider snapshots, locked copy version, and outcome fixtures.

- [ ] **Step 3: Run focused and full verification**

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

Expected: every command exits zero. Any pre-existing unrelated failure must be evidenced separately; no voice-related failure may be waived.

- [ ] **Step 4: Deploy production code with voice disabled**

Back up PostgreSQL and the deployment environment, apply the additive migration, deploy the web/worker/gateway/Asterisk images, and confirm health plus normal SMS/email/Xero behaviour. Verify the independent voice switch is still off.

- [ ] **Step 5: Run one final staff-controlled call and request enablement approval**

Compare AccountPulse, gateway, Asterisk, and VoIPcloud records; verify transfer, voicemail, no pre-option-1 disclosure, and audio purge. Ask the product owner for explicit approval before enabling production voice calls.

- [ ] **Step 6: Commit**

Commit: `test: verify direct VoIPcloud voice release`

---

## Completion criteria

- Voice settings failures remain on the settings page with actionable guidance.
- Active Retell runtime code, routes, SDKs, and secrets are removed.
- Historical Retell audit rows remain readable.
- The real VoIPcloud capability gate passes on a staff number.
- A customer call cannot start before all current AccountPulse safety checks pass.
- The account-identifying human opening, generic voicemail, option 1 invoice-detail gate, option 2 transfer, option 9 wrong-number path, no-input path, and failure paths pass deterministic and end-to-end tests.
- Duplicate or ambiguous submission never causes an automatic second call.
- No customer audio, recording, transcript, invoice speech file, or secret remains after its retention boundary.
- Production deployment leaves voice disabled until explicit approval and leaves Customer Live plus SMS/email/Xero behaviour unchanged.
