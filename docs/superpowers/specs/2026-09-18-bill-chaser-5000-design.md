# Bill Chaser 5000 Design Specification

**Date:** 18 September 2026  
**Status:** Approved design, pending written-spec review  
**Initial deployment:** One Xero organisation, hosted in AWS Sydney (`ap-southeast-2`)  
**Future direction:** Multi-organisation support through standard Xero OAuth without redesigning the business model

## 1. Purpose

Bill Chaser 5000 is an internal accounts-receivable application that synchronises outstanding sales invoices from Xero, schedules configurable reminder sequences, sends SMS through Sinch Engage, triggers invoice emails through Xero, receives customer replies, and gives a finance team one auditable place to manage approvals, disputes, pauses, and escalations.

The first release serves one Xero organisation through the existing **Bill Chaser 5000** Custom Connection. All organisation-owned records nevertheless carry an `organisation_id`, and provider authentication is isolated behind connector interfaces, so a later release can support multiple organisations through Xero's standard OAuth flow.

## 2. Goals and success criteria

The first release must:

1. Maintain a current local view of authorised Xero sales invoices with a positive balance.
2. Start every new reminder sequence in review-and-approve mode.
3. Allow an Admin to switch each sequence independently to automatic mode.
4. Support configurable per-sequence SMS aggregation: consolidated per customer or separate per invoice.
5. Send Xero invoice email and Sinch SMS stages without duplicate delivery.
6. Provide a two-way Sinch inbox and pause active chasing when a customer replies.
7. Create a manual escalation task at 30 days overdue while continuing configured daily SMS reminders in automatic sequences.
8. Stop or pause messages immediately on payment, void, reply, dispute, opt-out, or staff action according to the rules in this specification.
9. Provide Admin and Operator roles, searchable activity history, operational alerts, and an immutable audit trail.
10. Launch behind dry-run and recipient-allowlist controls before customer messaging is enabled.

Success for launch means the full reminder lifecycle passes automated tests and controlled-number trials, operators can explain why every reminder was or was not sent, and no duplicate reminder is produced when jobs or webhooks are replayed.

## 3. Scope

### Included

- Xero Custom Connection authentication and token caching.
- Xero organisation, invoice, contact, and online-invoice-link synchronisation.
- Xero invoice update webhooks and periodic reconciliation.
- Xero invoice-email triggering.
- Sinch Engage SMS submission, delivery reports, replies, and opt-out events.
- Signed webhook verification for Xero and Sinch.
- Configurable reminder sequences, review queues, automatic execution, and exclusions.
- Consolidated or per-invoice SMS behaviour per sequence.
- Shared two-way inbox with customer-level pause behaviour.
- Dispute, promise-to-pay, manual pause, resume, and close workflows.
- Escalation tasks and continuing daily SMS after 30 days overdue.
- Dashboard, customer timeline, sequence editor, approvals, inbox, tasks, activity, and settings.
- Admin and Operator roles.
- Australian-region hosting, encrypted storage, backups, audit logs, metrics, and alerts.

### Excluded from the first release

- Connecting more than one Xero organisation.
- Taking payments or storing card/bank credentials.
- Customising Xero invoice-email subject or body; Xero uses the organisation's default template.
- Sending email through a provider other than Xero.
- Automatic referral to debt collectors or legal services.
- AI-generated reminder copy.
- Native mobile applications.
- Customer self-service portal beyond Xero's online invoice page.

## 4. Product roles

### Admin

An Admin can invite or disable users, manage credentials and provider settings, create and edit sequences and templates, change a sequence between review and automatic mode, configure exclusions and retention, manage suppressions, enable production sending, view all audit records, and perform every Operator action.

### Operator

An Operator can review, edit, approve, reject, and send queued reminders; manage replies; record disputes and promises to pay; pause or resume chasing; complete escalation tasks; correct an approved contact number override; add notes; and view operational activity. Operators cannot change credentials, users, global safeguards, retention, or a sequence's automation mode.

Role enforcement occurs on the server. Hiding a control in the browser is not an authorisation mechanism.

## 5. Default reminder sequence

Every new sequence is created in `REVIEW` mode. An Admin can change it to `AUTOMATIC` after controlled testing.

| Timing | Action | Default copy intent |
| --- | --- | --- |
| Due date | Sinch SMS | Short reminder |
| 7 days overdue | Xero invoice email and Sinch SMS | Firm reminder |
| 21 days overdue | Sinch SMS | Final warning |
| 30 days overdue | Create escalation task and start daily Sinch SMS | Manual escalation plus continuing reminders |

For the post-30-day stage, the sequence specifies whether `daily` means calendar days or business days. The default is business days. Daily reminders continue until a stop or pause rule fires; completing the escalation task alone does not silently resume or stop messaging.

Each sequence also defines:

- Name, description, enabled state, and `REVIEW` or `AUTOMATIC` mode.
- Applicable invoice filters and minimum balance.
- Stage offset, channel, template, and permitted sending window.
- SMS strategy: `CONSOLIDATED_CUSTOMER` or `PER_INVOICE`.
- Business-day calendar and organisation time zone.
- Whether Xero email remains allowed after an SMS opt-out.
- Maximum provider attempts for transient failures.
- Exclusion rules for contacts, invoices, references, balances, and manually assigned tags.

Xero invoice email is always invoked per invoice. Consolidation applies only to SMS. A consolidated SMS contains the customer name, combined amount due, currency-aware invoice summary, and a compact list of Xero online-invoice links that fits within the configured message-segment limit. If the content would exceed that limit, the application splits it deterministically into numbered messages and shows the resulting segment count before approval.

## 6. Eligibility, stopping, and pause rules

An invoice is eligible only when all of the following are true:

- Xero type is `ACCREC`.
- Xero status is `AUTHORISED`.
- `AmountDue` is greater than zero.
- The contact is active.
- The invoice, customer, and sequence are not paused or excluded.
- The relevant channel has a usable recipient and is not suppressed.
- The stage has not already succeeded or been permanently skipped for the current invoice state.

The worker revalidates these conditions against the latest stored Xero state immediately before each external send. If the local record is older than five minutes, it refreshes the affected invoice from Xero before sending.

Stopping and pause behaviour is explicit:

- **Paid, voided, or deleted invoice:** cancel pending jobs and close chasing for that invoice.
- **Customer reply:** pause all active sequences for that customer and create an inbox item.
- **Dispute:** pause all active sequences for that customer until an Operator resolves the dispute.
- **Promise to pay:** pause the customer until the promised date plus the configured grace period, then re-evaluate balances.
- **Sinch opt-out:** permanently suppress SMS for the normalised recipient number until an Admin records a valid re-consent. Xero email continues only when the sequence allows it.
- **Manual pause:** staff select invoice, customer, or sequence scope and must enter a reason.
- **Missing or invalid contact data:** skip only the unusable channel and create a data-quality task.

Changing an invoice's balance, due date, contact, or status invalidates obsolete pending approvals and recalculates future stages.

## 7. Operator experience

### Overview

The home screen is action-first and displays:

- Total overdue amount and invoice count.
- Reminders awaiting approval.
- Paused customers requiring attention.
- Open 30-day escalation tasks.
- Invoices paid after at least one Bill Chaser 5000 reminder during the selected reporting period. This metric is labelled as temporal association, not proof that the reminder caused payment.
- Last successful Xero sync and provider-health indicators.

### Approvals

Operators can filter by stage, customer, amount, age, and channel; preview the exact destination and rendered content; see SMS segment count; edit permitted template fields; approve, reject, or snooze individually or in a safe bulk selection; and view why an item is eligible. Approval expires when material invoice or contact data changes.

### Inbox

The shared inbox groups messages by customer and number. Each conversation shows the related invoices, outbound reminders, delivery states, inbound replies, pause reason, notes, dispute or promise-to-pay status, assigned Operator, and available resume/close actions.

### Customer timeline

The timeline combines Xero invoice changes, approvals, sends, provider receipts, replies, opt-outs, disputes, promises, pauses, tasks, and staff notes in chronological order.

### Sequence editor

Admins can edit stages, channels, templates, SMS aggregation, calendar/business-day behaviour, permitted hours, exclusions, and review/automatic mode. The editor previews the next 30 days against current invoices before a rule change is activated.

### Activity and audit

The activity view supports search by customer, invoice, user, message, task, or correlation ID. Audit entries preserve actor, action, timestamp, affected entity, reason, and before/after values where settings changed.

## 8. External integrations

### Xero

The application uses the Custom Connection client-credentials grant against `https://identity.xero.com/connect/token`. Access tokens are cached until shortly before their 30-minute expiry and refreshed without user interaction. A Custom Connection is limited to one organisation and does not require the `xero-tenant-id` header.

Required scopes:

- `accounting.invoices` for reading invoices, retrieving online invoice URLs, and triggering invoice email.
- `accounting.contacts.read` for mobile numbers, email metadata, and contact status.
- `accounting.settings.read` for organisation identity, time zone, currency, and related settings.

The initial sync retrieves authorised `ACCREC` invoices with a positive amount due using optimised filters and pagination. Incremental reconciliation uses `If-Modified-Since`; invoice webhooks enqueue targeted refreshes. A 15-minute incremental reconciliation protects against delayed webhook delivery, and a nightly paginated reconciliation detects drift.

Before each SMS stage, the online invoice URL is fetched or refreshed for each included invoice. Xero invoice email is triggered with `POST /Invoices/{InvoiceID}/Email`; a `204` response is success. Xero controls the recipients, sender identity, subject, body, and attachment based on the organisation's invoice-email configuration. Bill Chaser 5000 records the request and outcome but does not claim access to downstream email delivery or opens. A Xero email `400` response is treated as a permanent operational failure because it can represent an invalid invoice state, an organisation restriction, or an email allowance restriction; it creates an Operator task and is not retried blindly.

The worker observes Xero concurrency, minute, and daily limits, records remaining-limit headers, and honours `Retry-After` on `429` responses. It separately counts Xero invoice-email requests to protect the organisation's email allowance.

### Sinch Engage

The application uses the APAC base URI `https://au.app.api.sinch.com` and HMAC authentication for outbound API calls. Messages are submitted to `POST /v1/messages` with:

- E.164 `destination_number`.
- Registered/default source number or sender ID.
- Rendered content.
- `delivery_report: true`.
- A callback URL where applicable.
- Metadata containing internal organisation, customer, invoice/group, sequence, stage, and attempt identifiers without embedding secrets.

Bill Chaser 5000 configures Sinch message webhooks for delivery-report states, `RECEIVED_SMS`, and `OPT_OUT_SMS`. Sinch secure callbacks are enabled with an RSA signature key. The receiver selects the stored public key by `X-MessageMedia-Key-Id`, verifies the signed request-line/date/body value, deduplicates events, persists the event, and acknowledges quickly before asynchronous processing.

Delivery state does not advance the reminder sequence by itself; stage timing remains policy-driven. Permanent rejection and failure states create an Operator task and may suppress the unusable number when the provider indicates an invalid destination.

## 9. Architecture

Bill Chaser 5000 is a modular TypeScript application deployed as two containers from one repository:

1. **Web/API service:** Next.js application serving the dashboard, authenticated API, and public webhook endpoints.
2. **Worker service:** Node.js process executing scheduled syncs, eligibility evaluation, reminder jobs, reconciliation, and retries.

Shared modules expose typed interfaces for Xero, Sinch, reminders, conversations, tasks, audit, identity, and persistence. Provider-specific code is behind connector interfaces so authentication can change without altering reminder policy.

PostgreSQL is the durable source for local state. A PostgreSQL-backed job queue provides transactional enqueueing, retries, schedules, and unique job keys without a separate Redis dependency. The web service never sends reminders directly; it records intent and enqueues work.

Production runs in AWS Sydney (`ap-southeast-2`) using:

- ECS Fargate for web and worker services.
- Application Load Balancer and AWS Certificate Manager for HTTPS.
- RDS PostgreSQL Multi-AZ with encrypted storage and automated backups.
- Amazon Cognito for invitation-only authentication, email/password sign-in, and required TOTP MFA.
- AWS Secrets Manager and KMS for Xero, Sinch, database, and webhook secrets.
- CloudWatch for structured logs, metrics, alarms, and dashboards.
- ECR for versioned container images.

All production application and database resources remain in the Sydney region. External provider calls necessarily transmit the minimum data required to Xero and Sinch.

## 10. Data model

Every organisation-owned table includes `organisation_id`. Primary records are:

- `organisations`: Xero identity, time zone, currency, send safeguards, sync cursors.
- `users`, `memberships`, `invitations`: identities and Admin/Operator roles.
- `provider_connections`: encrypted references and provider configuration, never raw secrets.
- `contacts`, `contact_channels`: Xero contact state, normalised numbers, approved overrides.
- `invoices`: Xero identifiers, status, dates, balances, currency, contact, online URL, sync version.
- `reminder_sequences`, `sequence_stages`, `sequence_exclusions`: policies and versioned configuration.
- `invoice_chases`, `stage_instances`: per-invoice/customer progress and calculated eligibility.
- `approvals`: rendered preview, source-data version, decision, actor, expiry.
- `outbound_messages`, `message_attempts`: channel, recipient, content hash, provider IDs, states, idempotency keys.
- `conversations`, `inbound_messages`: two-way SMS threads and replies.
- `suppressions`: number/channel, source, reason, recorded consent state.
- `pauses`, `disputes`, `payment_promises`: operational stop state.
- `tasks`: data-quality, delivery-failure, and escalation work.
- `webhook_events`: provider event ID/hash, signature result, receipt and processing state.
- `audit_events`: append-only actor and state-change records.

Money is stored as decimal values with an ISO currency code. Provider timestamps are stored in UTC; policy evaluation uses the organisation's IANA time zone. Phone numbers are normalised to E.164 while retaining the source value for audit.

## 11. Message and job state

Stage instances move through:

`CALCULATED → AWAITING_APPROVAL | SCHEDULED → QUEUED → SENDING → SENT → DELIVERED`

Alternative terminal or holding states are:

`REJECTED`, `SNOOZED`, `PAUSED`, `SKIPPED`, `CANCELLED`, and `FAILED_PERMANENT`.

Each outbound unit has an idempotency key derived from organisation, sequence version, stage instance, channel, recipient, and invoice/group version. A database uniqueness constraint is the final duplicate-send guard. Retries reuse the same outbound record and create new attempt records.

Safe read, token, and reconciliation operations retry transient network failures, `429`, and provider `5xx` responses with bounded exponential backoff and provider instructions. Validation, invalid recipient, unauthorised, and policy failures do not retry blindly; they create the relevant operational task. If an outbound SMS or Xero email request loses its connection after dispatch and the provider's acceptance is unknown, the attempt moves to `UNKNOWN` and is never resent automatically. When a provider message ID exists, the worker reconciles it through the provider status endpoint. Without a provider ID, an Operator must compare the provider portal, then explicitly mark the attempt sent, cancelled, or approved for resend; every decision is audited.

Webhook processing is idempotent. Receivers verify signatures, persist the raw-body hash and safe parsed fields, return within provider deadlines, and perform business updates asynchronously.

## 12. Security and privacy

- Accounts are invitation-only and require TOTP MFA.
- Admin and Operator permissions are enforced in service methods and database queries.
- Credentials are stored in Secrets Manager; application tables store secret references only.
- HTTPS is required for all traffic. Database connections require TLS.
- Xero HMAC webhook signatures and Sinch RSA secure-callback signatures are verified using the unmodified request body.
- Sensitive values and message bodies are excluded from standard logs. Correlation IDs and record IDs provide traceability.
- Production database and backups are encrypted with KMS keys.
- Message content and operational records are retained for 24 months after the related invoice is resolved by default; audit records are retained for seven years. Admins can shorten message-content retention without shortening the audit metadata needed to explain system actions.
- Backup retention is 35 days. Restore procedures are tested before launch and quarterly thereafter.
- Production sending has three independent controls: global dry-run/live mode, recipient allowlist, and per-sequence review/automatic mode.

## 13. Observability and operations

Structured events include organisation, correlation ID, provider, job, invoice/group, stage, and outcome without logging secrets or full message content. Operational dashboards track:

- Xero sync freshness and drift.
- Queue age and failed jobs.
- Reminders awaiting approval.
- Sends, delivery outcomes, and permanent failures by channel.
- Reply and opt-out volume.
- Open escalation and data-quality tasks.
- Xero and Sinch rate-limit headroom.
- Webhook signature failures and processing lag.

Alerts cover stale Xero sync, repeated authentication failures, queue backlog, webhook rejection spikes, send-failure spikes, low API headroom, and unavailable web/worker/database components.

## 14. Testing strategy

### Unit tests

- Eligibility, stage calculation, aggregation, message rendering, business/calendar-day rules, time zones, daylight saving, pause/stop precedence, role permissions, and idempotency-key generation.

### Integration tests

- PostgreSQL transactions and unique constraints.
- Xero token cache, pagination, incremental sync, email outcomes, online invoice links, limits, and error mapping through a deterministic fake server.
- Sinch HMAC request signing, submissions, delivery/reply/opt-out parsing, RSA callback verification, retries, and error mapping.
- Xero raw-body webhook signature verification, intent-to-receive behaviour, duplicate events, and event replay.

### End-to-end tests

- Review, edit, approve, send, delivery, reply, pause, resolve, and resume.
- Automatic sequences across all default stages.
- Consolidated and per-invoice SMS.
- Payment arriving immediately before send.
- Contact details changing after approval.
- Reply, dispute, promise-to-pay, opt-out, and manual pause.
- 30-day escalation task with continuing daily reminders.
- Provider timeout with unknown outcome, automatic-send suppression, and audited Operator reconciliation.
- Admin/Operator access boundaries and complete audit history.

### Controlled-provider validation

- Xero Demo Company validates authentication, synchronisation, filters, contacts, online invoice links, and webhooks. Demo organisations cannot send invoice email, so live email is validated using one approved low-value test invoice in the production organisation.
- Sinch testing uses allowlisted team-owned numbers first, validating message IDs, delivery reports, replies, opt-outs, and signed callbacks.
- Live customer sending remains disabled until the controlled-provider checklist is signed off by an Admin.

## 15. Deployment and launch

Environments are `development`, `staging`, and `production`, with separate databases, credentials, webhook URLs, and Cognito user pools. Infrastructure is declared as code and deployed through a reviewed CI/CD pipeline. Database migrations run as an explicit deployment step before new containers receive traffic.

Launch proceeds in order:

1. Deploy production in dry-run mode.
2. Connect Xero and verify organisation, scopes, sync, and webhook health.
3. Connect Sinch, enable secure callbacks, and verify signatures.
4. Allowlist staff numbers and exercise every reminder stage.
5. Validate one controlled Xero invoice-email request in the production organisation.
6. Reconcile dashboards, audit records, provider records, and Xero invoice state.
7. Enable live sending for a small approved customer cohort in review mode.
8. Expand review-mode coverage after operational review.
9. Permit Admins to activate automatic mode sequence by sequence.

Rollback disables live sending first, then stops workers from claiming new send jobs while preserving inbox and audit access.

## 16. Authoritative references

- [Xero Custom Connections](https://developer.xero.com/documentation/guides/oauth2/custom-connections/)
- [Xero OAuth scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Xero Invoices API](https://developer.xero.com/documentation/api/accounting/invoices)
- [Xero webhooks](https://developer.xero.com/documentation/guides/webhooks/overview/)
- [Xero API limits](https://developer.xero.com/documentation/guides/oauth2/limits/)
- [Sinch Engage API reference](https://developers.app.sinch.com/)
- [Sinch Engage developer guides](https://support.app.sinch.com/hc/en-us/categories/10516535548943-Sinch-Engage-Developer-Guides)
