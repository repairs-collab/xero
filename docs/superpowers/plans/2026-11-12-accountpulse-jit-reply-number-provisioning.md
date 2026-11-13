# AccountPulse Beta Just-in-Time Reply Number Provisioning Plan

> **Implementation rule:** Build and test the no-cost control plane first. No
> provider order, number rental, charge, credential activation or customer
> billing change is permitted until the owner has approved the exact Sinch
> price and a spend ceiling.

**Goal:** Give each paid beta customer one dedicated Australian numeric reply
number without maintaining spare inventory, while keeping all provider
plumbing in the private AccountPulse owner console.

**Architecture:** A signed active-subscription event requests one idempotent
reply-number order for the organisation. The customer remains in a visible
`SETTING_UP` state. The owner console shows the request, provider readiness,
quoted costs and any required documents. Only an explicit owner approval may
submit a paid order during beta. A verified fulfilled order creates the
organisation's assigned number record and changes it to `READY`; outbound and
inbound messaging remain fail-closed until then.

**Provider reality:** Sinch's current Australian flow is an **order**, not an
instant inventory rental. The provider may require supporting documentation
and its Australian long-number registration example reports manual pricing and
`PENDING_APPROVAL`. AccountPulse must therefore model asynchronous approval
instead of promising immediate activation.

Official references:

- https://support.sinch.com/hc/en-us/articles/54556480387603-Buying-a-number-from-Sinch
- https://developers.sinch.com/docs/registration-api/getting-started/number-short-code
- https://developers.sinch.com/docs/numbers

## Non-negotiable controls

- Exactly one active request and one active assigned number per organisation.
- Numeric Australian numbers only; no alphanumeric Sender ID or EMSP gate for
  this beta path.
- Default provisioning mode is `DISABLED`.
- Beta mode is `OWNER_APPROVAL`; it never spends automatically.
- A future automatic mode must still require a configured per-number maximum,
  monthly spend ceiling and provider quote expiry.
- Credentials remain in protected OVH runtime configuration and are never
  rendered, stored in organisation rows or accepted from customer forms.
- Provider callbacks are authenticated, deduplicated and stored as selected
  status fields, never raw payloads.
- A payment event may request provisioning but never enables Customer Live.
- Failure, manual review or missing documents leave sending blocked and expose
  a provider-neutral status to the customer.
- Releasing or reassigning a number retains the existing quarantine controls.

## Delivery phases

### Phase A — five-customer beta control plane

Build the no-cost, provider-neutral workflow first. A paid subscription creates
one idempotent request. The owner records the written Australian quote and
documentation state, explicitly approves the exact setup/monthly amounts,
places the order outside AccountPulse, records the redacted external reference,
and records the fulfilled number directly against that organisation as
`RESERVED`. The existing messaging verification step is the only operation that
may promote it to `READY`.

Phase A deliberately has no Sinch order client, callback, polling loop,
automatic mode, credentials form, spare inventory or provider spend ledger.
The absence of a submit adapter is the automatic-purchase kill switch. This is
the smallest safe implementation while Australian price, auth, documentation
and lifecycle details remain provider-specific and manually quoted.

### Phase B — provider automation after successful beta

Only after written provider confirmation and a separately approved paid test,
add a dedicated Numbers/Registration adapter, authenticated callbacks or
bounded polling, quote expiry and automated spend controls. The existing Sinch
Engage messaging client, credentials, webhook and health probe must not be
assumed compatible with the Numbers/Registration services.

## State model

`WAITING_CONFIGURATION -> AWAITING_OWNER_APPROVAL -> SUBMITTED ->
PENDING_PROVIDER_APPROVAL -> IN_QUEUE -> FULFILLED`

Terminal exception states are `FAILED` and `EXPIRED`. A failed or expired
request may be retried with a new attempt under the same organisation-level
idempotency contract. Sinch's order/reservation flow is not represented as
customer-cancellable when the provider does not offer a cancellation endpoint.

## Task 1 — Durable provider-neutral order records

Create a provider-neutral `reply_number_orders` table and a private platform
provisioning-settings table.

- Store organisation, provider, status, request key, provider request ID,
  requested country/type/capabilities, selected policy reference, quoted setup
  and recurring fees, currency, quote expiry, documentation state, redacted
  failure code and timestamps.
- Add a partial unique index preventing two non-terminal orders for one
  organisation.
- Store only non-secret provider configuration references and spend controls.
- Default every new environment to disabled ordering and a zero spend ceiling.
- Add PostgreSQL checks for AUD, non-negative fees and valid state transitions.
- Prove cross-tenant isolation and idempotency with integration tests.

## Task 2 — Provider-neutral provisioning interface

Add an interface with these operations:

- `prepareOrganisationOrder(organisationId)` — no provider call and no cost;
- `recordWrittenQuote(orderId, expectedVersion, quote)` — owner evidence only;
- `approveManualOrder(orderId, expectedVersion, approval)` — records approval
  but performs no provider call;
- `recordExternalOrder(orderId, expectedVersion, reference)` — redacted owner
  evidence for an order placed outside AccountPulse; and
- `fulfilOrder(orderId, number, providerNumberId)` — atomically inserts the
  number assigned to that organisation as `RESERVED`.

The future Phase B Sinch adapter must validate the Australian long-number
policy, submit a quantity of exactly one, request two-way messaging, parse
manual-price and documentation requirements, and reject unsupported or
ambiguous responses. Do not create or invoke that adapter in Phase A.

## Task 3 — Safe worker orchestration

Update `sms-number.provision` so it:

1. returns immediately when the organisation already has a `READY` number;
2. reuses an existing non-terminal order idempotently;
3. creates a no-cost order draft when there is no number;
4. never scans spare inventory or calls Sinch;
5. returns an owner-action-required result rather than retrying an expected
   waiting state; and
6. leaves `READY` promotion to the separate verified messaging workflow.

Retain `sms_number_pool` as the verified ownership, assignment and quarantine
record. For the five-customer beta it contains assigned numbers only; there is
no requirement to pre-purchase spare `AVAILABLE` inventory.

## Task 4 — Secure owner operations

Extend `/platform-admin/sms` with:

- exact written setup and monthly fee plus quote expiry;
- documentation status and a redacted evidence reference;
- pending, document-required, failed and fulfilled requests;
- an explicit per-order approval that states the exact recorded charge;
- a redacted external-order reference entered after the owner orders outside
  AccountPulse;
- customer assignment, allowance and quarantine controls; and
- immutable audit evidence for every approval and provider transition.

The order action must require platform-owner authorisation, optimistic version
checking, an exact typed confirmation and a still-valid quote. Customer admins
must receive not-found/forbidden results from every owner operation.

## Task 5 — Provider-neutral customer experience

- Remove Sinch credentials, names, tests, callback keys, provider IDs and order
  controls from customer routes and server actions.
- Show only `Setting up your AccountPulse reply number`, `Ready`, or a concise
  support-required state.
- Show the assigned E.164 number and status on Inbox and Outbox.
- Keep Xero connect/sync available to authorised customer administrators.
- Use AccountPulse messaging language in dashboard, previews, onboarding,
  sending controls and support copy.
- Add tests proving that customer-rendered HTML and customer actions cannot
  expose or mutate provider configuration.

## Task 6 — Price recovery without surprise billing

Before any real order:

1. obtain Sinch's written setup fee, monthly fee, inbound reply price,
   provisioning limits and documentation requirements;
2. choose either an all-inclusive Solo price or a fixed, disclosed Stripe
   number add-on price;
3. configure that fixed price in Stripe test mode and prove webhook ownership;
4. display the price before subscription/order approval; and
5. reconcile the provider fee and customer charge in the owner console.

Do not pass through an unknown or changing provider amount. For beta, one
dedicated number may be included in the advertised Solo price after the quote
is known; internal cost tracking still records its margin.

## Task 7 — Verification and release gate

- Unit-test parsing, status mapping, spend gates and customer copy.
- PostgreSQL-test concurrency, idempotency, tenant isolation and one-number
  uniqueness.
- Browser-test owner approval and customer provisioning states.
- Use a provider fake to prove callback/poll ordering and duplicate delivery.
- Run lint, type-check, all tests and production build.
- Conduct one genuine owner-approved beta order only after separate approval of
  the displayed cost.
- Verify outbound SMS, inbound reply routing and quarantine before declaring
  the feature commercially ready.

