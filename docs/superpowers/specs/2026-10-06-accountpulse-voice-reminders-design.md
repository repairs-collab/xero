# AccountPulse Voice Reminders Design

**Date:** 6 October 2026

**Revised:** 8 October 2026

**Status:** Approved for implementation on 8 October 2026

**Scope:** Manually initiated, combined-account voice reminders using Retell AI over a VoIPline SIP trunk

## 1. Purpose

AccountPulse will add a manual voice-reminder action to each customer account. An authorised staff member can review the customer's eligible overdue invoices, approve the exact account facts, and place one outbound call from the business's verified VoIPline number. Every customer call uses the same locked, versioned Retell call flow; AccountPulse does not generate or edit a customer-specific script.

The generic opening protects the customer's privacy by disclosing no customer name, invoice, balance, debt, or payment information. Pressing 1 explicitly confirms that the recipient is the account holder or authorised to manage the account associated with the called number; only then does Retell read the approved invoice numbers and amounts. Pressing 2 at the opening or after the details warm-transfers to the office. Voicemail receives a generic callback message only. AccountPulse retains the fixed flow version, approved fact snapshot, and operational outcome, but not the customer's voice or a recording of the conversation.

The first release is deliberately manual and single-call only. It does not add voice calls to automatic reminder sequences.

## 2. Goals and success criteria

The release must:

1. Add one clear **Create voice reminder** action to the customer account page.
2. Combine all currently eligible overdue invoices for that customer into one call.
3. Display the combined balance, included invoices, excluded invoices, destination number, and recent call history before fact approval.
4. Use one locked, versioned generic call flow for every call and supply invoice numbers and amounts only as structured values from the stored Xero invoice snapshot.
5. Let an Administrator test the configured Retell agent, voice, and generic flow with non-customer sample data during setup.
6. Require explicit confirmation before queueing a call.
7. Place the outbound call through Retell using the organisation's VoIPline SIP trunk and verified caller identity.
8. Treat option 1 as an explicit identity/authority attestation and disclose no balance, invoice number, or account detail before that selection.
9. Warm-transfer a recipient who presses 2 to the configured VoIPline office queue or ring group, with an E.164 office number as fallback, without first disclosing account details.
10. Leave a privacy-safe voicemail when voicemail is detected.
11. Record a complete metadata audit trail and customer-timeline history without retaining customer speech or full call audio.
12. Enforce eligibility, opt-out, frequency, business-hours, permissions, freshness, and duplicate-call protections at final execution time.
13. Leave existing SMS, email, Xero synchronisation, Inbox, and Customer Live behaviour unchanged if the voice provider is unavailable or voice calling is disabled.

Success means a controlled production call can be prepared, fact-approved, answered, identity-confirmed through option 1, transferred through option 2, and reconciled in AccountPulse without disclosing account information to an unconfirmed recipient or creating a duplicate call.

## 3. Confirmed product decisions

1. One call covers the customer's combined eligible overdue account rather than one call per invoice.
2. Calls are initiated manually from the customer account; automatic and bulk voice calling are out of scope.
3. The operator reviews and approves the exact account facts before calling; the operator does not generate or edit a customer-specific script.
4. Every call uses one locked, versioned generic opening and menu.
5. **Press 1** explicitly confirms that the recipient is the account holder or authorised representative, then reads the approved invoice numbers and amounts.
6. **Press 2** at the opening or after the details warm-transfers to the office without disclosing account facts first.
7. Voicemail receives a generic callback request with no customer name, balance, invoice number, or statement that a debt is owed.
8. AccountPulse does not retain the customer's voice, a full call recording, or a conversational transcript.
9. The call-flow version, included-invoice snapshot, call metadata, provider identifiers, and outcome are retained for audit.
10. Calls are limited to weekdays between 9:00 am and 5:00 pm in the organisation's configured local timezone and are blocked on applicable public holidays.
11. Voice safeguards cannot be bypassed by the existing Customer Live override.
12. Existing AccountPulse Customer Live status is not downgraded or changed during development or release of voice calling.
13. Retell is the voice and call-orchestration provider; VoIPline remains the SIP carrier, caller identity, and office transfer destination.

### 3.1 Alternatives considered

- **Selected: fixed menu with option 1 attestation and option 2 transfer.** This meets the requested two-button experience while keeping all account facts behind an explicit authority confirmation.
- **Second-factor verification after option 1.** Asking for a postcode, PIN, or invoice fragment would reduce shared-phone risk but adds customer friction and depends on verification data that may be missing or stale in Xero.
- **Transfer-only call with no automated account details.** This would disclose the least information but would not meet the requirement for customers to hear invoice numbers and amounts through option 1.

## 4. User experience

### 4.1 Customer account entry point

Add **Create voice reminder** to the customer-account hero area. This is a customer-level action because the call combines multiple invoices. The existing per-invoice **Call client**, **Send SMS**, and **Send email** controls remain unchanged.

The action is unavailable with a specific explanation when:

- no voice-callable number exists;
- no invoice is currently eligible;
- the customer or number is voice-suppressed;
- there is an open customer-level dispute, active promise to pay, or active customer pause;
- the organisation has not completed voice-provider setup;
- voice calling is disabled for the organisation.

Being outside the calling window does not prevent account review. It disables **Confirm and place call** and shows the next permitted calling time.

### 4.2 Review and approval panel

The review and approval panel shows:

- customer name and selected normalised destination number;
- combined amount and currency;
- every included invoice number, due date, amount due, and Xero-synchronisation time;
- invoices excluded from this call and a plain-language reason;
- voice-call attempts during the current week and month;
- the next permitted calling time;
- the configured outbound caller identity and transfer destination label;
- the locked call-flow version and a plain-language summary of option 1, option 2, no-response, wrong-person, and voicemail behaviour.

The operator cannot manually add an ineligible invoice or remove an eligible invoice from the combined account call. Every currently eligible overdue invoice is included so the displayed total, approved fact snapshot, and spoken details remain consistent.

### 4.3 Fixed call flow and setup preview

AccountPulse does not generate, display, or edit a customer-specific script. Retell provides one locked, versioned generic call flow for the organisation. Business identity, the option 1 identity attestation, the option 2 transfer instruction, no-response handling, wrong-person handling, detail wording, and voicemail wording are controlled by that versioned flow.

The call-flow summary clearly separates:

1. the generic opening and menu;
2. the protected details spoken only after option 1;
3. the option 2 transfer path;
4. voicemail wording.

The Administrator settings page provides **Test generic call flow**. It starts a private browser voice-preview session with the same configured Retell agent, version, and voice used for outbound calls, but supplies conspicuously fictional sample invoice data and cannot place or transfer an external telephone call. The tested flow version, agent version, and voice identifier are retained; AccountPulse does not retain a downloadable audio file.

Publishing a different Retell agent or call-flow version marks the setup test stale and disables voice calling until an Administrator successfully tests and enables the new pinned version. A per-customer operator does not need to preview the generic flow before each call.

### 4.4 Final confirmation and status

The final confirmation identifies the customer, destination, combined balance, included invoices, outbound number, call-flow version, and transfer destination. It states that option 1 will read the displayed invoice details and option 2 will transfer to the displayed office destination. Submission uses a page-generated idempotency identifier so repeated clicks or browser retries cannot create multiple calls.

After submission, the customer page shows the live operational state:

- Queued;
- Dialling;
- Ringing;
- Answered;
- Identity confirmed;
- Voicemail left;
- Transfer requested;
- Transferred;
- Completed;
- Wrong person;
- Failed;
- Outcome unknown;
- Cancelled before dialling.

Provider events also appear on the existing customer timeline. The timeline does not display sensitive provider payloads or customer speech.

## 5. Customer call flow

### 5.1 Human answer

The configured Australian-English voice begins with:

> Hello. This is an automated call from Mott Appliance Repairs. If you are the account holder or authorised to manage the account associated with this telephone number, press 1 to hear the account details. To speak with a representative, press 2. If this is the wrong number, please say “wrong number”.

The opening is identical for every customer. It does not speak a customer name, balance, invoice number, debt, overdue status, payment link, or other account fact. This protects account information when an unintended person answers.

Pressing 1 is an explicit attestation that the recipient is the account holder or authorised to manage the account associated with the called number. Retell then reads the immutable approved fact snapshot using the fixed detail pattern: “Invoice [invoice number], outstanding amount [currency and amount]” for each included invoice, followed by “The total outstanding amount is [currency and combined amount].” It does not generate additional financial claims, payment terms, fees, consequences, or negotiation language. It then says:

> To speak with a representative, press 2. Otherwise, you may contact Mott Appliance Repairs during business hours.

If the recipient presses 2 at the opening or after hearing the details, Retell initiates a warm transfer. Selecting option 2 at the opening does not confirm identity and does not cause Retell to disclose account facts. The preferred target is the configured VoIPline SIP queue or ring group. If no SIP target is configured, Retell calls the approved E.164 office fallback number. The customer is bridged only after the office side answers; office staff remain responsible for their normal identity checks before discussing the account.

If the office does not answer within the configured transfer interval, the agent tells the customer the callback number and ends the call without repeating the account details.

### 5.2 No identity response

If the recipient does not choose option 1 or option 2 and does not make an unambiguous wrong-person statement, the generic menu is repeated once. A second non-response ends the call. No financial information is disclosed. The outcome is `IDENTITY_NOT_CONFIRMED`, not a successful account contact.

### 5.3 Wrong person

An unambiguous spoken wrong-person or wrong-number response ends the call without disclosing account information. AccountPulse records `WRONG_PERSON`, adds an active `VOICE` suppression for the destination, and creates a contact-data review task. Further voice calls to that destination are blocked until an Administrator records a verified correction or re-consent. Option 2 is reserved for transfer and is not treated as a wrong-person signal.

### 5.4 Voicemail

When voicemail is detected, the voice leaves the approved generic message:

> This is Mott Appliance Repairs calling. Please call our office on [office number] during business hours.

The message contains no customer name, balance, invoice number, payment link, or statement that money is owed. The outcome is `VOICEMAIL_LEFT`.

## 6. Eligibility and safeguards

### 6.1 Included invoices

An invoice is included only when all of the following are true:

- it belongs to the active organisation and selected customer;
- Xero type is `ACCREC`;
- Xero status is `AUTHORISED`;
- amount due is greater than zero;
- due date is before the organisation's current local date;
- the customer and invoice remain active and synced;
- no active client or invoice reminder-whitelist entry covers it;
- no applicable invoice or sequence pause covers it;
- no open dispute covers it;
- no active payment promise protects it;
- an active invoice chase exists under an enabled sequence.

Paid, voided, deleted, not-yet-due, disputed, paused, promised-to-pay, whitelisted, or otherwise ineligible invoices are shown separately and are not spoken.

### 6.2 Callable destination

Voice calling uses a dedicated `VOICE` contact channel rather than assuming every SMS number is suitable. Xero telephone fields and approved AccountPulse overrides are normalised to E.164 and classified as voice-callable. The operator can see the selected source and must use the existing controlled override process to change it.

A destination is blocked when it is invalid, unusable, voice-suppressed, or awaiting wrong-person review.

### 6.3 Contact frequency

AccountPulse enforces a maximum of three provider-accepted outbound voice attempts for an account in a rolling seven-day period and ten in a rolling calendar month. Answered calls, voicemail calls, wrong-person calls, and calls that reached the provider but failed after dialling count toward the limit. Validation failures and calls cancelled before provider acceptance do not count.

There is no automatic retry. An authorised staff member may request a new call only when the destination remains eligible and frequency limits permit it.

### 6.4 Calling window

Provider submission is permitted only from 9:00 am through 5:00 pm, Monday to Friday, in the organisation's IANA timezone. Calls are blocked on national public holidays and any additional holidays in the organisation's configured business calendar.

The worker rechecks the window immediately before contacting Retell. A queued job that reaches the worker outside the window is cancelled with `CALLING_WINDOW_CLOSED`; it is not silently delayed into a later day because every call requires contemporaneous operator confirmation.

### 6.5 Final freshness check

Immediately before provider submission, the worker revalidates:

- organisation voice feature state;
- permissions and initiating-user membership state;
- customer and number status;
- voice suppression;
- disputes, promises, pauses, and reminder whitelist;
- frequency and calling window;
- every included invoice's Xero identifier, status, amount due, due date, contact, and sync version.

If any material invoice fact differs from the approved snapshot, the call is cancelled as `STALE_ACCOUNT_DATA`. The operator must review and approve a fresh fact snapshot. AccountPulse never edits financial facts inside an already approved call.

## 7. Architecture

The feature follows the application's existing web, worker, job, integration, and audit boundaries.

### 7.1 Web application

The customer page loads voice eligibility and recent call history. Server actions create drafts, record fact approval against the pinned call-flow version, and queue confirmed calls. All mutations authorise the active organisation on the server; customer identifiers in URLs or form fields never grant access.

The web process does not place telephone calls. It durably records intent and publishes a background job.

### 7.2 Worker

Add a `voice-call.execute` job. The handler obtains an organisation/customer lock, performs final revalidation, claims the call idempotently, and submits one outbound call to the voice-provider adapter. A provider timeout after dispatch records `UNKNOWN`; it never causes an automatic redial.

Add a scheduled `voice-call.reconcile` job for provider calls whose final event was not received. Reconciliation queries by the stored provider call identifier and updates metadata only. It cannot create a second call.

The first release permits at most one in-flight voice call per organisation. This matches the manual workflow and avoids unnecessary concurrency and channel-capacity complexity.

### 7.3 Provider adapter

Create a provider-neutral voice adapter with operations for:

- creating an Administrator-only setup-preview session with fictional sample data;
- placing an outbound call;
- reading a known call's current status;
- validating and normalising webhook events.

The first adapter uses Retell. Provider-specific request and response shapes remain inside `packages/integrations`. Domain and service code consume AccountPulse call commands and events so a future provider can replace Retell without rewriting eligibility or audit policy.

### 7.4 Retell and VoIPline

Retell receives the pinned generic agent/call-flow version and the minimum structured dynamic variables needed for the approved call: invoice lines, combined balance, callback number, safe transfer configuration, and AccountPulse call identifier. It does not receive a generated customer-specific script or customer name for the opening. The Retell flow is constrained to the generic menu, option 1 detail path, option 2 transfer path, no-response path, wrong-person path, and generic voicemail path; it must not invent payment terms, consequences, discounts, fees, or financial facts.

Retell originates the call through the VoIPline outbound SIP trunk using the verified business caller identity. The transfer node uses the configured VoIPline SIP target where available and the approved E.164 number as fallback.

The Retell account and agent are configured not to retain call recordings. AccountPulse does not request, download, or store customer audio or conversational transcripts. Provider settings are verified during setup and before enabling the voice feature.

### 7.5 Webhooks

Add `POST /api/webhooks/retell` as a public provider callback. The receiver:

1. reads the unmodified body;
2. verifies the current Retell webhook signature mechanism;
3. rejects invalid signatures;
4. derives a stable provider event key;
5. stores an organisation-scoped webhook event idempotently;
6. acknowledges promptly;
7. publishes asynchronous processing.

Webhook processing maps provider events to internal call status, outcome, transfer state, and safe failure categories. Duplicate and out-of-order events cannot regress a terminal state.

## 8. Data model

### 8.1 Organisation voice settings

Add `organisation_voice_settings`:

- `organisation_id` primary key;
- `enabled`;
- `provider` (`RETELL` initially);
- `secret_reference` for the Retell credential lookup key in the active hosting platform's managed secret system;
- `preview_public_key` for the domain-restricted Retell browser preview (this is not a private API credential);
- `agent_id` and pinned `agent_version`;
- `voice_id` and operator-facing voice label;
- `outbound_number`;
- nullable `transfer_sip_uri`;
- `fallback_office_number`;
- `office_destination_label`;
- `timezone`;
- `weekday_start_local` and `weekday_end_local`;
- the fixed voicemail wording is owned by the pinned call-flow version and is not an editable database setting;
- `updated_by_user_id`, `updated_at`.

Raw API secrets and SIP passwords never enter PostgreSQL.

### 8.2 Voice call requests

Add `voice_call_requests`:

- `id`;
- `organisation_id`, `contact_id`;
- `actor_user_id`;
- `destination_number`, `outbound_number`;
- `combined_amount`, `currency`;
- `call_flow_version`, `call_flow_hash`, and `approved_facts_hash`;
- `agent_id`, `agent_version`, `voice_id`;
- `voice_settings_updated_at` plus the safe transfer-target label, preserving which approved organisation configuration governed the call without copying SIP credentials into the call row;
- `idempotency_key` unique within the organisation;
- `state`;
- nullable `outcome`;
- `provider_call_id`;
- approved, queued, provider-accepted, answered, completed, and updated timestamps;
- safe `failure_code` and `failure_detail`;
- `created_at`.

The request and its pinned call-flow/fact hashes are immutable after approval except for operational state, outcome, provider identifiers, and timestamps.

### 8.3 Voice call invoice snapshots

Add `voice_call_invoices` with one row per included invoice:

- `voice_call_id`;
- `organisation_id`, `invoice_id`;
- Xero invoice identifier;
- invoice number;
- amount due and currency;
- due date;
- sync version;
- snapshot timestamp.

The combination of voice call and invoice is unique. These rows explain exactly which account facts were approved and spoken.

### 8.4 Voice call events

Add `voice_call_events` for normalised provider and internal milestones:

- `voice_call_id`, `organisation_id`;
- provider event key or internal event key;
- event type;
- safe status and outcome metadata;
- occurred and received timestamps.

The provider event key is unique per organisation/provider. Raw payloads remain in the existing protected `webhook_events` store under provider `RETELL`; broad logs and audit views receive only normalised safe fields.

### 8.5 Existing model extensions

- Extend contact channels with `VOICE` and retain Xero source type plus approved override provenance.
- Extend suppressions with channel `VOICE`.
- Extend webhook provider types with `RETELL`. Store the Retell private credential locator only as the hosting-neutral `secret_reference` in organisation voice settings; do not add Retell to the legacy AWS-shaped provider-connections contract. VoIPline SIP credentials remain provider-managed and secret-referenced.
- Extend task kinds with `VOICE_CONTACT_REVIEW` and `VOICE_OUTCOME_REVIEW`.
- Extend customer activity aggregation with voice-call events.
- Add `voice-call.execute` and `voice-call.reconcile` job payloads.

## 9. State and outcome model

Operational state moves forward through:

`DRAFT -> APPROVED -> QUEUED -> SUBMITTING -> ACCEPTED -> IN_PROGRESS -> COMPLETED`

Alternative terminal states are:

- `CANCELLED` for a known pre-dial stop;
- `FAILED` for a known permanent provider or call failure;
- `UNKNOWN` when the provider may have accepted the request but AccountPulse cannot prove the outcome.

The separate outcome field records:

- `IDENTITY_CONFIRMED`;
- `IDENTITY_NOT_CONFIRMED`;
- `REMINDER_DELIVERED`;
- `VOICEMAIL_LEFT`;
- `WRONG_PERSON`;
- `TRANSFER_REQUESTED`;
- `TRANSFERRED`;
- `TRANSFER_UNANSWERED`;
- `NO_ANSWER`;
- `BUSY`;
- `INVALID_DESTINATION`;
- `PROVIDER_REJECTED`.

Events may enrich an outcome but cannot move a terminal operational state backwards. `UNKNOWN` is never automatically resubmitted. An Administrator must reconcile it against the provider portal or status endpoint before another call to the same account can be approved.

## 10. Permissions

Add explicit permissions:

| Permission | Administrator | Operator |
| --- | --- | --- |
| `voice-call.read` | Yes | Yes |
| `voice-call.prepare` | Yes | Yes |
| `voice-call.place` | Yes | Yes |
| `voice-contact.override` | Yes | Existing controlled Operator capability |
| `voice-suppression.clear` | Yes | No |
| `voice-settings.manage` | Yes | No |

All reads and mutations include the active organisation identifier in database predicates. Settings changes, fact approval, call submission, suppression changes, and unknown-outcome reconciliation are audited with the acting user.

## 11. Security, privacy, and compliance controls

- Credentials remain in the active hosting platform's managed secret system and are injected or fetched only by the server/worker services that require them.
- Retell API calls originate from the worker; no private API key is exposed to the browser.
- Setup-preview access uses Retell's public browser-preview key, restricted to the production AccountPulse hostname (and staging hostname when required), plus an Administrator-only sample session that cannot initiate an external telephone call or transfer. Retell reCAPTCHA protection is enabled where supported.
- Provider webhook signatures are verified against the unmodified body before processing.
- Only the minimum data needed for the approved call is sent to Retell: destination, account facts, call identifier, callback number, and transfer configuration. The generic opening itself requires no customer-specific prompt or customer name.
- No card, bank-account, Xero credential, payment-link token, internal note, dispute narrative, or other unrelated customer data is sent.
- Standard logs exclude invoice-detail variables, destination numbers, webhook bodies, and customer speech. Correlation identifiers support diagnosis.
- AccountPulse retains the call-flow version/hash, approved fact snapshot, and call metadata for 24 months after the related invoices are resolved, consistent with message-content retention. Audit metadata is retained for seven years under the existing policy.
- AccountPulse does not retain full call recordings or conversational transcripts.
- Wrong-person and do-not-call requests immediately create a `VOICE` suppression.
- Identity confirmation, voice suppression, disputes, payment promises, pauses, whitelist entries, calling windows, frequency limits, and stale-data checks are non-bypassable.
- The product copy must not threaten consequences, misrepresent legal status, or imply that an AI system is a human staff member.

This design implements conservative operational controls based on current Australian debt-collection guidance. It is not a substitute for legal review of the final script, privacy notice, Retell data-processing terms, or VoIPline service configuration before broader commercial release.

## 12. Error handling

- **No usable voice number:** disable preparation and link to the existing contact override control.
- **No eligible overdue invoices:** explain the invoice-level exclusions; do not create a draft.
- **Outside calling window:** allow account review, but block submission and show the next permitted time.
- **Frequency limit reached:** block submission and show when the applicable limit resets.
- **Changed invoice/customer data:** cancel before dialling with `STALE_ACCOUNT_DATA` and require a new snapshot.
- **Duplicate browser submission:** return the existing call record through the idempotency key.
- **Retell validation or rejection:** record a safe permanent failure; do not retry automatically.
- **Network loss after dispatch:** record `UNKNOWN`, reconcile by provider call identifier, and block redial until resolved.
- **No answer or busy:** record the provider outcome; no automatic retry.
- **Voicemail detection:** leave the generic voicemail once and complete.
- **Wrong person:** stop disclosure, create suppression and review task.
- **Transfer unavailable:** provide the callback number and finish without repeating financial information.
- **Invalid webhook signature:** reject, meter, and audit without exposing the supplied payload.
- **Out-of-order/duplicate webhook:** accept idempotently without regressing state.
- **Provider outage:** isolate voice failures; do not degrade SMS, email, Inbox, Xero sync, or web availability.

No UI reports success until the call intent is durably recorded. No retry path can bypass final eligibility checks.

## 13. Audit and observability

Record at least:

- `VOICE_FLOW_SETUP_TESTED`;
- `VOICE_CALL_FACTS_APPROVED`;
- `VOICE_CALL_QUEUED`;
- `VOICE_CALL_PROVIDER_ACCEPTED`;
- `VOICE_IDENTITY_CONFIRMED`;
- `VOICE_IDENTITY_NOT_CONFIRMED`;
- `VOICE_VOICEMAIL_LEFT`;
- `VOICE_WRONG_PERSON_REPORTED`;
- `VOICE_TRANSFER_REQUESTED`;
- `VOICE_TRANSFERRED`;
- `VOICE_TRANSFER_UNANSWERED`;
- `VOICE_CALL_COMPLETED`;
- `VOICE_CALL_FAILED`;
- `VOICE_CALL_OUTCOME_UNKNOWN`;
- `VOICE_CALL_RECONCILED`;
- `VOICE_SUPPRESSION_ADDED` and `VOICE_SUPPRESSION_CLEARED`;
- `VOICE_SETTINGS_CHANGED`.

Operational metrics include queue age, calls by state/outcome, answer rate, identity-confirmation rate, voicemail rate, transfer requests, transfer success, wrong-person rate, blocked calls by safeguard, provider latency/errors, unknown outcomes, webhook signature failures, and webhook processing lag. Alerts cover repeated authentication failure, webhook rejection spikes, unknown-outcome backlog, provider failure spikes, and stale voice jobs.

## 14. Testing strategy

Implementation follows test-first development.

### 14.1 Domain tests

- combined invoice eligibility and totals;
- deterministic mapping from approved invoice snapshots to protected Retell detail variables;
- fixed generic menu wording with no customer-specific opening;
- invoice removal from a draft;
- business hours, timezone, daylight-saving transitions, and holidays;
- rolling weekly and monthly frequency limits;
- dispute, promise, pause, whitelist, suppression, and stale-version precedence;
- call state/outcome transition rules;
- idempotency-key generation;
- wrong-person suppression;
- role permissions.

### 14.2 Database and service integration tests

- organisation isolation for settings, calls, snapshots, events, and tasks;
- immutable approved snapshot and unique call idempotency;
- final revalidation cancels changed or paid invoices;
- concurrent clicks create one provider call;
- an eligible combined call includes all and only approved invoice snapshots;
- `VOICE` channel selection and approved override behaviour;
- frequency counts include provider-accepted attempts and exclude pre-acceptance validation failures;
- unknown outcomes block redial until reconciliation;
- wrong-person events add suppression and contact-review task;
- signed webhook persistence, deduplication, and out-of-order delivery;
- failure isolation from SMS, email, Xero, and Inbox workflows.

### 14.3 Provider contract tests

Using a deterministic fake Retell endpoint, verify:

- authenticated outbound-call request shape;
- agent/version/voice pinning and dynamic variables;
- no recording request and no transcript ingestion;
- SIP caller identity and transfer target selection;
- answer, voicemail, DTMF identity, wrong-person, transfer, no-answer, rejection, timeout, and status-reconciliation mappings;
- signature verification and event-key derivation.

### 14.4 Web and browser tests

- customer header action and disabled explanations;
- included/excluded invoice presentation;
- combined totals and protected fact variables;
- absence of customer-specific script generation or editing controls;
- stale setup-test behaviour after changing the pinned agent/call-flow version;
- exact confirmation summary;
- duplicate-submit handling;
- live call state updates and customer timeline;
- Admin/Operator permissions;
- voice-settings management and secret-reference handling;
- existing customer SMS/email/call-link behaviour remains unchanged.

### 14.5 Controlled staging and production checks

Staging uses team-owned numbers and exercises:

1. human answer, option 1 identity attestation, and protected detail playback;
2. no identity response;
3. wrong-person response and suppression;
4. voicemail with generic wording;
5. option 2 transfer before details and successful warm transfer after details;
6. unanswered transfer fallback;
7. busy/no-answer/invalid number;
8. provider timeout and reconciliation;
9. invoice changing between approval and execution;
10. calling-window and frequency-limit blocks.

Production begins with one call to an approved staff-controlled number, then one warm transfer to the real office destination. The operator compares AccountPulse, Retell, and VoIPline records before an Administrator enables the feature for customer calls.

## 15. Deployment and release

Voice calling has an independent, default-off organisation feature switch. Deployment does not alter `send_mode`, `live_send_acknowledged`, rollout scope, sequence modes, or any existing Customer Live state.

Release order:

1. create the Retell account, agent, versioned conversation flow, and no-recording configuration;
2. configure separate VoIPline inbound/outbound SIP trunks as required by the Retell integration and verify the caller identity;
3. configure the VoIPline office queue/SIP target and fallback number;
4. store Retell secret references and non-secret voice settings;
5. apply database migrations;
6. deploy web and worker changes with voice disabled;
7. register and verify the Retell webhook;
8. complete automated tests and staging call scenarios;
9. complete the two controlled production calls;
10. obtain Administrator approval and enable voice calling for the organisation.

Rollback disables only the voice feature and stops new voice jobs. It preserves call history and audit access while leaving all existing AccountPulse functions live.

## 16. Out of scope

- automatic sequence voice calls;
- bulk calling;
- automatic redial campaigns;
- full call recording or customer-speech retention;
- conversational transcripts in AccountPulse;
- taking payment-card or bank details by voice;
- accepting payment through the voice agent;
- negotiating payment plans without a staff transfer;
- legal-threat or debt-enforcement scripts;
- bypassing identity confirmation, suppressions, disputes, promises, pauses, whitelist entries, calling windows, or frequency limits;
- generating or editing a customer-specific voice script;
- replacing the existing device-based **Call client** link;
- replacing SMS, Xero email, or the Sinch Inbox;
- multi-tenant subscription packaging and voice-minute billing allocation.

## 17. Authoritative references

- [VoIPline API](https://www.voipline.net.au/knowledge-base/article/360003477716)
- [VoIPline Retell AI SIP trunk guide](https://www.voipline.net.au/knowledge-base/article/13857275633935)
- [Retell outbound calls](https://docs.retellai.com/deploy/outbound-call)
- [Retell call transfer node](https://docs.retellai.com/build/conversation-flow/call-transfer-node)
- [Retell user DTMF](https://docs.retellai.com/build/user-dtmf)
- [Retell dynamic variables](https://docs.retellai.com/build/dynamic-variables)
- [Retell custom telephony](https://docs.retellai.com/deploy/custom-telephony)
- [Retell browser voice integration](https://docs.retellai.com/deploy/web-call)
- [ACCC guidance for collectors and creditors](https://www.accc.gov.au/about-us/publications/guideline-on-debt-collection-for-collectors-and-creditors)
- [ACCC contact and frequency guidance](https://www.accc.gov.au/consumers/debt/what-debt-collectors-can-and-cant-do)
- [ACMA telemarketing and debt-collection distinction](https://www.acma.gov.au/say-no-to-telemarketers)
