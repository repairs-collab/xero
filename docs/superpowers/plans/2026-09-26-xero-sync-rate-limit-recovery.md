# Xero Sync Rate-Limit Recovery Implementation Plan

> **Required sub-skill:** Use `superpowers:executing-plans` to implement this plan task by task, and `superpowers:test-driven-development` for every behavior change.

**Goal:** Make the first Xero import complete within Xero's API allowance, preserve reminder previews, and expose worker failures clearly without enabling live sends.

**Architecture:** Replace per-invoice contact lookups with Xero's batched `Contacts?IDs=` endpoint. Stop fetching online-invoice links during every sync; fetch and cache a link only when a review-mode SMS preview actually needs it. Add credential-safe worker error logging, including Xero retry timing, so operational failures appear in CloudWatch.

**Tech stack:** TypeScript, Vitest, Drizzle ORM, pg-boss, Xero Accounting API, AWS ECS/CloudWatch.

---

### Task 1: Batch Xero contact reads

- [x] Add a failing Xero client test for unique contact IDs split into batches of 100.
- [x] Add a failing worker sync test showing multiple invoices use one contact-list request rather than one request per invoice.
- [x] Implement `listContacts` in the Xero client and worker sync contract.
- [x] Reuse the batched contacts in initial, incremental, and nightly reconciliation imports.
- [x] Run the focused integration/client tests.

### Task 2: Remove online-invoice URL amplification

- [x] Add a failing sync test proving invoice import does not request an online-invoice URL.
- [x] Preserve an already cached URL when invoice financial fields are refreshed.
- [x] Add a failing reminder-calculation test proving a missing URL is fetched and cached only for a review SMS template that uses `{{online_invoice_url}}`.
- [x] Fetch the URL before creating the stage/approval so a rate-limit failure cannot leave an incomplete approval record.
- [x] Run the focused sync and reminder-calculation tests.

### Task 3: Make Xero throttling visible and safe to diagnose

- [ ] Add failing tests for Xero daily-limit metadata and credential-safe job failure logging.
- [ ] Parse Xero daily remaining allowance and rate-limit type alongside `Retry-After`.
- [ ] Log job name, job ID, error class/message, HTTP status, and retry delay without payloads, tokens, or credentials.
- [ ] Run worker runtime and Xero client tests.

### Task 4: Verify and prepare deployment

- [ ] Run formatting, lint, type-check, and the complete test suite.
- [ ] Confirm the production deployment still pins `SEND_MODE=dry-run`.
- [ ] Review the diff for secrets and unrelated changes.
- [ ] Commit and push the fix branch, then open a pull request for production deployment.
- [ ] After deployment, wait for Xero's stated reset window, trigger one sync, and verify invoices plus `lastSuccessfulSyncAt` without sending reminders.
