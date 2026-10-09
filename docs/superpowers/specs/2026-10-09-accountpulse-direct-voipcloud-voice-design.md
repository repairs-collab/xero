# AccountPulse Direct VoIPcloud Voice Design

**Date:** 9 October 2026

**Status:** Architecture approved by the product owner on 9 October 2026

**Supersedes:** The Retell-specific provider portions of `2026-10-06-accountpulse-voice-reminders-design.md`. The existing eligibility, privacy, audit, manual-approval, calling-window, frequency, wrong-person, voicemail, and Customer Live protections remain requirements.

## 1. Outcome

AccountPulse will place manually approved customer voice reminders through the Australian VoIPcloud service without Retell. VoIPcloud remains the carrier and its `call-to-number` API initiates each call. A small voice gateway on the existing OVH host supplies the media functions that the VoIPcloud API does not provide: playing prompts, speaking approved invoice facts, receiving DTMF, detecting voicemail, and requesting a transfer to the office.

The production voice feature remains disabled until a controlled proof-of-capability call and the full release checklist pass. Existing SMS, email, Xero sync, Inbox, and Customer Live behaviour must remain live and unchanged throughout development and deployment.

## 2. Confirmed product behaviour

1. Calls remain manual, customer-level, one at a time, and operator approved.
2. One call covers every eligible overdue invoice included in the immutable approved snapshot.
3. The human opening identifies the intended customer/account using the exact account name in the immutable approved Xero snapshot. It discloses no invoice number, amount, debt, or overdue status before option 1. Voicemail remains generic and does not speak the account name.
4. Pressing **1** attests that the recipient is the account holder or authorised representative. Only then may the gateway speak invoice numbers, invoice amounts, and the combined balance.
5. Pressing **2** requests transfer to the configured Mott Appliance Repairs office destination. It is available before and after the details.
6. A detected answering machine receives the existing privacy-safe generic voicemail only.
7. A wrong-person response cannot be inferred from speech in this non-conversational release. The menu will offer a dedicated keypad option, **9**, for wrong number; selecting it ends the call, suppresses that destination for voice, and creates a contact-review task.
8. The account-identifying opening template, protected detail template, transfer copy, timeout copy, wrong-number copy, and voicemail copy are locked and versioned. Only the approved account name and protected invoice facts vary by customer; operators cannot edit scripts per customer.
9. AccountPulse stores facts, state transitions, DTMF outcomes, provider identifiers, and safe failure codes. It does not record or retain customer audio, speech, or transcripts.
10. The existing independent voice feature switch stays off until the final controlled test succeeds and the product owner explicitly approves enabling it.

## 3. Why a gateway is required

The VoIPcloud `POST /api/integration/v2/call-to-number` endpoint launches a call to a selected PBX user and, once that user answers, calls the requested destination. It does not document a call-time audio injection API, dynamic text-to-speech, DTMF-driven branching, or an API transfer operation.

AccountPulse therefore uses a dedicated VoIPcloud PBX user registered to an Asterisk instance on OVH. The Asterisk endpoint auto-answers the first leg. The gateway owns the media session once VoIPcloud bridges the customer leg. Piper generates speech locally, and Asterisk plays it, receives keypad input, performs answering-machine detection, and requests the office transfer.

The design depends on capabilities that must be proven against the real VoIPcloud account before customer use: a reliable customer-answer/media boundary, DTMF delivery to the SIP endpoint, transfer behaviour, caller-ID presentation, and API/webhook correlation. Failure of any mandatory capability is a release gate, not a reason to send a degraded customer call.

## 4. Components

### 4.1 AccountPulse web application

The existing voice settings page becomes VoIPcloud-specific. It collects only non-secret configuration:

- VoIPcloud PBX user number dedicated to the gateway;
- verified outbound caller ID, initially `+61350324518`;
- the fixed PBX queue on Tab 1, internal extension `1003`, and the `+61350324518` spoken callback/fallback;
- office destination label;
- Piper voice identifier;
- organisation timezone and permitted weekday window.

The VoIPcloud API key, SIP password, and gateway signing secret are referenced by environment-secret names and are never displayed. The API base URL is fixed to the Australian endpoint and is not user editable.

Known enablement failures are returned as typed action results and shown inline. The enable control is unavailable until configuration, API connection, gateway health, prompt preview, and the controlled call-flow test are current. No configuration error may escape the server action and render a generic not-found/error page.

### 4.2 AccountPulse worker

The existing `voice-call.execute` job keeps all final eligibility and freshness checks. After it atomically claims a call, it sends a signed internal command to the voice gateway. The command contains the gateway call ID, destination, VoIPcloud user number, caller ID, locked flow version, callback/transfer configuration, and the minimum approved invoice facts.

The worker never calls VoIPcloud directly for a customer session. The gateway must create its local session before attempting the provider request so every possible dispatch has an AccountPulse/gateway correlation identifier. A timeout after dispatch becomes `UNKNOWN`; it never causes an automatic redial.

### 4.3 Voice gateway

Add an internal-only Node/TypeScript service on the OVH Docker network. Its control API accepts HMAC-signed commands from the worker and exposes authenticated health/status endpoints. It persists a minimal session record before calling VoIPcloud and rejects a second in-flight request for the same configured VoIPcloud user. That record contains identifiers, command hash, provider user, state, sequence, and timestamps only; the approved invoice fact payload is not duplicated into the gateway session table.

The gateway:

1. renders approved protected facts with a deterministic formatter;
2. asks Piper for mono PCM/WAV audio and converts it to the format required by Asterisk;
3. stores customer-specific audio only on a memory-backed temporary filesystem;
4. invokes VoIPcloud's Australian `call-to-number` endpoint;
5. pairs the incoming VoIPcloud SIP leg to the pending session;
6. runs the locked Asterisk call flow;
7. sends signed, idempotent safe events to AccountPulse;
8. deletes customer-specific audio when the call reaches a terminal state, with a one-hour crash-recovery purge ceiling.

Only one pending or active call per VoIPcloud user is allowed. This preserves deterministic SIP-leg pairing because the provider API does not accept an AccountPulse correlation value.

### 4.4 Asterisk and Piper

Asterisk handles SIP, RTP, DTMF, answering-machine detection, playback, and transfer. Piper performs local text-to-speech without a per-call AI service. Generic audio may be cached by flow version. Invoice-specific audio is generated from the immutable approved snapshot and is never persisted outside the encrypted host and memory-backed temporary storage.

The deterministic formatter:

- spells invoice identifiers as controlled letter/digit tokens;
- speaks Australian currency with two decimal places;
- never invents fees, due dates, consequences, discounts, payment promises, or legal claims;
- limits the call to the invoices in the approved snapshot;
- rejects unsupported characters or a detail payload that exceeds the configured duration/line limit.

The browser preview requests the same renderer with fictional sample data. It must not contact VoIPcloud or a customer number.

### 4.5 Provider integration

Create a VoIPcloud adapter for:

- `POST /api/integration/v2/call-to-number`;
- supported call-history lookups needed for reconciliation;
- provider webhook verification/normalisation when the account supports the relevant events.

Authentication uses the provider's API-key header and the OVH public IP must be allow-listed in the VoIPcloud portal. Requests use E.164 destination/caller ID values and the dedicated gateway user number. Secrets are redacted from logs and never stored in PostgreSQL.

## 5. Call flow

### 5.1 Connection and voicemail classification

The gateway does not play customer content while the provider is still dialling the destination. The proof-of-capability test must demonstrate a reliable signal or media condition that identifies the bridged customer leg. After the bridge is established, Asterisk performs answering-machine detection.

If a machine is detected, play only:

> This is Mott Appliance Repairs calling. Please call our office on 03 5032 4518 during business hours.

Then record `VOICEMAIL_LEFT` and end the call.

### 5.2 Human menu

Play the locked account-identifying opening, substituting only the approved account name snapshot:

> Hello. This is an automated call from Mott Appliance Repairs intended for the account of [approved account name]. If you are the account holder or authorised to manage this account, press 1 to hear the invoice details. To speak with a representative, press 2. If this is the wrong number, press 9.

- **1:** record identity/authority attestation, then speak the approved invoices and combined balance. Offer **2** again after the details.
- **2:** request transfer to the fixed PBX queue on Tab 1, internal extension `1003`. If the queue is unavailable or unanswered, provide the approved `+61350324518` callback guidance and end safely. Do not disclose account facts first.
- **9:** record `WRONG_PERSON`, suppress the voice destination, create one contact-review task, and end without disclosure.
- **No input:** repeat the menu once, then end as `IDENTITY_NOT_CONFIRMED`.
- **Any other key:** explain the valid options once without disclosing facts.

## 6. State, events, and data migration

The database must preserve historical Retell rows for audit while making `VOIPCLOUD` the only selectable provider for new settings and calls. Provider checks therefore accept legacy `RETELL` records and new `VOIPCLOUD` records; application creation paths accept only `VOIPCLOUD`.

Retell-specific configuration columns become nullable legacy fields. New settings fields store the VoIPcloud user number, Piper voice ID, gateway flow version, connection/gateway/preview/test evidence, and non-secret destination configuration. New voice-call rows snapshot the approved account name, provider user, gateway flow version, and TTS voice identifier. A `voice_gateway_sessions` table stores only call/session identifiers, a command hash, provider user, idempotency key, state, event sequence, safe failure code, and timestamps; approved customer and invoice facts remain solely in the existing AccountPulse voice-call snapshot.

Gateway events use a stable gateway event ID and HMAC signature. Duplicate or out-of-order events cannot regress a terminal call state. Safe event types include `PROVIDER_REQUESTED`, `GATEWAY_LEG_ANSWERED`, `CUSTOMER_RINGING`, `CUSTOMER_ANSWERED`, `VOICEMAIL_DETECTED`, `MENU_PLAYED`, `IDENTITY_CONFIRMED`, `DETAILS_DELIVERED`, `TRANSFER_REQUESTED`, `TRANSFERRED`, `TRANSFER_UNANSWERED`, `WRONG_NUMBER`, `COMPLETED`, `FAILED`, and `UNKNOWN`.

Deployment of the migration forcibly leaves organisation voice settings disabled and invalidates all Retell connection/preview evidence. It must not change Customer Live, SMS/email sending, Xero sync, or any non-voice setting.

## 7. Security and privacy

- The gateway control API is reachable only on the private Docker network; it is not published through the public reverse proxy.
- All AccountPulse/gateway commands and events use versioned HMAC signatures, timestamps, and replay protection.
- SIP access is firewall restricted to the documented VoIPcloud signalling/media ranges once confirmed with the provider.
- API and SIP credentials live only in OVH-managed deployment environment files with existing restricted permissions.
- Logs contain correlation IDs, state, elapsed times, and safe codes only. They do not contain full destinations, API keys, SIP passwords, invoice facts, audio paths, or request bodies.
- Customer-specific audio is temporary, non-recording media and is deleted after use.
- No microphone capture, call recording, transcript, or conversational AI is enabled.
- Existing business-hour, holiday, suppression, dispute, promise-to-pay, whitelist, stale-data, permission, frequency, and duplicate-call controls remain mandatory.

## 8. Proof-of-capability gate

Before full integration or any customer call, use one staff-controlled destination and a dedicated VoIPcloud gateway user to prove:

1. the API key works from the OVH source IP;
2. the gateway user is called and auto-answers;
3. the customer hears no prompt before answering and hears the opening once after answer;
4. caller ID is `03 5032 4518`;
5. DTMF 1, 2, and 9 reach Asterisk reliably;
6. audio quality is intelligible for invoice identifiers and Australian currency;
7. option 2 reaches the intended office destination without a call loop;
8. voicemail receives only the generic message;
9. provider/gateway/AccountPulse records can be correlated without ambiguity;
10. customer-specific audio is removed after the test.

If customer-answer timing, DTMF, or transfer cannot be made reliable through the VoIPcloud click-to-call bridge, the release stops with voice disabled. The next supported alternative is a VoIPcloud outbound SIP trunk/route from Asterisk, subject to provider confirmation; Retell is not silently restored.

## 9. Release and rollback

Release in three independently reversible stages:

1. **Settings fix:** deploy inline enablement errors and readiness gating. Voice stays off.
2. **Gateway capability:** deploy Asterisk/Piper/gateway privately and run staff-controlled tests. Voice stays off.
3. **Application integration:** switch new voice settings/calls to VoIPcloud, run deterministic and end-to-end tests, then request explicit approval before enabling voice.

Rollback disables only the voice feature and stops the gateway containers. Historical audit data remains. No rollback may alter the organisation's Customer Live state or its SMS/email functionality.

## 10. Acceptance criteria

- The enable button never produces a not-found/error page; unmet requirements are visible inline.
- No live AccountPulse code path creates a Retell call or requires a Retell key.
- VoIPcloud initiates controlled and customer calls through its Australian API.
- The OVH gateway provides the approved generic menu, protected details, voicemail, keypad outcomes, and office transfer.
- Before option 1, only the approved account name may be spoken; invoice numbers, amounts, balances, debt, and overdue status remain protected.
- Duplicate submissions, provider ambiguity, or timeout never automatically redial.
- Customer-specific audio is purged and no customer audio/recording/transcript is retained.
- All proof-of-capability checks and automated verification pass before voice can be enabled.
- SMS, email, Xero synchronisation, Inbox, and Customer Live remain unchanged.
