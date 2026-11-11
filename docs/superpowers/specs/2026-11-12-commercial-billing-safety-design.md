# AccountPulse Commercial Billing Safety Design

**Date:** 2026-11-12

**Status:** Approved for implementation by the owner's instruction to proceed autonomously with no-cost work

## Intent

Remove the highest-risk commercial billing inconsistencies before external beta or paid use. This release does not buy, activate or upgrade any external service and does not enable public signup.

## Product rules

1. Stripe's provider status is authoritative. A scheduled cancellation changes an `active` subscription to `CANCEL_AT_PERIOD_END`, but it must never turn `past_due`, `unpaid`, `incomplete`, `trialing` or terminal provider states into paid access.
2. An active subscription scheduled to cancel keeps paid access until the paid period ends. The UI and sending controls must describe that state consistently.
3. A Solo organisation receives one local trial grant. Stripe Checkout may preserve only the unused portion of that original trial and may never create or extend a second trial.
4. A cancelled customer may resubscribe using the same Stripe customer. The signed Checkout event may replace the cancelled subscription identifier, while stale events for the previous subscription remain rejected.
5. Current Stripe subscription-item period fields and the legacy subscription-level fields are both accepted after full validation.
6. Solo SMS sending is hard-capped at the configured included allowance. Persisted legacy overage flags are ignored until genuine metered billing is deliberately implemented.
7. Customer-facing billing, legal and support copy must say that sends exceeding the allowance are blocked. It must not promise paid overage or automatic replay.
8. `INTERNAL_LEGACY`, platform verification and the limited verified-admin trial test paths retain their existing exemptions.

## Fail-closed handling

Historical `CANCEL_AT_PERIOD_END` rows are ambiguous because older code could produce that value from non-paying provider states. The migration changes those rows to `INCOMPLETE`; a fresh verified Stripe lifecycle event restores the correct state. This may temporarily pause a legitimately scheduled cancellation, but it cannot incorrectly enable sending after payment failure.

The original local trial deadline remains immutable. Lifecycle events may shorten it but cannot erase or extend it. Existing Solo rows without a trial deadline receive a historical deadline based on their creation time, which cannot create a new future trial for an older account.

## Data and compatibility

- Keep existing SMS overage columns for schema compatibility, but remove them from the runtime allowance decision and customer usage view.
- Add only an additive migration plus safe data reconciliation; no records are deleted.
- Checkout completion alone never grants access. Only a verified subscription lifecycle event can set `ACTIVE` or `CANCEL_AT_PERIOD_END`.
- Existing Motts `INTERNAL_LEGACY` behaviour remains unchanged.

## Verification

Use test-first development for every change. Required coverage includes the Stripe status matrix, entitlements for scheduled cancellation and failed payment, current and legacy period fields, immutable one-time trials, cancelled-subscription replacement in both webhook orders, stale-event rejection, a stored-overage hard-cap regression, exact SMS boundary handling and customer-facing hard-cap copy.
