# AccountPulse Commercial Billing Safety Implementation Plan

> **For agentic workers:** Use subagent-driven development and test-driven development task by task. Prove each new test fails for the intended reason before changing production code.

**Goal:** Make Stripe access, one-time trials, resubscription and Solo SMS allowances safe and internally consistent without purchasing or activating any external service.

**Spec:** [2026-11-12-commercial-billing-safety-design.md](../specs/2026-11-12-commercial-billing-safety-design.md)

## Global constraints

- Start from GitHub `main` commit `2f2d741687e7280b8d47d6afd36053932accccea`.
- Do not deploy, send provider messages, activate billing, purchase plans or mutate live customer data.
- Preserve `INTERNAL_LEGACY`, platform verification and verified-admin trial-test behaviour.
- Checkout redirects never grant access; only verified lifecycle events do.
- Use additive migrations and fail closed for ambiguous historical state.
- Do not include the unrelated `artifacts/` directory in any commit.

## Task 1: Correct Stripe state precedence and scheduled-cancellation access

**Files:**

- Modify `packages/integrations/src/stripe/status.test.ts`
- Modify `packages/integrations/src/stripe/status.ts`
- Modify `apps/web/src/server/subscription-service.test.ts`
- Modify `apps/web/src/server/subscription-repository.ts`
- Modify `apps/web/src/app/(protected)/settings/billing/page.tsx`
- Add a Drizzle migration under `packages/db/drizzle/`

**Steps:**

- [ ] Change the table-driven mapper test so only `active + cancel_at_period_end` maps to `CANCEL_AT_PERIOD_END`; all other states retain their provider-derived fail-closed mapping.
- [ ] Add a regression proving a failed-payment cancellation event cannot enable sends or number provisioning.
- [ ] Implement the minimum mapper change.
- [ ] Remove `CANCEL_AT_PERIOD_END` from the repository's unsafe-sending set and the customer-facing “sending paused” warning.
- [ ] Add a migration that converts ambiguous historical `CANCEL_AT_PERIOD_END` rows to `INCOMPLETE` without deleting records.
- [ ] Run focused tests and affected package tests.

## Task 2: Enforce one trial and safe cancelled-customer resubscription

**Files:**

- Modify `packages/integrations/src/stripe/client.test.ts`
- Modify `packages/integrations/src/stripe/client.ts`
- Modify `apps/web/src/server/subscription-service.test.ts`
- Modify `apps/web/src/server/subscription-service.ts`
- Modify `apps/web/src/server/subscription-repository.ts`
- Modify relevant integration tests under `apps/web/tests/`

**Steps:**

- [ ] Add a failing Checkout test proving no fresh fixed 14-day trial is requested and only an eligible stored deadline can be passed.
- [ ] Add current item-level and legacy subscription-level period fixtures.
- [ ] Add tests proving lifecycle events cannot erase or extend the original local trial deadline.
- [ ] Add tests for cancelled-subscription replacement using the same Stripe customer, both webhook arrival orders and rejection of stale old-subscription events.
- [ ] Implement exact remaining-trial propagation, immutable deadline persistence, validated dual period parsing and safe replacement binding.
- [ ] Run focused tests and affected integration tests.

## Task 3: Enforce a true Solo SMS hard cap and align customer copy

**Files:**

- Modify `packages/domain/src/sms-commerce.test.ts`
- Modify `packages/domain/src/sms-commerce.ts`
- Modify `packages/db/src/repositories/sms-commerce-repository.integration.test.ts`
- Modify `packages/db/src/repositories/sms-commerce-repository.ts`
- Modify `apps/web/src/app/(protected)/settings/billing/page.tsx`
- Modify `apps/web/src/app/legal/terms/page.tsx`
- Modify `docs/accountpulse-sophie-ai-support-training.md`
- Modify `docs/runbooks/deployment.md`
- Update `docs/commercial-release-readiness-2026-11-11.md`

**Steps:**

- [ ] Replace overage-authorisation unit tests with exact-limit and multipart-over-limit failures.
- [ ] Add an integration regression with valid persisted legacy overage settings and prove no reservation is created above the allowance.
- [ ] Make the allowance decision unconditional for Solo and remove runtime overage fields from the customer usage view while retaining database columns.
- [ ] Display the configured allowance and remaining amount; remove overage claims and explain that over-limit sends are blocked.
- [ ] Align active legal, support and deployment copy. Mark the old commercial design's overage proposal as superseded instead of rewriting historical decisions.
- [ ] Run focused tests and affected package tests.

## Task 4: Verify the release candidate

- [x] Run unit tests, documenting the existing external VoIPcloud DNS timeout separately if it recurs.
- [x] Start the local PostgreSQL test service and run integration tests.
- [x] Run lint, type checking and builds.
- [x] Review the diff for tenant isolation, billing fail-closed behaviour, legal-copy consistency and accidental secrets.
- [x] Commit the verified branch and prepare a pull request. Stop before merge or production deployment.
