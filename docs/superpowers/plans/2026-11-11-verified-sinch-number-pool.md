# Verified Sinch Number Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allocate paid customers only a pre-provisioned Sinch number whose ownership and two-way operation were explicitly verified by the platform owner.

**Architecture:** Add explicit provider-verification evidence to the number-pool record. Owner-only administration records that evidence, while the existing transactional allocator filters out every unverified entry and fails closed when the verified pool is empty.

**Tech Stack:** TypeScript 6, Next.js 16 server actions, Drizzle ORM/PostgreSQL 17, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-verified-sinch-number-pool-design.md`

## Global Constraints

- Do not call the Sinch Numbers API or imply that AccountPulse purchases numbers.
- Do not change Customer Live, rollout scope, automatic-sequence state or SMS allowances.
- Verification evidence must not contain credentials, message content or customer phone data.
- Existing internal legacy sending remains unchanged.
- All owner mutations remain audited and fail closed on stale state.

## Review Focus

- An older unverified `AVAILABLE` number must never beat a newer verified entry.
- A provider ID without a verification timestamp must remain ineligible.
- A verification timestamp without a provider ID must remain ineligible.
- Concurrent paid activations must not receive the same number.
- Owner quarantine/release and every return to the shared pool must clear provider verification so a recycled number cannot be allocated to another customer without fresh checks. Subscription cooling may retain verification only while the number stays bound to the same organisation.

---

### Task 1: Persist provider verification evidence

**Files:**
- Modify: `packages/db/src/schema/commerce.ts`
- Create: `packages/db/drizzle/0022_*.sql` and generated snapshot metadata
- Test: `packages/db/src/schema/commerce.test.ts`

**Interfaces:**
- Produces: nullable `smsNumberPool.providerVerifiedAt: Date | null`.

- [x] Write a schema test that requires the `provider_verified_at` column.
- [x] Run the schema test and confirm it fails because the column is absent.
- [x] Add the nullable timestamp and generate the additive migration.
- [x] Run the schema test and migration checks.

### Task 2: Fail closed during automatic allocation

**Files:**
- Modify: `packages/db/src/repositories/sms-commerce-repository.ts`
- Test: `packages/db/src/repositories/sms-commerce-repository.integration.test.ts`
- Test: `apps/worker/src/handlers/sms-number-provision.test.ts`

**Interfaces:**
- Consumes: `providerVerifiedAt` from Task 1.
- Produces: `reserveAvailableNumber(organisationId, now)` selecting only verified provider-backed entries.

- [x] Write integration tests proving unverified entries are skipped and unverified reservations fail closed.
- [x] Run the focused tests and confirm the expected failures.
- [x] Filter the locked `AVAILABLE` query by non-null provider ID and verification timestamp; retain the existing `SMS_NUMBER_POOL_EXHAUSTED` failure when none qualifies.
- [x] Run the focused repository and worker tests.

### Task 3: Add owner verification control

**Files:**
- Modify: `packages/db/src/repositories/platform-admin-repository.ts`
- Modify: `apps/web/src/server/platform-admin-service.ts`
- Modify: `apps/web/src/app/platform-admin/sms/actions.ts`
- Modify: `apps/web/src/components/platform-admin/sms-administration.tsx`
- Test: `packages/db/src/repositories/platform-admin-repository.integration.test.ts`
- Test: `apps/web/src/server/platform-admin-service.test.ts`
- Test: `apps/web/src/components/platform-admin/platform-admin-views.test.tsx`

**Interfaces:**
- Produces: owner-only `verifySmsNumberForPool` mutation for an unassigned `AVAILABLE` number.
- Updates: manual `markSmsNumberReady` also stores `providerVerifiedAt`.

- [x] Write failing repository/service/view tests for owner verification, stale-state rejection and mandatory provider ID/reason/confirmation.
- [x] Run the focused tests and confirm the failures.
- [x] Implement the audited mutation and wire the server action and owner form.
- [x] Display provider-verification status without exposing secrets.
- [x] Run the focused tests.

### Task 4: Update operations guidance and stabilise the integration baseline

**Files:**
- Modify: `docs/operations/platform-admin-runbook.md`
- Modify: `apps/web/tests/xero-oauth.integration.test.ts`

**Interfaces:**
- Documents: pre-verification pool workflow and manual assigned-number fallback.

- [x] Update the runbook with the exact beta pool sequence and exhaustion behaviour.
- [x] Move the OAuth integration fixture clock beyond the independent cleanup fixture to prevent shared-test deletion races.
- [x] Run focused integration tests, then lint, typecheck, the complete test suite and production build.
