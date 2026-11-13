# AccountPulse Solo Xero App Store Release Design

**Date:** 2026-11-09

**Status:** Approved for implementation

**Release:** AccountPulse Solo, Australia

> **Commercial-rule update — 13 November 2026:** The 12 November hard-cap rule
> is superseded. Solo now includes 1,000 outbound SMS parts per monthly allowance
> period, followed by metered overage at A$0.11 per additional outbound SMS part
> excluding GST. Unused included parts and overage do not roll over. Legacy
> overage fields do not by themselves authorise sending; the signed billing and
> current entitlement controls remain authoritative.
>
> **Commercial-rule update — 12 November 2026:** The public free-trial proposal
> below is also superseded. The owner selected payment on signup, monthly and
> annual billing with a 5% annual discount, cancellation at period end, no SMS
> rollover, a 30-day failed-payment recovery period and five-year
> post-cancellation retention. Annual customers still receive a monthly 1,000
> SMS-part allowance cycle. Any manually granted beta access is a controlled
> beta licence, not a public free trial.

## 1. Intent

Turn the existing internal AccountPulse installation into a self-service Australian software product that can be certified and listed in the Xero App Store.

The customer promise is simple: a Xero subscriber selects **Get this app**, connects one Xero organisation, subscribes, completes guided onboarding, and begins chasing outstanding invoices without AccountPulse staff handling credentials or editing infrastructure.

The first commercial product is intentionally narrow:

- one Xero organisation;
- one primary AccountPulse user;
- Australian customers and Australian mobile destinations;
- 1,000 included SMS parts per billing month;
- one dedicated Australian reply number;
- the existing Xero email, approval, sequencing, Inbox, Outbox, whitelist, escalation, audit, and reporting capabilities;
- $299 AUD per month excluding GST;
- A$0.11 excluding GST for each additional outbound SMS part, with no rollover.

AccountPulse production web, worker, PostgreSQL, queue, backups, monitoring and platform secrets run on OVH. Cognito remains the only AWS runtime dependency. The repository's historical AWS deployment code is not the source of truth for the commercial product; Phase 0 establishes and verifies the OVH deployment pipeline before customer-product work.

The primary success measure is not merely accepting payment. Success means ten real Australian beta organisations can independently connect Xero, reconcile their data, preview and send reminders, receive replies, understand their SMS usage, manage their subscription, and obtain support. That evidence then supports Xero certification and the public App Store listing.

## 2. Current position

AccountPulse already has several strong foundations:

- organisation IDs on operational records;
- membership and role checks;
- audited reminder decisions;
- review and automatic sequence modes;
- final pre-send invoice revalidation;
- Xero rate-limit handling and reconciliation;
- two-way SMS, opt-out suppression, Inbox and Outbox;
- user invitation support;
- a production installation used by Motts Appliance Repairs.

The existing release was deliberately built for one Xero organisation using a Custom Connection. The Xero token is obtained with the client-credentials grant, Xero requests omit a tenant header, provider configuration is represented as AWS secret references, the user is bootstrapped manually, and there is no subscription or entitlement model. Those are appropriate for the existing bespoke installation but not for an App Store product.

The owner has confirmed the commercial identity inputs used by the build:
**Swan Hill Appliance Repairs Pty Ltd** (ABN 86 633 952 333; ACN 633 952 333)
is the GST-registered legal seller and owner of AccountPulse,
`ap@motts.com.au` is the public support, billing, privacy and legal-notice
address, Australia is the initial market, AUD is the customer currency, and
`https://ap.motts.com.au` is the intended public AccountPulse origin. These
confirmations do not by themselves prove DNS, HTTPS, mailbox operations or
Xero portal registration; those remain release-readiness checks.

## 3. Chosen approach

### Approach A — Fast-track AccountPulse Solo, then expand (selected)

Build the minimum complete commercial product around the current application: standard Xero OAuth, one organisation per subscription, Stripe billing, SMS allowance accounting, guided onboarding, customer-facing legal/support surfaces, beta evidence, certification, and listing.

This approach reuses the mature reminder engine and limits new commercial risk. Enterprise, New Zealand and native mobile apps follow after the Australian Solo release proves demand.

### Approach B — Complete the full product family before certification

Build Solo and Enterprise, Australia and New Zealand messaging, multi-organisation switching, native apps, and wholesale-provider migration before submitting to Xero.

This creates a broader launch but delays certification and introduces too many simultaneous variables into billing, compliance, identity, messaging and support.

### Approach C — Publish a listing around the existing Custom Connection

This is not viable. A Custom Connection can only connect one organisation, the current onboarding is not self-service, and it does not provide the standard customer-authorised OAuth connection expected for a public Xero app.

## 4. Product and commercial rules

### 4.1 AccountPulse Solo

The initial plan continues to use the legacy stable code `SOLO_AU_2000` as an
opaque Stripe/database identifier. It is not customer-facing and does not
describe the current allowance.

| Entitlement | Included value |
| --- | --- |
| Price | $299 AUD/month excluding GST |
| Xero organisations | 1 |
| Active users | 1 primary Administrator |
| SMS allowance | 1,000 outbound SMS parts per monthly allowance period |
| SMS reply number | 1 dedicated Australian number |
| Inbound SMS | Included |
| Xero invoice email | Included, subject to Xero limits |
| Reminder sequences | Included |
| Approval, Inbox, Outbox and escalation workflows | Included |
| SMS overage | A$0.11 excluding GST per additional outbound SMS part |

An SMS allowance is always described as **SMS parts**, not messages. AccountPulse calculates GSM-7 or Unicode parts before queueing and again before provider submission. The user sees the number of parts in every preview and the pricing/usage screens.

At 80% of the included allowance, AccountPulse shows in-app and email warnings.
After the included allowance is exhausted, eligible outbound parts are recorded
as metered overage at A$0.11 each excluding GST. A current billing entitlement
and payment method are required; a billing hold or failed payment blocks new
provider submissions. Unused included parts and overage do not roll over.

### 4.2 Signup and beta access

The commercial release has no public free trial. The first card payment is due
on signup and only a signed Stripe payment event activates paid access. A
manually granted invitation-only beta licence may be used for controlled
testing, but it is not advertised as a customer trial and never bypasses
tenant, legal-acceptance or sending controls.

### 4.3 Billing states

AccountPulse uses its own Stripe account. Xero App Store subscription billing is not used because Xero deprecated that facility and directs new apps to their own billing system.

Supported internal subscription states are:

- `TRIALING`;
- `ACTIVE`;
- `PAST_DUE`;
- `CANCEL_AT_PERIOD_END`;
- `CANCELLED`;
- `INCOMPLETE`.

The Stripe adapter maps Stripe's external states explicitly. `trialing` maps to `TRIALING`; `active` maps to `ACTIVE`; `past_due` and `unpaid` map to `PAST_DUE`; a scheduled cancellation maps to `CANCEL_AT_PERIOD_END`; `canceled`, `paused`, and `incomplete_expired` map to `CANCELLED`; and incomplete checkout/payment states map to `INCOMPLETE`. Any new Stripe status is fail-closed until deliberately mapped.

Stripe webhooks are the source of truth for payment state. Webhook processing is signed, idempotent and auditable. A checkout success redirect never activates entitlements by itself.

Stripe billing uses one recurring base-price item plus a metered overage item
for committed outbound SMS parts above 1,000 in each monthly allowance period.
The overage rate is A$0.11 per additional part excluding GST. Usage is reported
idempotently from the committed SMS ledger; reserved, cancelled and failed-
before-provider parts are not billed.

On payment failure, new provider submissions pause immediately while the
customer retains read-only access and a 30-day billing recovery period.
Cancellation pauses all future sequence work immediately, even when paid
access continues to the end of the billing period. This avoids contacting
debtors after the business has chosen to stop the service. The customer can
explicitly resume before the effective cancellation date.

### 4.4 Existing Motts organisation

The current Motts production organisation is migrated without resetting data or changing live/review sequence choices. It receives an `INTERNAL_LEGACY` entitlement that is not billed through Stripe and is not subject to the Solo user or SMS allowance. This migration must not revert Motts to dry-run or a status below its current customer-live state.

## 5. Customer journey

### 5.1 Xero App Store acquisition

1. The customer selects **Get this app** on the AccountPulse listing.
2. Xero redirects the customer to AccountPulse's Xero sign-up URL.
3. AccountPulse opens Cognito's hosted self-signup/login flow and returns the verified customer identity to onboarding. This avoids storing Cognito administration credentials on the OVH application host.
4. AccountPulse starts the standard Xero authorisation-code flow with a single-use state value, the minimum scopes, and the verified Cognito subject bound to the transaction.
5. The customer authorises one Xero organisation.
6. AccountPulse validates the returned connection and creates the trial organisation, primary Administrator membership, Xero connection and initial-sync request idempotently using the Cognito subject, Xero authentication event and tenant ID.
7. AccountPulse starts the initial Xero sync and opens the onboarding checklist.

The release retains Cognito as the AccountPulse authentication authority. Xero performs organisation connection authorisation; it does not replace AccountPulse sessions in this release. Sign In with Xero can be added later without changing tenant or subscription ownership.

The Cognito-first flow is an application-security choice, not a waiver of Xero listing obligations. The published commercial terms currently require Sign Up with Xero even though newer guidance describes it as optional. Public submission therefore requires either a supported Sign Up with Xero entry that preserves the no-silent-linking rule, or written Xero confirmation that AccountPulse is exempt.

An existing AccountPulse email is never silently attached to a newly authorised Xero tenant. Linking an existing identity requires the user to authenticate to AccountPulse first and complete an explicit connection flow. Solo permits one active AccountPulse organisation per user identity. Attempts to connect another tenant show the existing organisation and the Enterprise waitlist; multi-organisation ownership and switching are deferred.

### 5.2 Onboarding checklist

The checklist has the following ordered steps:

1. Xero organisation connected and name displayed.
2. Initial invoice and contact sync reconciled against Xero totals.
3. Business and support contact details confirmed.
4. Administrator mobile verified.
5. Default reminder sequence reviewed.
6. Reminder previews reviewed, including recipient, payment link and SMS parts.
7. Trial test SMS delivered to the Administrator.
8. Subscription activated.
9. Dedicated number provisioned and reply path verified.
10. Customer-live sending enabled in Review mode with an explicit acknowledgement.

Automatic sequence mode is never enabled by subscription or onboarding. Each sequence must be switched from Review to Automatic by the customer after they have observed its approvals. Manual escalation remains manual.

Administrator mobile verification uses a platform-funded OTP to an Australian mobile number. The code expires after ten minutes and is limited to five attempts. OTP sends do not consume the organisation's SMS allowance and use a separate abuse-controlled provider path.

### 5.3 In-product billing and usage

Settings gains a Billing and usage page showing:

- plan and price;
- subscription state and renewal date;
- included, used, pending and remaining SMS parts;
- overage state, rate and cap;
- dedicated number and provisioning state;
- Stripe billing-portal link;
- invoices and payment method through the Stripe portal;
- cancellation and data-retention consequences.

The main navigation shows a non-blocking usage indicator after 80% and a blocking banner when new sends are paused.

## 6. Xero connection architecture

### 6.1 OAuth scopes

The product requests only:

- `openid`;
- `profile`;
- `email`;
- `offline_access`;
- `accounting.invoices`;
- `accounting.contacts.read`;
- `accounting.settings.read`.

`accounting.invoices` is required because AccountPulse both reads invoices and asks Xero to email an invoice. AccountPulse does not request payments, bank transactions, reports, payroll, journals or practice scopes.

### 6.2 Token and tenant model

Replace the one-secret-per-organisation assumption with two explicit concepts:

- `xero_authorisations`: one row for a Xero user authorisation, containing the Xero user ID, encrypted rotating refresh token, access-token expiry, granted scopes, connection status and timestamps;
- `xero_connections`: one row mapping a Xero tenant ID to one AccountPulse organisation and its current authorisation.

Refresh tokens are encrypted at the application boundary with an active key supplied to the OVH runtime through its secret mechanism. Plain refresh or access tokens are never written to logs, audit JSON, browser responses or database fields. Access tokens are memory-only. The database stores the encrypted rotating refresh token, granted scopes and refresh metadata. Token refresh uses a database lock and atomic rotation so concurrent workers cannot invalidate each other.

Every Accounting API request receives the AccountPulse organisation ID, resolves the active Xero connection, obtains a user access token, and sends the corresponding `Xero-Tenant-Id` header. Queue payloads continue carrying the AccountPulse organisation ID rather than secrets or Xero tokens.

The Xero settings screen becomes customer-facing. It displays connected organisation, connection time, latest successful sync and granted scopes, and offers **Reconnect** and **Disconnect**. It no longer displays or accepts AWS secret references.

The public product uses a new standard-OAuth Xero app registration named AccountPulse. The existing Bill Chaser 5000 Custom Connection remains only as a migration source for the Motts organisation and is never offered to commercial customers.

Disconnecting Xero immediately pauses all new reminder work, revokes/deletes the Xero connection where possible, preserves required audit history, and explains the effect on the subscription. A different Xero organisation cannot replace the existing one without an explicit destructive migration flow; Solo supports one tenant per subscription.

### 6.3 Webhooks

Xero webhooks are app-level. Incoming events are verified before parsing, resolved to the correct organisation by Xero tenant ID, deduplicated, and queued with that organisation ID. An unknown tenant is rejected from business processing and recorded without customer data.

## 7. Tenant isolation and authorisation

Every customer-owned table remains organisation-scoped. New subscription, usage, Xero connection, onboarding and SMS-number records also carry an organisation ID or an unambiguous foreign key to one.

The release adds automated cross-tenant tests that attempt to read or mutate customers, invoices, messages, sequences, billing records, Xero connections and provider callbacks using another organisation's identifiers. All must fail without revealing whether the target record exists.

Solo allows one active membership. Existing invitation screens show the plan limit and an Enterprise waitlist rather than allowing a second active user. The underlying membership design is retained so Enterprise can be added without a rewrite.

Support access is not implemented as a hidden superuser. Any future support impersonation requires a separate audited design. Operational staff may inspect redacted telemetry but cannot browse customer receivables through production application sessions.

## 8. SMS provider and allowance architecture

AccountPulse owns the SMS relationship; subscribers do not enter their own provider keys.

The current Sinch transport becomes an implementation of a provider-neutral interface covering:

- submit SMS with an idempotency key;
- delivery status;
- inbound reply verification and parsing;
- sender-number assignment;
- health check;
- provider message reconciliation.

The provider-specific identifier remains on message attempts, but customer workflows and allowance accounting use the generic `SMS` channel. A provider can later be replaced without changing approvals, sequences, Inbox, Outbox or billing.

The Australian beta uses the existing Sinch adapter behind the provider-neutral interface. AccountPulse assigns each paid tenant a number idempotently from a pre-provisioned AccountPulse Sinch number pool. A signed Sinch partner agreement meeting the commercial, data-handling and support requirements is a public-release gate. Cellcast remains the fallback adapter if that agreement is not achieved before the commercial foundation is released.

Each paid organisation has one dedicated numeric Australian number. Numeric numbers support replies and avoid relying on alphanumeric sender IDs. The inbound resolver maps the provider destination number to exactly one AccountPulse organisation before resolving the debtor's mobile number and conversation.

SMS allowance is an append-only ledger. A reservation is created when a send is claimed, final parts are recorded when the provider accepts it, and reservations are released for pre-dispatch cancellation. Unknown outcomes remain reserved until reconciliation. Delivery failure after provider acceptance is still billable when the provider charged AccountPulse. Automated reminders, manual reminders, escalation messages, Inbox replies and customer test sends all consume allowance. Inbound replies and platform-funded verification OTPs do not.

## 9. Data model additions

The implementation plan will define exact migrations, but the design requires these concepts:

- `plans` or code-owned plan definitions with stable plan codes;
- `subscriptions` with Stripe identifiers, status and billing period;
- `subscription_events` for idempotent Stripe webhook handling;
- `sms_usage_ledger` with reservations, committed parts, reversals and source-message references;
- `xero_authorisations` with encrypted token material and rotation metadata;
- `xero_connections` mapping Xero tenants to AccountPulse organisations;
- `organisation_onboarding` with versioned checklist state;
- `sms_number_assignments` with provider, number, subaccount/reference and provisioning state;
- organisation business, billing and support contact fields required for commercial operation.

Provider credentials and encryption master keys are platform secrets, not organisation records containing AWS ARNs.

## 10. Customer safety, privacy and lifecycle

Commercial release retains the safety properties that protect both AccountPulse customers and their debtors:

- new organisations begin in preview/review, not automatic mode;
- paid status alone cannot trigger queued historical reminders;
- provider submission revalidates Xero invoice state, suppression, pause, whitelist, phone number, subscription entitlement, SMS allowance and number readiness;
- all provider operations remain idempotent;
- replies pause customer-level chasing according to the existing rules;
- STOP and equivalent opt-outs remain enforced across all workflows;
- payment links come from the current Xero online-invoice URL;
- exact submitted SMS content and part count are visible in Outbox;
- account deletion and Xero disconnect have documented retention behaviour.

When an unconverted trial expires, or a cancelled subscription reaches its effective end, AccountPulse deletes the connection through Xero's connection API and records the local connection as disconnected. It does not rely on access- or refresh-token expiry. Revocation initiated from Xero is detected, fails closed and offers an explicit reconnect path.

Before beta, AccountPulse publishes an Australian privacy policy, terms of service, acceptable-use/SMS policy, data-retention statement, subprocessors list, support policy, security contact and incident-notification process. These documents require Australian legal review before public listing. The retention statement must include an explicit record-by-record matrix for operational data, message content, audit records, billing records, Xero tokens and backups; implementation must not guess what survives deletion.

Before Phase 3 live billing, the owner supplies the legal billing entity, ABN and GST status, support email, business address, refund policy and customer-facing tax treatment. These are deployment configuration and legal-content inputs rather than hard-coded product values.

## 11. Xero certification and listing work

### 11.1 Certification evidence

The certification pack records evidence for:

- standard OAuth connection with `offline_access`;
- minimum granular scopes;
- connected Xero organisation name displayed;
- connect, reconnect and disconnect behaviour;
- no tokens or secrets in client-side code;
- correct `Xero-Tenant-Id` use;
- 401, 403, 404, 429 and 5xx handling;
- token refresh rotation and revoked connection handling;
- Xero rate-limit compliance;
- multi-organisation isolation even though Solo exposes one organisation per subscription;
- initial and incremental sync accuracy;
- webhook signature, tenant routing and replay protection;
- launcher login URL;
- ten beta customers and their consented certification references;
- public privacy, terms, support and pricing pages.

### 11.2 Listing package

Prepare in the Xero Developer Centre:

- unique app name **AccountPulse**;
- concise value proposition focused on accounts-receivable reminders;
- supported region: Australia;
- $299 AUD/month excluding GST, monthly or annual billing and no free trial;
- accurate description of 1,000 included monthly SMS parts, A$0.11 excluding
  GST per additional outbound SMS part and no rollover;
- AccountPulse logo and approved screenshots;
- onboarding/support URL, privacy URL and terms URL;
- launcher login URL;
- support email and response expectations;
- app categories and search terms;
- beta customer references;
- optional short product video after the final interface is stable.

AccountPulse reads invoices, contacts and organisation settings but creates no Xero accounting transactions. Account-code and tax-rate mapping are therefore marked not applicable in certification with this use-case justification rather than left unanswered.

AccountPulse remains the dominant brand. Xero logos/buttons use official supplied assets and Xero is not used in the product or domain name.

### 11.3 Xero plan sequence

1. Develop and test with the Starter tier for up to five connections.
2. Move to Core at $35 AUD/month excluding GST for up to 50 connections and onboard the beta cohort.
3. After at least ten successful beta customers and completed evidence, apply for certification and Plus.
4. Plus is currently $245 AUD/month excluding GST and supports up to 1,000 connections; submit the App Store listing when certified.

Xero fees, connection limits and API usage are measured separately for each Xero app. Future products may reuse AccountPulse's internal libraries and certification templates, but they cannot share a Xero app registration, connection allowance, certification decision or listing.

## 12. Reusable foundation for future Xero apps

AccountPulse keeps clean internal boundaries so future products can reuse proven code, but extracting and publishing a general-purpose framework is not a Solo release deliverable. The separate Xero developer-status and research workstream owns the generic certification playbook.

The commercialisation work is divided into focused packages rather than being embedded in AccountPulse screens:

- Xero OAuth transaction, callback, encrypted token rotation and tenant-selection library;
- Xero connection repository and tenant-aware client factory;
- organisation provisioning service;
- Stripe subscription and signed-webhook library;
- entitlement and usage-ledger library;
- onboarding-checklist framework;
- legal/support page templates with app-specific content;
- certification evidence checklist and test harness;
- App Store listing asset checklist.

Reuse does not mean sharing customer data or credentials across products. Every future app receives separate Xero client credentials, redirect URLs, plan billing, token namespace, privacy disclosures, scopes, certification evidence and App Store listing.

The standing Xero App Store checklist for future apps is:

1. Define one clear customer problem and the minimum necessary Xero scopes.
2. Register a unique Xero OAuth app and configure HTTPS redirect and launcher URLs.
3. Implement standard OAuth, `offline_access`, secure rotating token storage, tenant headers, reconnect and disconnect.
4. Isolate every customer record by tenant and test cross-tenant denial.
5. Handle Xero limits and provider errors without duplicate writes or sends.
6. Publish product pricing, privacy, terms, support and data lifecycle.
7. Use an independent billing system and signed billing webhooks.
8. Onboard real beta customers on Core and collect evidence.
9. Complete certification and move to Plus or above.
10. Build and submit accurate listing assets, then maintain the integration and listing after release.

## 13. Delivery phases and implementation-plan boundaries

The architecture is divided into three reviewable implementation sections plus one operational certification checklist. The owner has requested that customer OAuth, subscriptions and self-service onboarding now be delivered and acceptance-tested as one commercial-foundation program. Each section must leave a working, testable increment and preserve Motts production operation, but the release is not customer-ready until all three sections pass the combined end-to-end journey.

### Phase 0 — OVH production baseline

Document and verify the actual OVH web, worker, PostgreSQL, queue, backup, monitoring, deployment and rollback paths. Remove AWS deployment assumptions from active runtime configuration while retaining Cognito. No customer-product work is deployed until this baseline has recovery and secret-rotation evidence.

### Implementation plan 1 — OVH deployment and Xero OAuth foundation

Standard OAuth, encrypted rotating tokens, tenant-aware Xero client, self-service connection management, Motts legacy migration and cross-tenant tests.

### Implementation plan 2 — Stripe, SMS allowance and dedicated-number tenancy

Stripe checkout/portal/webhooks, subscription entitlements with payment due on signup, a 1,000-part monthly SMS ledger, idempotent metered overage billing and a provider-neutral SMS boundary.

### Implementation plan 3 — Customer onboarding and beta readiness

Xero sign-up entry, guided checklist, billing/usage interface, paid-access restrictions, plan-limit UI, support and legal pages, lifecycle emails and operational administration.

### Operational checklist — Beta, certification and listing

Production beta environment, provider commercial agreement, ten beta organisations, reconciliation and support evidence, certification pack, listing copy/assets, Plus upgrade and Xero submission.

Each phase must leave the existing Motts installation operating. Database changes are additive and forward-compatible until the new OAuth path has been proven. The Custom Connection is removed only after Motts has a tested standard OAuth connection or an explicitly supported legacy path.

## 14. Non-goals for the Solo App Store release

- Enterprise multi-user subscriptions;
- multiple Xero organisations in one subscription;
- New Zealand or other international SMS;
- native iOS or Android apps;
- voice-call reminder subscriptions or IVR payment collection;
- alphanumeric SMS sender IDs;
- Xero practice APIs, journals, payroll or bulk connections;
- Xero App Store subscription billing;
- automatic migration to a different SMS provider without a commercial agreement and production pilot.

## 15. Release gates

The public listing is not submitted until all of the following are true:

- automated unit, integration and browser suites pass;
- independent tenant-isolation and OAuth security review passes;
- Motts production operation is unchanged or deliberately migrated with evidence;
- Stripe test and live webhook paths are reconciled;
- SMS usage totals match provider billing for a complete beta billing period;
- dedicated-number replies route to the correct beta tenant;
- no trial or unpaid organisation can send customer-live SMS;
- support, privacy, terms and retention pages have legal approval;
- ten beta organisations have completed onboarding and at least one reminder cycle;
- Xero certification evidence is complete;
- rollback, token-revocation, provider-outage and billing-failure runbooks have been exercised.

## 16. Authoritative Xero references

- [Xero developer pricing](https://developer.xero.com/pricing)
- [Certification checkpoints](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/certification-checkpoints/)
- [Building and growing your app](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/building-and-growing-your-app/)
- [Sign Up with Xero](https://developer.xero.com/documentation/xero-app-store/app-partner-guides/sign-up)
- [OAuth standard authorisation flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/)
- [Xero scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Xero tenants and connection limits](https://developer.xero.com/documentation/guides/oauth2/tenants/)
- [Xero Developer Platform Commercial Terms](https://developer.xero.com/xero-developer-platform-commercial-terms)


