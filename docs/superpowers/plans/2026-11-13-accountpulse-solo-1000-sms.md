# AccountPulse Solo 1,000 SMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change AccountPulse Solo to 1,000 included monthly SMS parts at the existing A$299 ex-GST price without destabilising Stripe or subscription compatibility.

**Architecture:** Keep the existing opaque billing plan identifier, make the domain allowance constant authoritative, update database/application defaults and migrate only uncustomised Solo allowances. Drive all customer-facing copy from the new entitlement and update commercial documentation and listing material.

**Tech Stack:** TypeScript, Vitest, Next.js, Drizzle ORM, PostgreSQL, Markdown.

**Spec:** `docs/superpowers/specs/2026-11-13-accountpulse-solo-1000-sms-design.md`

## Global Constraints

- A$299 AUD per month excluding GST remains unchanged.
- Monthly and annual subscriptions receive 1,000 parts per monthly allowance cycle.
- Unused parts expire with no rollover; additional outbound parts cost A$0.11
  each excluding GST.
- Preserve the internal `SOLO_AU_2000` identifier for compatibility.
- Preserve owner-customised allowance rows.

## Review Focus

- A projected total of 1,000 is included; the 1,001st eligible part is metered
  overage.
- The 80% warning activates at 800 parts.
- Missing allowance rows fall back to 1,000, never 2,000.
- The migration changes only uncustomised Solo rows at the old default.
- Public copy does not promise a trial or 2,000 included parts and states the
  A$0.11 ex-GST overage rate consistently.

---

### Task 1: Domain and persistence defaults

**Files:**
- Modify: `packages/domain/src/sms-commerce.ts`
- Modify: `packages/domain/src/sms-commerce.test.ts`
- Modify: `packages/db/src/schema/commerce.ts`
- Modify: `packages/db/src/repositories/sms-commerce-repository.ts`
- Modify: `packages/db/src/repositories/platform-admin-repository.ts`
- Create: `packages/db/drizzle/0044_solo_1000_sms_allowance.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `soloIncludedSmsParts = 1_000` as the authoritative default.

- [ ] Write failing tests for the 1,000 boundary, 800 warning and repository fallback.
- [ ] Run the focused domain/repository tests and verify the old 2,000 expectations fail.
- [ ] Change runtime defaults to the shared 1,000 constant.
- [ ] Add a migration that changes the database default and only uncustomised old-default Solo rows.
- [ ] Run the focused domain, schema and repository tests.

### Task 2: Onboarding, owner and customer views

**Files:**
- Modify: `apps/web/src/app/platform-admin/organisations/new/page.tsx`
- Modify: `apps/web/src/app/(protected)/settings/billing/page.tsx`
- Modify: focused component/page tests and default-plan fixtures.

**Interfaces:**
- Consumes: `soloIncludedSmsParts`.
- Produces: 1,000 as the new-customer default and customer-visible allowance.

- [ ] Add or update focused tests that expect 1,000 in onboarding and billing.
- [ ] Run the focused tests and verify the old default/copy fails.
- [ ] Use the shared constant for the owner form and remove hardcoded 2,000 copy.
- [ ] Run the focused tests.

### Task 3: Commercial, legal, support and listing material

**Files:**
- Modify: `docs/superpowers/specs/2026-11-09-accountpulse-solo-xero-app-store-design.md`
- Modify: `docs/commercial-legal-inputs.md`
- Modify: `docs/accountpulse-sophie-ai-support-training.md`
- Modify: active AccountPulse marketing and Xero-listing copy.

**Interfaces:**
- Produces: one consistent A$299 / 1,000-part offer with A$0.11 ex-GST
  overage, no rollover and no active trial claim.

- [ ] Replace active 2,000-part claims with the approved 1,000-part wording.
- [ ] Add an internal economics note distinguishing actual SMS use from Sinch's fixed plan fee.
- [ ] Search active sources for stale customer-facing 2,000, trial and incorrect
  overage claims.
- [ ] Review the public page draft before publication.

### Task 4: Focused release verification

**Files:**
- Verify only files and tests touched by Tasks 1–3.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: release evidence for the allowance change.

- [ ] Run focused domain, database, web and documentation checks.
- [ ] Run type-check for affected packages.
- [ ] Inspect the final diff for accidental plan-code or unrelated changes.
- [ ] Commit the completed allowance change.
