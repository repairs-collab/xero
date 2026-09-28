# AccountPulse Operations Suite Design

**Date:** 2026-09-28

**Status:** Approved in conversation; awaiting written-spec review

**Scope:** Outbox, reminder whitelist, test SMS, escalation actions, and linked client/invoice views

## 1. Purpose

AccountPulse currently supports automated reminders, approval review, escalations, customer-level manual reminders, Inbox replies, and Xero invoice email. This change turns those separate capabilities into one coherent operational workflow:

- staff can see what AccountPulse has sent;
- administrators can safely test SMS delivery;
- staff can permanently exclude a client or one invoice from reminder chasing;
- escalations provide direct call and manual-SMS actions;
- client and invoice names consistently open useful detail pages.

The user selected the integrated-workflow approach. New controls belong in the existing Approvals, Escalations, Customers, Settings, and navigation surfaces instead of being placed in a separate administration application.

## 2. Confirmed product decisions

1. "Whitelist" means stop all current and future reminders. It does not mean bypass approval or send automatically.
2. A whitelist entry can cover one client or one invoice.
3. Adding an entry immediately cancels affected pending approvals, approved-but-unsent work, queued reminders, and matching open escalation tasks.
4. Provider-accepted messages cannot be recalled and remain visible in history.
5. Removing an entry immediately requests reminder recalculation. Any reminder that becomes eligible receives a fresh stage and approval; a previous approval is never reused.
6. Operators and Administrators can add whitelist entries. Only Administrators can remove entries and thereby restart chasing.
7. Calling uses the device's normal phone application through a `tel:` link.
8. Invoice viewing is an accurate AccountPulse view of synced Xero data. It does not need to imitate Xero's invoice screen.
9. Test SMS is Administrator-only and obeys the same live/dry-run and recipient-safety controls as other messages.
10. The AI-generated recovery-call script is deferred to a later release.

## 3. Navigation and user experience

### 3.1 Outbox

Add **Outbox** to the primary navigation immediately after Inbox.

The initial Outbox page shows newest activity first and supports:

- search by client name, invoice number, or recipient;
- filters for channel (`SMS`, `Xero email`), source, delivery status, and date;
- pagination using a stable created-time plus identifier cursor;
- a clear distinction between `Queued`, `Sending`, `Dry run`, `Accepted`, `Delivered`, `Failed`, `Unknown`, and `Cancelled`;
- recipient, client, invoice, source, actor, exact submitted content when retained, provider result, and timestamps;
- links to the client and invoice when those associations exist.

Sources are:

- automated reminder;
- manual reminder;
- escalation SMS;
- Inbox reply;
- test SMS;
- Xero invoice email.

For historical automated records whose exact content was not retained, the page says **Content was not retained for this historical message**. It must not reconstruct or present guessed content as the exact sent message. Existing Inbox replies retain their stored text. Every new SMS records the exact content submitted to Sinch or used by a dry run. Xero controls the email template and does not return its rendered body, so a Xero-email entry clearly records the invoice-email request rather than claiming to show the delivered email body.

### 3.2 Approvals

Each approval row gains:

- a linked client name;
- a linked invoice number;
- **Stop reminders for invoice**;
- **Stop reminders for client**.

The stop-reminders actions open a confirmation panel that identifies the scope, explains that the current approval and future reminders will be cancelled, and accepts an optional reason. The copy uses **Stop reminders**, with **Reminder Whitelist** as the management label, to avoid suggesting that the action permits sending.

### 3.3 Escalations

Each escalation card gains:

- linked client and invoice names;
- **Call client** when a usable telephone number exists;
- **Send SMS** with an editable preview and explicit confirmation;
- **Stop reminders for invoice**;
- **Stop reminders for client**.

Escalation SMS reuses the existing manual-invoice-reminder rules: the invoice must still be an outstanding authorised accounts-receivable invoice, the contact must have a usable and unsuppressed mobile number, and the message must include the current Xero payment link. The result is shown to the operator and appears in Outbox.

Selecting **Call client** records a best-effort `CALL_LINK_OPENED` audit event before opening the `tel:` target. This records that AccountPulse launched the dialler, not that a call connected or was completed.

### 3.4 Client and invoice views

Client names link to the existing `/customers/[customerId]` page throughout Approvals, Escalations, Outbox, and relevant activity views.

Add `/invoices/[invoiceId]` with:

- client, invoice number, type, status, issue date, due date, amount due, total, and currency;
- payment-link status and a Xero online-invoice link when available;
- current chasing/whitelist state;
- related outgoing-message history;
- a link back to the client.

Only fields already synced from Xero are displayed. Line items may be shown later if the Xero synchronisation model begins retaining them; this release does not invent or separately fetch unsupported invoice detail.

### 3.5 Reminder Whitelist settings

Add an Administrator-only Settings page with separate **Clients** and **Invoices** sections. Each section supports search and shows the reason, creator, and date added. Administrators can remove an active entry after a warning that eligible invoices will resume chasing immediately.

Operators do not receive Settings access. They add entries from Approvals and Escalations. Administrators can add from those same surfaces and manage removals in Settings.

### 3.6 Test SMS settings

Add an Administrator-only Test SMS panel under Settings with:

- destination phone number;
- editable message;
- GSM/Unicode segment count and configured-limit warning;
- explicit confirmation;
- result showing dry run, accepted, failed, or unknown.

The test send is intentionally not attached to a client or invoice. It still uses normal Australian-number validation/normalisation, suppression checks, live-mode acknowledgement, the technical live-recipient allowlist, idempotency, and Sinch delivery tracking. A number that is safe syntactically but not permitted for live sending produces a clearly labelled dry-run entry instead of a live SMS.

## 4. Data model

### 4.1 Reminder whitelist

Add a dedicated `reminder_whitelist_entries` table rather than overloading sequence exclusions, temporary pauses, suppressions, or the technical recipient allowlist.

Fields:

- `id`;
- `organisation_id`;
- `scope` (`CLIENT` or `INVOICE`);
- `contact_id`;
- nullable `invoice_id`;
- optional `reason`;
- `created_by_user_id`, `created_at`;
- `removed_by_user_id`, `removed_at`.

An entry is active when `removed_at` is null. Database constraints require a client target for every entry and an invoice target only for invoice scope. Partial unique indexes permit at most one active entry per client target and one active entry per invoice target within an organisation. Rows are retained after removal for history.

This table is separate from:

- `recipient_allowlist`, which controls whether an otherwise valid destination may receive a live provider request;
- `suppressions`, which represent channel consent/safety state;
- `pauses`, which are temporary operational holds;
- sequence exclusions, which belong to immutable sequence configuration.

### 4.2 Canonical outgoing-message record

Evolve `outbound_messages` into the canonical Outbox record for all new outgoing activity.

Add:

- `source` (`AUTOMATED_REMINDER`, `MANUAL_REMINDER`, `ESCALATION_SMS`, `INBOX_REPLY`, `TEST_SMS`, `XERO_EMAIL`);
- nullable `contact_id`, `invoice_id`, and `actor_user_id`;
- nullable `stage_instance_id` so non-reminder messages do not require fabricated reminder stages;
- nullable `source_version` for non-invoice messages;
- `content`, nullable only for migrated historical rows;
- optional `failure_reason`.

Keep the organisation-scoped idempotency-key uniqueness constraint and `message_attempts` provider history. New transport paths create or claim an `outbound_messages` record before provider submission. Existing reminder-stage sends continue to update their stage status. Non-stage sends update only their canonical message and any source workflow record.

The nullable stage foreign key uses `ON DELETE SET NULL`, preserving Outbox history if a stage is ever removed.

`operator_replies` remains the Inbox workflow record and gains a nullable, unique `outbound_message_id` link to its canonical outbound record. This preserves conversation behaviour while preventing Outbox from depending on a fragile union of unrelated status models.

The migration backfills associations and content only where existing relationships make the value reliable. Historical rows may remain source-classified with null content.

### 4.3 Indexes

Add organisation-scoped indexes for:

- active whitelist lookup by contact and invoice;
- Outbox recency and status;
- Outbox contact/invoice/source filtering;
- provider message lookup remains unique through `message_attempts`.

## 5. Service behaviour

### 5.1 Adding a whitelist entry

The service:

1. authorises `reminder-whitelist.add`;
2. validates that the client/invoice belongs to the session organisation;
3. obtains the same client/invoice send lock used by final send execution;
4. inserts the active entry idempotently;
5. expires affected `PENDING` or `APPROVED` approvals;
6. cancels affected reminder stages that have not been submitted to a provider;
7. cancels queued canonical messages that have not begun provider submission;
8. cancels matching open escalation tasks;
9. writes one audit event with affected-record counts.

Repeating the action for an already active target is a successful no-op that returns the existing entry. It must not create duplicate history or misleading cancellation counts.

### 5.2 Eligibility and final-send protection

Reminder calculation excludes an invoice when either its invoice entry or its client's entry is active. No approval, automated send, daily SMS, or escalation task is created for excluded work.

Final pre-send revalidation adds `REMINDER_WHITELISTED` as an explicit stop reason. Provider submission and whitelist mutation use a common organisation/contact/invoice locking order. This closes the race between the final check and submission: either the provider request was already claimed/submitted and cannot be recalled, or the new whitelist entry wins and the message is cancelled before submission.

Manual reminders from Customers or Escalations also consult the whitelist. A user may not manually bypass an active reminder whitelist from these reminder controls.

### 5.3 Removing a whitelist entry

The service:

1. authorises `reminder-whitelist.remove` (Administrator only);
2. locks and marks the entry removed with actor and time;
3. writes an audit event;
4. enqueues immediate reminder recalculation for the organisation.

The calculator evaluates current invoice state, due dates, disputes, promises, pauses, suppressions, and sequence rules. It creates fresh work only when currently eligible. Cancelled or expired approvals are never reactivated.

If a client-level entry and an invoice-level entry both cover an invoice, removing either one leaves the invoice excluded until both are inactive.

### 5.4 Manual and test SMS

Escalation SMS delegates to the existing manual-reminder domain/service path instead of duplicating message rendering or payment-link rules. Its source is recorded as `ESCALATION_SMS`.

Test SMS uses a dedicated queued worker job because provider credentials remain outside the web process. The web action validates and records the request with a page-generated idempotency token. The worker revalidates suppression and live-send controls immediately before submission, then records an attempt and final status in the canonical outgoing-message tables.

Retries use the same organisation-scoped idempotency key. An unknown provider outcome remains `UNKNOWN` and is not automatically resubmitted.

### 5.5 Delivery callbacks

Sinch delivery callbacks continue to find provider messages through `message_attempts` and update the canonical `outbound_messages` status. When the source is an Inbox reply, its workflow record is updated in the same transaction. Delivery history therefore remains consistent between Inbox and Outbox.

## 6. Authorisation

Add explicit permissions:

| Permission | Administrator | Operator |
| --- | --- | --- |
| `outbox.read` | Yes | Yes |
| `reminder-whitelist.add` | Yes | Yes |
| `reminder-whitelist.remove` | Yes | No |
| `message.test-sms` | Yes | No |

Existing `chase.operate` continues to govern manual escalation SMS and call-link actions. Every read and mutation includes the organisation identifier in its database predicate; a URL identifier alone never grants access.

## 7. Error handling and user feedback

- Missing or unusable phone number: disable the call/SMS action and explain why.
- Suppressed destination: block before queueing and show the suppression reason without exposing internal provider data.
- Missing payment link for a reminder SMS: block; do not send a link-free debt reminder.
- Technical allowlist or dry-run restriction: create a `DRY_RUN` Outbox result with an explicit explanation.
- Provider rejection: show `FAILED` with the safe failure category.
- Ambiguous provider response: show `UNKNOWN`, create the existing review task where applicable, and do not silently retry.
- Concurrent whitelist/add/send activity: resolve through shared locking and idempotent writes.
- Already paid or otherwise stale invoice: final validation cancels the send and records the reason.

No UI success state is shown until the server has durably recorded the action.

## 8. Audit events

Record at least:

- `REMINDER_WHITELIST_ADDED`;
- `REMINDER_WHITELIST_REMOVED`;
- `REMINDERS_CANCELLED_BY_WHITELIST`;
- `ESCALATION_SMS_QUEUED` and its resulting delivery state through message history;
- `TEST_SMS_QUEUED` and its resulting delivery state through message history;
- `CALL_LINK_OPENED`.

Audit payloads contain identifiers, scope, reason, affected counts, actor, and correlation identifiers. Message content is retained in the protected Outbox record but is not duplicated into broad audit payloads.

## 9. Testing strategy

Implementation follows test-first development.

### 9.1 Domain and repository tests

- active client and invoice lookup;
- overlapping client/invoice entries;
- add idempotency and partial unique constraints;
- organisation isolation;
- canonical outbound creation for stage and non-stage sources;
- idempotent send claims and provider-attempt state transitions;
- reliable historical backfill behaviour.

### 9.2 Service and integration tests

- adding a client entry cancels all matching pending/approved work and open escalations;
- adding an invoice entry affects only that invoice;
- already accepted/delivered records remain untouched;
- reminder calculation skips active entries;
- final pre-send revalidation blocks newly whitelisted work;
- the send/whitelist race cannot submit after the whitelist wins;
- removing an entry requires Administrator permission and queues recalculation;
- overlapping entries keep the invoice excluded;
- removal creates fresh approvals rather than reviving old ones;
- escalation SMS retains payment-link, suppression, segment, and live-send protections;
- test SMS is Administrator-only and reports dry-run/live outcomes;
- repeated submissions do not produce duplicate provider sends;
- callbacks update Outbox and Inbox reply state consistently.

### 9.3 Web tests

- Outbox filtering, pagination, status/source labels, and historical-content fallback;
- links from Approvals, Escalations, and Outbox are organisation-safe;
- whitelist confirmations describe immediate cancellation;
- Operators can add but not remove entries;
- only Administrators can access Settings whitelist removal and Test SMS;
- disabled call/SMS states explain missing contact data;
- invoice page shows only stored, accurate data.

### 9.4 Regression and release verification

All current unit and integration tests must continue passing, including approval staleness, escalation completion, daily SMS, payment-link enforcement, Xero refresh, recipient allowlist, suppression, Inbox replies, and delivery callbacks.

Before production completion:

1. run lint, typecheck, unit/integration tests, and build;
2. deploy through the existing pipeline;
3. verify login and organisation isolation;
4. verify Outbox with historical and new records;
5. add/remove a controlled whitelist entry and confirm cancellation/recalculation;
6. perform one controlled Test SMS and one manual escalation SMS using an allowed destination;
7. confirm Sinch callback status in Outbox and no duplicate sends.

Live SMS verification requires an approved technical allowlist destination and explicit production confirmation. Deployment alone does not authorise sending to an arbitrary number.

## 10. Out of scope

- AI-generated recovery-call scripts;
- proving that a dialled call connected or completed;
- recalling messages already accepted by Sinch or Xero;
- reproducing Xero's invoice UI;
- adding invoice line-item synchronisation;
- changing the approved reminder sequence timings;
- replacing the technical live-recipient allowlist, consent suppressions, disputes, promises, or temporary pauses.
