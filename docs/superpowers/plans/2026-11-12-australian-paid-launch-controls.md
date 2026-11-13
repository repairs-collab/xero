# Australian Paid Launch Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new AccountPulse Australian customers pay on signup without a free trial, support monthly or annual billing while resetting 2,000 included SMS parts monthly, enforce the approved debt-contact controls, and implement the approved five-year data lifecycle.

**Architecture:** Preserve existing `TRIALING` rows and expiry jobs only for backwards compatibility, but create every new customer as unpaid/incomplete until a signed Stripe payment activates access. Represent billing cadence separately from the monthly SMS allowance period so annual billing never turns 2,000 monthly parts into a yearly cap. Treat privacy/deletion and debt-contact controls as independent enforcement services with audited, tenant-scoped state.

**Tech Stack:** TypeScript, Next.js, PostgreSQL/Drizzle, Stripe Checkout and signed webhooks, Vitest, pnpm.

**Spec:** `docs/commercial-legal-inputs.md`

## Global Constraints

- Australia-only, AUD-only, one Xero organisation and one user for Solo.
- No new free trials; first payment is due during signup.
- Initial payment is card-only. Australian BECS Direct Debit is available only
  on customer request after the first card payment succeeds and a valid Direct
  Debit Request/service agreement is completed; AccountPulse never stores bank
  account details.
- Existing historical `TRIALING` rows remain supported until they finish.
- Monthly and annual billing; annual price is 5% below twelve monthly payments.
- The included allowance is 2,000 SMS parts per calendar-month-style allowance cycle for both monthly and annual subscriptions; unused parts do not roll over.
- Cancellation takes effect at the end of the paid billing period.
- Failed payment pauses sending immediately and permits billing recovery for 30 days before broader closure handling.
- Five-year post-cancellation retention for required invoice, customer, message, call and audit records; verified export/deletion target is 14 days; legal holds win.
- Debt reminders may run Monday-Friday 08:30-17:00 Australia/Sydney, excluding public holidays, and at most once per customer/account per local day across SMS and automated calls.
- STOP/opt-out suppression remains fail-closed and cannot be bypassed by this release.
- Do not create Stripe products/prices, contact providers, spend money, push, merge or deploy.
- Every behavior change follows RED-GREEN TDD and gets an independent review before release.

## Review Focus

- A historical trial must continue to expire safely even though new trials cannot be created.
- A forged annual price or cadence must fail closed and never grant access.
- Annual customers must receive exactly one 2,000-part allowance reset per monthly allowance cycle, including month-length and retry boundaries.
- Concurrent SMS/call schedulers must not both contact the same debtor on the same local day.
- Deletion must never remove legal-hold, billing/audit evidence or another tenant's records.

---

### Task 1: Stop issuing new trials and require paid activation

**Files:**
- Modify: `apps/web/src/server/solo-provisioning-service.ts`
- Modify: `apps/web/src/server/platform-customer-provisioning.ts`
- Modify: `apps/web/src/server/subscription-service.ts`
- Modify: `apps/web/src/app/platform-admin/organisations/new/page.tsx`
- Modify: `apps/web/src/app/start/page.tsx`
- Modify: affected onboarding, billing and Sophie copy/tests found by `rg "trial|TRIALING|trialEnd"`
- Test: corresponding existing `*.test.ts` and integration tests

**Interfaces:**
- Produces new workspaces with subscription status `INCOMPLETE` and `trialEndsAt: null`.
- Produces Stripe Checkout sessions with no `trial_end` or `trial_period_days` for new subscriptions.
- Preserves read/expiry handling for existing `TRIALING` rows.

- [ ] Write failing service and integration tests proving new owner/self-service customers are `INCOMPLETE`, have no trial end, cannot send, and Checkout collects immediately.
- [ ] Run the focused tests and confirm the existing trial creation/forwarding makes them fail.
- [ ] Implement the minimum no-new-trial state transitions and remove trial parameters from new Checkout sessions.
- [ ] Replace customer-facing free-trial promises with paid-signup or controlled-beta wording while keeping historical-trial operational handling.
- [ ] Run focused tests, full unit tests, typecheck and targeted lint.
- [ ] Commit the task.

### Task 2: Add monthly and annual billing cadence with monthly SMS allowance cycles

**Files:**
- Modify: subscription and allowance schemas under `packages/db/src/schema/`
- Create: forward migration under `packages/db/drizzle/`
- Modify: `apps/web/src/server/subscription-service.ts`
- Modify: Stripe webhook/billing repositories and runtime configuration
- Modify: billing/onboarding plan-selection UI and tests
- Modify: `deploy/ovh/env.example`, Docker/deploy validation and tests
- Test: subscription, webhook, allowance, migration and rendered-copy suites

**Interfaces:**
- Produces cadence `MONTHLY | ANNUAL` stored on the subscription.
- Consumes two exact allowlisted Stripe Price IDs; annual selection fails closed when the annual ID is unavailable.
- Produces an independent monthly allowance window for 2,000 parts, unrelated to the annual Stripe period.
- Produces a manual direct-debit request state that cannot become active until a
  successful initial card invoice and a provider-confirmed BECS mandate exist.

- [ ] Write failing migration/repository tests for cadence and monthly allowance boundaries, including annual subscriptions and retry/idempotency cases.
- [ ] Run them and confirm the current single-price/Stripe-period coupling fails.
- [ ] Add the forward-only schema and migration with safe defaults for existing monthly subscriptions.
- [ ] Add exact monthly/annual price allowlisting, cadence selection and signed-webhook validation without creating external Stripe objects.
- [ ] Add a request-only BECS setup flow using Stripe-hosted collection; reject
  requests before the first successful card invoice, never store bank details,
  and retain only provider/mandate evidence required for audit.
- [ ] Decouple allowance-window computation from Stripe annual periods and prove each monthly reset is idempotent.
- [ ] Render and test monthly/annual pricing copy; annual amount must be derived as 95% of twelve monthly charges and shown excluding GST.
- [ ] Run focused and full verification, then commit.

### Task 3: Implement the 30-day failed-payment recovery lifecycle

**Files:**
- Modify: billing operations schemas/repositories/services and worker jobs
- Modify: owner billing queue/read models
- Test: payment-failure/recovery/cancellation integration suites

**Interfaces:**
- On signed payment failure, pauses provider submissions immediately and records `recoveryEndsAt = failedAt + 30 days`.
- Successful signed recovery restores eligibility only when no other blocking case exists.
- Unresolved cases become closure/suspension review work after 30 days; no automatic destructive deletion.

- [ ] Write failing timestamp, retry, out-of-order and multi-case tests.
- [ ] Confirm current behavior lacks the 30-day recovery deadline.
- [ ] Implement the deadline and bounded review job without weakening immediate send holds.
- [ ] Add owner-visible state and lifecycle-email outbox evidence without delivering email yet.
- [ ] Run full billing verification and commit.

### Task 4: Implement five-year retention and 14-day data-request operations

**Files:**
- Modify: retention/account-closure schema and repositories
- Create: forward migration for deletion eligibility and verified request deadlines
- Modify: retention worker, owner operations UI and runbook
- Test: tenant isolation, legal hold, export/deletion and backup-ageing integration suites

**Interfaces:**
- Produces `deletionEligibleAt = cancelledAt + 5 years` for new cancellations.
- Produces verified export/deletion request target `verifiedAt + 14 days`.
- Legal holds and statutory billing/audit evidence always override deletion.

- [ ] Write failing migration/repository tests for five-year eligibility, 14-day target, legal holds, tenant isolation and idempotent retries.
- [ ] Run them and confirm the current 30-day review/unspecified period fails.
- [ ] Implement additive state and owner workflow; do not perform automatic destructive deletion.
- [ ] Preserve shorter raw-payload minimisation while retaining required evidence for five years.
- [ ] Run focused/full verification and commit.

### Task 5: Enforce debt-contact hours and once-daily cross-channel contact

**Files:**
- Modify: automatic SMS scheduler/eligibility service and voice-call scheduler
- Modify: shared contact-policy repository/schema if no atomic cross-channel record exists
- Create: forward migration only if required for cross-channel locking
- Test: Sydney time, weekends/public holidays, concurrency, disputes and STOP suppression

**Interfaces:**
- Provides one atomic `claimDebtContact(customerOrAccount, localDate, channel)` decision shared by SMS and automated calls.
- Rejects work outside Monday-Friday 08:30-17:00 Australia/Sydney and configured public-holiday dates.
- Rejects a second contact for the same customer/account/local day across either channel.

- [ ] Write failing boundary and concurrent interleaving tests before implementation.
- [ ] Confirm the current channel-specific behavior can exceed the combined daily limit.
- [ ] Implement a tenant-scoped atomic claim and apply it immediately before provider submission.
- [ ] Keep disputed invoices manual-to-mark but fail closed after the dispute flag; preserve STOP suppression.
- [ ] Run scheduler, worker, integration and full unit verification, then commit.

### Task 6: Release verification and independent review

**Files:**
- Modify: progress/readiness documentation only after evidence exists

- [ ] Run fresh migrations twice against disposable PostgreSQL.
- [ ] Run full unit, integration, typecheck, lint and production build with adequate Node heap.
- [ ] Independently review the entire change range for tenant isolation, billing authorization, data deletion and contact-policy bypasses.
- [ ] Fix every Critical/Important finding through TDD and re-review.
- [ ] Record external prerequisites without performing them: create the annual Stripe Price, set exact repository/OVH variables, verify Billing Portal period-end cancellation, and obtain paid-launch legal/accounting approval.
