# AccountPulse Commercial Payment Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, fail-closed operations layer for Stripe payment failures, recoveries, refunds and disputes, plus a held transactional-email outbox and an owner-only review queue.

**Architecture:** Signed Stripe events are converted into an exact internal transition contract and resolved against current or retired locally stored Stripe subscription identifiers. A PostgreSQL transaction locks the organisation before related commerce rows, deduplicates the event, opens or resolves a billing case, creates one held notice per active organisation administrator, and uses the existing platform suspension control for blocking financial risk. A private owner page exposes cases and held notices; this release never reactivates an organisation from a provider event and never sends email.

**Tech Stack:** TypeScript 6, Next.js, PostgreSQL 17, Drizzle ORM, Stripe SDK 22.3.2 (`2026-06-24.dahlia`), Vitest, React.

**Spec:** `docs/commercial-release-readiness-2026-11-11.md`

## Global Constraints

- Keep production on OVH; do not add AWS hosting dependencies.
- Do not purchase or activate any paid service.
- Do not send transactional email in this release; all new email records must be `HELD` and are not eligible for automatic replay.
- Stripe signatures must be verified before parsing event content.
- Unknown customers, cross-organisation ownership, malformed objects, ambiguous charge ownership and unsupported currencies fail closed.
- `invoice.paid` may resolve an existing case but must never create entitlement or restore an organisation.
- Dispute closure may change a case but must never restore an organisation automatically.
- All platform operations pages remain owner-only and return not-found to unauthorised accounts.
- Risk events suspend through `organisations.platformStatus` without rewriting send mode, rollout scope or acknowledgement.
- Lock order is organisation, subscription/retired-subscription evidence, billing case, then email outbox.
- One held notice is created per active `ADMIN` membership; no active administrator means no notice row and a recipient-missing audit event.

## Exact event transition matrix

| Stripe event | Case key | Amount | Case result | Suspension | Current/retired rule | Held template |
| --- | --- | --- | --- | --- | --- | --- |
| `invoice.payment_failed` | invoice ID | `amount_remaining` | `OPEN` | current: suspend; retired: no suspension | accept exact current or same-organisation retired subscription | `PAYMENT_FAILED` |
| `invoice.paid` | invoice ID | `amount_remaining` | resolve an existing failure only; no case if absent | never reactivate | accept exact current or same-organisation retired subscription | `PAYMENT_RECOVERED` only when a case resolves |
| `charge.refunded` | charge ID | cumulative `amount_refunded` | `REVIEW_REQUIRED` | no suspension | resolve through Charge → PaymentIntent → InvoicePayment → Invoice; accept current or same-organisation retired | `REFUND_RECORDED` |
| `charge.dispute.created` | dispute ID | dispute `amount` | `OPEN` | suspend, including same-organisation retired charges | resolve through the same charge chain | `DISPUTE_OPENED` |
| `charge.dispute.closed` with `won` or `prevented` | dispute ID | dispute `amount` | `RESOLVED` | never reactivate | accept current or same-organisation retired | `DISPUTE_CLOSED` |
| `charge.dispute.closed` with `lost` or `warning_closed` | dispute ID | dispute `amount` | `REVIEW_REQUIRED`, blocking | retain suspension | accept current or same-organisation retired | `DISPUTE_CLOSED` |

At equal Stripe timestamps, the higher-risk transition wins regardless of arrival order: blocking `OPEN` > blocking `REVIEW_REQUIRED` > non-blocking `REVIEW_REQUIRED` > `RESOLVED`. Older events never change the case or create a second held notice. Amounts are safe non-negative integers in minor units and currency must be lowercase `aud`.

## Review Focus

- An event naming another organisation's current or retired subscription must not mutate either organisation.
- Duplicate delivery must create one provider-event row, one case transition and one held notice per active administrator.
- Equal-second and out-of-order recovery events must not erase a later or equal-time risk state.
- Paid invoices and won disputes must not reactivate organisations; reactivation remains an explicit owner action.
- Owner reactivation must fail while any unresolved blocking case exists.

---

### Task 1: Durable billing-case and held-email schema

**Files:**
- Modify: `packages/db/src/schema/commerce.ts`
- Modify: `packages/db/src/schema/commerce.test.ts`
- Modify: `packages/db/src/schema/schema.integration.test.ts`
- Create: `packages/db/drizzle/0025_*.sql` and generated Drizzle metadata

**Interfaces:**
- Produces: `billingCases`, `transactionalEmailOutbox`
- Produces: `BillingCaseKind = 'PAYMENT_FAILURE' | 'REFUND' | 'DISPUTE'`
- Produces: `BillingCaseStatus = 'OPEN' | 'RESOLVED' | 'REVIEW_REQUIRED'`
- Produces: `BillingSubscriptionRelation = 'CURRENT' | 'RETIRED'`
- Produces: `TransactionalEmailTemplate = 'PAYMENT_FAILED' | 'PAYMENT_RECOVERED' | 'REFUND_RECORDED' | 'DISPUTE_OPENED' | 'DISPUTE_CLOSED'`
- Produces: `TransactionalEmailStatus = 'HELD' | 'PENDING' | 'SENT' | 'FAILED'`

- [ ] **Step 1: Write the failing schema contract test**

Assert that `billing_cases` has organisation, kind, status, provider object/status, Stripe subscription, subscription relation, minor amount, currency, `blocks_sending`, latest provider event ID/time, opened/resolved and created/updated times, plus a unique organisation/kind/provider-object index. Assert that `transactional_email_outbox` has organisation, case FK, recipient, template/version, immutable `render_data`, idempotency key, status, attempts, redacted failure code and timestamps, plus a unique organisation/idempotency index.

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm vitest run --project unit packages/db/src/schema/commerce.test.ts`

Expected: FAIL because the two tables are not exported.

- [ ] **Step 3: Add the tables and generate migration 0025**

Use checks for non-negative integer minor amounts, lowercase `aud`, allowed enum values, non-negative attempts and resolved-at/status consistency. `transactional_email_outbox.billing_case_id` uses `onDelete: 'restrict'`.

- [ ] **Step 4: Add migration integration assertions and verify GREEN**

Run: `pnpm vitest run --project unit packages/db/src/schema/commerce.test.ts && pnpm vitest run --project integration packages/db/src/schema/schema.integration.test.ts`

Expected: both files PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add billing operations storage`

### Task 2: Safe Stripe charge ownership for the Dahlia API

**Files:**
- Modify: `packages/integrations/src/stripe/client.ts`
- Modify: `packages/integrations/src/stripe/client.test.ts`
- Modify: `packages/integrations/src/stripe/index.ts`

**Interfaces:**
- Produces: `StripeChargeOwnership { stripeCustomerId: string; stripeSubscriptionId: string }`
- Produces: `StripeBillingClient.loadChargeOwnership(chargeId: string): Promise<StripeChargeOwnership>`

- [ ] **Step 1: Write failing client tests**

Test the pinned-provider chain: retrieve a charge with string `customer` and `payment_intent`; list invoice payments filtered by that PaymentIntent; require exactly one result; require an expanded invoice whose customer matches the charge and whose `parent.subscription_details.subscription` is a string. Test zero/multiple or paginated matches, expanded/missing charge identifiers, deleted/malformed invoices and customer mismatch. Assert no metadata is used for ownership.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run --project unit packages/integrations/src/stripe/client.test.ts`

Expected: FAIL because charge and invoice-payment lookup methods do not exist.

- [ ] **Step 3: Implement the narrow lookup**

Extend `StripeApi` with `charges.retrieve` and `invoicePayments.list`. Filter by `{ payment: { type: 'payment_intent', payment_intent: id } }` and expand the invoice parent subscription. Generalise `StripeProviderFailure` copy so it covers provider reads as well as hosted-session creation.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run --project unit packages/integrations/src/stripe/client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: resolve Stripe charge ownership safely`

### Task 3: Apply operational Stripe events atomically

**Files:**
- Modify: `apps/web/src/server/subscription-service.ts`
- Modify: `apps/web/src/server/subscription-service.test.ts`
- Modify: `apps/web/src/server/subscription-repository.ts`
- Create: `apps/web/src/server/subscription-operations.integration.test.ts`

**Interfaces:**
- Produces: `StripeOperationalEventInput`
- Produces: `SubscriptionRepository.applyOperationalEvent(input): Promise<StripeEventApplicationOutcome>`
- Consumes: `StripeBillingGateway.loadChargeOwnership(chargeId)`
- Consumes: `billingCases`, `transactionalEmailOutbox`

- [ ] **Step 1: Write failing service tests for the transition matrix**

Cover every matrix row, current invoice `parent.subscription_details.subscription`, legacy invoice `subscription`, malformed currency/amount/status, routine paid invoice with no prior failure, and the charge-ownership path for refunds and disputes.

- [ ] **Step 2: Run service tests and verify RED**

Run: `pnpm vitest run --project unit apps/web/src/server/subscription-service.test.ts`

Expected: FAIL because operational events are still rejected.

- [ ] **Step 3: Parse operational events without granting access**

Parse safe integer minor-unit amounts and AUD only. Pass exact provider IDs and transition intent to the repository. Keep `handleWebhook`'s public outcome contract unchanged.

- [ ] **Step 4: Write failing PostgreSQL integration tests**

Prove current ownership, same-organisation retired acceptance, other-organisation retired rejection, event deduplication, administrator fan-out, recipient-missing audit, the exact transition matrix, equal-time risk precedence, older-event rejection and no automatic reactivation.

- [ ] **Step 5: Run the integration test and verify RED**

Run: `pnpm vitest run --project integration apps/web/src/server/subscription-operations.integration.test.ts`

Expected: FAIL because the repository method is absent.

- [ ] **Step 6: Implement the repository transaction**

Resolve ownership non-lockingly, then lock organisation first and current subscription/retired evidence second; revalidate IDs after locks. Reuse `subscription_events` for owned supported events and `audit_events` for case, suspension and recipient-missing evidence. Unknown unowned events return `REJECTED` without durable deduplication. Suspend by updating platform status/version/reason only. Insert held notices for all active ADMIN users using idempotency derived from event ID, template and a hash of the normalised recipient; never store a full Stripe payload.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm vitest run --project unit apps/web/src/server/subscription-service.test.ts && pnpm vitest run --project integration apps/web/src/server/subscription-operations.integration.test.ts`

Expected: both files PASS.

- [ ] **Step 8: Commit**

Commit: `feat: record Stripe billing incidents`

### Task 4: Prevent owner reactivation while financial risk remains

**Files:**
- Modify: `packages/db/src/repositories/platform-admin-repository.ts`
- Modify: `packages/db/src/repositories/platform-admin-repository.integration.test.ts`
- Modify: `apps/web/src/server/platform-admin-service.test.ts`

**Interfaces:**
- Consumes: any `billing_cases` row where `blocks_sending = true` and status is not `RESOLVED`
- Produces: failed reactivation result with code `BILLING_RISK_HOLD`

- [ ] **Step 1: Write a failing reactivation integration test**

Suspend an organisation through a blocking billing case, then prove owner reactivation fails without changing platform status/version. Prove reactivation succeeds after the case resolves and that a non-blocking refund review does not prevent it.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run --project integration packages/db/src/repositories/platform-admin-repository.integration.test.ts`

Expected: FAIL because reactivation does not inspect billing cases.

- [ ] **Step 3: Add the guarded reactivation query**

Within the existing organisation lock and optimistic-version transaction, return `BILLING_RISK_HOLD` before any update when an unresolved blocking case exists. Do not add a bypass.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run --project integration packages/db/src/repositories/platform-admin-repository.integration.test.ts && pnpm vitest run --project unit apps/web/src/server/platform-admin-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `fix: guard financial-risk reactivation`

### Task 5: Private owner billing-operations queue

**Files:**
- Modify: `packages/db/src/repositories/platform-admin-repository.ts`
- Modify: `packages/db/src/repositories/platform-admin-repository.integration.test.ts`
- Modify: `apps/web/src/server/platform-admin-service.ts`
- Modify: `apps/web/src/server/platform-admin-service.test.ts`
- Modify: `apps/web/src/components/platform-admin-shell.tsx`
- Create: `apps/web/src/components/platform-admin/billing-operations.tsx`
- Create: `apps/web/src/app/platform-admin/billing/page.tsx`
- Modify: `apps/web/src/components/platform-admin/platform-admin-views.test.tsx`

**Interfaces:**
- Produces: `PlatformBillingOperationsPage { cases: { items; nextCursor }; heldEmails: { items; nextCursor } }`
- Produces: `PlatformAdminService.listBillingOperations(actorUserId, { organisationId?, caseKind?, caseStatus?, casesCursor?, heldEmailsCursor?, limit? })`

- [ ] **Step 1: Write failing repository, service and component tests**

Assert owner verification, optional organisation/kind/status filters, stable `(createdAt, id)` cursors for each list, newest-first ordering, redaction of immutable render data and absence of mutation controls.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run --project unit apps/web/src/server/platform-admin-service.test.ts apps/web/src/components/platform-admin/platform-admin-views.test.tsx && pnpm vitest run --project integration packages/db/src/repositories/platform-admin-repository.integration.test.ts`

Expected: FAIL because billing operations are not available.

- [ ] **Step 3: Implement the read-only owner queue and navigation**

Show case kind/status, organisation, amount, provider reference, current/retired relation, blocking state, opened/resolved time, and held-notice template/recipient/time. Do not add release, resolution or send controls.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2.

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add owner billing operations queue`

### Task 6: Operator runbook and release verification

**Files:**
- Create: `docs/runbooks/billing-operations.md`
- Modify: `docs/commercial-release-readiness-2026-11-11.md`

**Interfaces:**
- Documents: payment recovery, refund review, dispute/chargeback response, held-email behaviour, escalation and audit evidence.

- [ ] **Step 1: Write the runbook**

State that Stripe Dashboard is the payment processor of record and AccountPulse only records operational evidence. Require manual confirmation of subscription state and no unresolved blocking case before explicit owner reactivation. Explain that held notices were not delivered.

- [ ] **Step 2: Update readiness progress without closing P0 items 6 or 7**

Record the foundation while leaving Stripe receipt configuration/delivery, scheduled and effective cancellation verification, SMTP activation, dunning timing, refund policy and remaining lifecycle templates as blockers.

- [ ] **Step 3: Run full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: exit 0, 0 failures.

- [ ] **Step 4: Commit**

Commit: `docs: add billing operations runbook`

## Completion Contract

- Every production behaviour has a failing test observed before implementation.
- Full lint, type-check, unit/integration test and production build commands pass.
- A fresh reviewer checks cross-tenant and retired-subscription ownership, replay safety, equal-time transitions, suspension/reactivation behavior and data leakage.
- No SMTP credentials, payment secrets, customer card data or full provider payloads are stored.
- No merge, deployment, provider activation or paid action occurs without the release gate already authorised by the owner.
