# AccountPulse Independent Voice Reminder Sequences

**Date:** 9 October 2026
**Status:** Approved design, pending implementation-plan review

## Objective

Add on-demand automated calls to customer accounts and scheduled bulk voice reminders without coupling them to SMS and email scheduling. AccountPulse must place at most one consolidated call per customer for a due voice stage, retain an auditable link to every included invoice, and never enable customer voice calling as a side effect of deployment.

## User experience

### Sequence navigation

The Sequences area has two tabs:

- **SMS & Email Sequences** contains SMS, Xero email, escalation-task and daily-SMS actions.
- **Voice Reminder Sequences** contains only automated voice-call actions.

Each tab filters its own sequence type. Messaging and voice sequences have independent enabled states, modes, schedules and version histories. Disabling a voice sequence cannot pause or alter an SMS/email sequence, and disabling a messaging sequence cannot pause or alter a voice sequence.

The Voice tab provides:

- create, edit and activate voice sequences;
- Review or Automatic mode;
- enabled/disabled state;
- local send time and weekday calling window;
- one or more days-overdue stages;
- maximum calls per run;
- cooldown between completed call attempts;
- a preview describing the next run without placing calls.

Xero email and escalation tasks remain in the SMS & Email tab.

### Customer account action

The customer page exposes a prominent **Make automated call** button. It reuses the existing protected voice-call workflow:

1. AccountPulse evaluates the customer and invoices.
2. The user reviews the destination, included invoices, combined balance and call flow.
3. The user confirms the immutable facts.
4. AccountPulse queues one immediate call.

The action is customer-level, not repeated on every invoice card. It combines all currently eligible overdue invoices denominated in the organisation's supported currency.

### Review and automatic modes

For a voice sequence in **Review** mode, AccountPulse creates one pending voice approval per customer, stage and scheduled local date. The approval shows the customer, destination, included invoices, combined balance and scheduled time. Approval stores an immutable facts snapshot. An approved call waits until its scheduled time when approved early.

For a voice sequence in **Automatic** mode, AccountPulse creates the same immutable call snapshot and marks it scheduled without requiring an individual decision. Automatic dispatch additionally requires the organisation-level **Enable automatic voice calls** control. This control is independent of manual voice calling and independent of each voice sequence's enabled state.

Deployments and migrations never turn on automatic customer voice calls. Enabling them requires an explicit administrator action recorded in the audit log.

## Domain model

### Sequence classification

`reminder_sequences` gains a required kind:

- `MESSAGING` for existing sequences; and
- `VOICE` for voice-only sequences.

Existing production sequences migrate to `MESSAGING`. A version of a messaging sequence may contain `SMS`, `XERO_EMAIL`, `TASK` and `SMS_DAILY` stages. A version of a voice sequence may contain only `VOICE` stages. Validation rejects mixed sequence types.

Existing version scheduling fields remain the source of truth for local send time and calling window. Voice-only capacity settings are stored as validated version configuration:

- `maxCallsPerRun`, with a conservative default;
- `cooldownSeconds`, with a non-zero default; and
- the allowed currency list.

Activated versions remain immutable.

### Voice call source and audit links

Voice-call requests distinguish:

- `MANUAL` customer-page calls;
- `SEQUENCE_REVIEW` calls; and
- `SEQUENCE_AUTOMATIC` calls.

Scheduled voice calls retain the sequence ID, version ID, stage key, scheduled time and local occurrence date. Existing voice-call invoice snapshots remain the authoritative many-to-one link between a consolidated call and all included invoices.

The sequence-call idempotency key is derived from organisation, sequence version, stage key, customer, local occurrence date and currency. Recalculation therefore cannot create a duplicate call for the same customer occurrence.

Organisation voice settings gain an `automaticEnabled` flag defaulting to false. The existing voice enablement continues to control whether the organisation has a usable voice capability; the new flag separately authorises scheduled automatic dispatch.

## Calculation and grouping

Messaging sequence calculation continues unchanged.

Voice sequence calculation runs through a dedicated customer-level service:

1. Find active voice sequences and their active versions.
2. Determine which overdue stage is current for each active invoice chase.
3. Apply invoice and customer eligibility rules.
4. Group eligible invoices by organisation, sequence version, stage, customer, local occurrence date and currency.
5. Build one consolidated immutable voice snapshot for each group.
6. Upsert one voice-call request using the deterministic idempotency key.

When several invoices for one customer reach the same stage on the same date, they produce one call. If one invoice triggers the stage while other invoices on the same active voice sequence are already overdue and eligible, the call may include those invoices so the customer hears a complete current account balance. An invoice cannot appear twice in a call snapshot.

Review-mode requests remain `DRAFT` until approved or rejected. Approved review requests and automatic requests remain `APPROVED` until dispatch time.

## Dispatch and server protection

Voice dispatch is separate from the SMS/email dispatcher. It selects due approved calls in scheduled order and enforces all of the following:

- the voice sequence and its active version are still enabled;
- automatic requests require `automaticEnabled=true`;
- the customer voice gateway acceptance gate is enabled;
- there is no organisation call already in flight;
- the run has not reached `maxCallsPerRun`;
- the configured cooldown has elapsed;
- the current time is within the weekday calling window; and
- the call passes fresh pre-call eligibility and immutable-facts validation.

Only one call per organisation is submitted at a time. The dispatcher does not pre-queue an entire batch with the provider. A later scheduler tick submits the next due call after the previous call is terminal and the cooldown has elapsed. This keeps load predictable and prevents several customers from transferring to the office simultaneously.

Provider `UNKNOWN` outcomes are reconciled before any retry. AccountPulse never retries an uncertain call blindly.

## Eligibility and failure handling

Manual and sequence calls use one shared voice preparation and policy service. It enforces:

- valid callable destination;
- voice suppression and wrong-person suppression;
- customer and invoice whitelist entries;
- open disputes;
- active promises to pay;
- customer, invoice and sequence pauses;
- active authorised accounts-receivable invoices with a positive balance;
- supported currency;
- fresh reconciled Xero data;
- call-frequency limits; and
- permitted local calling hours and holidays.

The dispatcher revalidates immediately before submission. If facts changed, the call is not placed:

- paid, voided, paused, disputed, promised, whitelisted or suppressed accounts are cancelled safely;
- missing or invalid phone details create a `VOICE_CONTACT_REVIEW` task;
- stale or materially changed invoice facts expire the approval and require a fresh snapshot;
- a closed calling window reschedules to the next permitted time;
- provider rejection records a safe failure; and
- an uncertain provider outcome enters reconciliation.

Blocked and failed calls appear in customer activity and operational review without storing private provider payloads.

## Approvals and visibility

The Approvals page includes pending sequence voice calls alongside message approvals, clearly labelled **Voice call**. Approval and rejection operate on the voice-call request, not on an arbitrary representative invoice.

Customer activity records preparation, approval, queueing, answer, menu outcome, voicemail, transfer, completion and safe failure events. Each scheduled entry identifies its source sequence and stage. The existing call history remains the operational record; SMS/email Outbox behaviour is unchanged.

## Permissions and activation

- Admins manage sequence definitions and automatic voice activation.
- Operators may approve review-mode calls and place manual calls when their existing permissions allow it.
- Activating or disabling a voice sequence, changing mode, and enabling automatic voice calls all create audit events.
- Automatic voice activation uses an explicit typed confirmation and is never enabled by a deployment, migration or data reset.

## Deployment and rollout

The database migration adds the new fields with safe defaults: existing sequences become `MESSAGING`, existing calls become `MANUAL`, and automatic voice remains disabled.

Deployment order is:

1. migrate schema with safe defaults;
2. deploy shared voice preparation and sequence calculation;
3. deploy the two-tab sequence UI and approval integration;
4. verify existing SMS/email behaviour remains Customer live;
5. keep customer voice dispatch disabled;
6. run a controlled staff-number batch using fictional invoice facts;
7. request explicit approval before enabling automatic customer voice calls.

Rollback disables automatic voice dispatch and voice sequences without changing SMS/email mode or customer-live status.

## Verification

Automated verification must cover:

- existing sequences migrate and render as Messaging;
- the two tabs filter and manage independent sequence types;
- validation rejects messaging actions in Voice sequences and Voice actions in Messaging sequences;
- manual customer action produces one reviewed consolidated call;
- multiple invoices for one customer produce one sequence call;
- deterministic recalculation does not duplicate a call;
- Review mode creates one pending approval and respects approve/reject;
- Automatic mode does not dispatch while automatic voice is disabled;
- voice scheduling and disabling do not affect SMS/email calculation or dispatch;
- capacity, one-call-at-a-time and cooldown controls prevent overlapping submissions;
- pre-call changes cancel, expire or reschedule safely;
- provider-unknown outcomes do not cause blind retries; and
- production verification confirms SMS/email remains `live | CUSTOMER`, the voice acceptance gate remains off, and no active call channels remain after testing.

## Out of scope

- Enabling customer voice calls during deployment;
- an option-3 payment flow or Stripe payment processing;
- simultaneous calls for one organisation;
- customer-defined voice scripts;
- per-invoice calls from one voice-stage occurrence;
- replacing VoIPcloud, Piper or the approved fixed call flow; and
- changes to SMS allocations, Xero email delivery or existing customer-live messaging.

## Candidate future payment upgrade

A later release may add a call-menu option 3 for payment in full. The recommended design is to create a short-lived Stripe Checkout Session for the exact current balance, send its Stripe-hosted URL to the customer's verified mobile number by SMS, and confirm the result from signed Stripe webhook events before triggering a Xero refresh.

AccountPulse, Asterisk, call recordings and staff must never receive, record or store the card number, expiry or security code. Collecting card data through voice or DTMF would require a separately assessed PCI-compliant telephone-payment environment and is not part of this release.
