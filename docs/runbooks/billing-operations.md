# AccountPulse billing operations runbook

## Purpose and authority

Use this runbook for Stripe payment failures, recoveries, refunds, disputes and
chargebacks affecting an AccountPulse customer. Stripe Dashboard is the
payment processor and financial system of record. AccountPulse stores signed
webhook evidence and applies service-safety controls; it does not replace
Stripe receipts, settlement records, dispute evidence or tax records.

Only an authenticated AccountPulse platform owner may use the private
`/platform-admin/billing` queue or reactivate a suspended customer. Customer
administrators cannot access these controls. Never change billing case,
subscription or organisation rows directly in the database.

## Non-negotiable safeguards

- A Checkout success page does not grant service. Only a verified Stripe
  webhook may establish trusted subscription state.
- A blocking billing case suspends provider submissions without changing the
  customer's saved sequence or live-mode choices.
- A recovery webhook may resolve its case, but it never reactivates the
  customer automatically.
- Owner reactivation is rejected while any case for that customer is both
  unresolved and marked as blocking sending. There is no override or bypass.
- The notices shown under **Held — not delivered** have not been emailed.
  They are immutable evidence for a later transactional-email release, not a
  customer communication log. Do not tell a customer that AccountPulse sent
  one and do not mark one as delivered manually.
- The owner billing queue is read-only. Case resolution comes from verified
  provider evidence, not from a button, URL edit or database change.
- Never copy card data, Stripe secrets, webhook signatures or raw webhook
  payloads into AccountPulse, tickets, chat or email.

## Paid Checkout cutover

1. Pause new paid Checkout starts on the old release before the cutover.
2. Inventory old open and recent Solo subscription Checkout Sessions in Stripe
   Dashboard or through read-only Stripe access. Include Sessions with no
   Stripe customer yet. Use the organisation in Checkout metadata and the
   client reference to match those Sessions, and record their Stripe Session IDs.
3. Hold affected organisations from starting paid Checkout until Stripe confirms
   each earlier Session expired or completed. For completed Sessions, verify
   subscription ownership, signed lifecycle reconciliation, and whether multiple
   subscriptions were created. Escalate ambiguous or duplicate ownership and
   keep the affected organisations on hold.
4. Enable the new checkout path only after draining or isolating these holds.
   Keep checkout disabled if the affected organisations cannot be isolated.
   A local expiry timestamp cannot clear a hold. Use read-only reconciliation
   and the existing finance escalation process. This cutover runs without
   automatic Stripe expiry, cancellation or refunds.

If a new Checkout attempt has no Session ID after a lost provider response, a
same-option retry during the original attempt window can recover the Session.
After that window, use Stripe's Session history and signed event delivery to
match the organisation and attempt UUID. Keep the hold until Stripe evidence
resolves it. Do not reset or delete an attempt to reopen checkout.

## Daily review

1. Sign in to the private owner console with the owner account and MFA.
2. Open **Billing operations** and review blocking cases first, newest first.
3. Open the matching customer and Stripe customer/subscription in Stripe
   Dashboard. Match the AccountPulse customer, amount, currency, provider
   reference and current or retired subscription relationship.
4. Check Stripe's current object state, event history and required response
   deadline. Treat the AccountPulse case as evidence, not as authority to
   alter the Stripe record.
5. Record the review time, operator, Stripe state and next action in the
   approved incident or finance record. Do not include secrets or card data.
6. Review held notices separately. They remain unsent until monitored SMTP,
   approved templates and delivery procedures are released.

## Payment failure and recovery

When `invoice.payment_failed` opens a blocking case:

1. Confirm in Stripe Dashboard that the invoice belongs to the same customer
   and current subscription and is still unpaid.
2. Confirm AccountPulse shows the organisation as suspended. Do not enable
   sending or use an alternate provider route.
3. Follow the approved finance contact process. Until lifecycle email is
   released, communicate only through an approved human channel and record
   that communication outside the held-notice queue.
4. Ask the customer to update payment details through the Stripe-hosted Billing
   Portal. AccountPulse staff must never collect card details.
5. Wait for Stripe to process payment and for the signed `invoice.paid` event
   to resolve the matching case. A screenshot or customer statement is not a
   substitute for provider state.

Before explicit owner reactivation, verify all of the following:

- Stripe shows the intended subscription in a service-eligible state;
- the failed invoice is paid or otherwise settled under the approved policy;
- AccountPulse has no unresolved blocking payment or dispute case for the
  customer;
- there is no effective cancellation, unresolved dispute or other service
  hold; and
- the customer, reason and current AccountPulse version shown in the owner
  console are correct.

Then use the reasoned owner reactivation control. Record the reason and retain
the resulting platform audit event. If AccountPulse returns
`BILLING_RISK_HOLD`, stop: re-check Stripe and the billing queue. Do not attempt
to bypass it.

## Refund review

A signed refund event creates a review case. It does not by itself block
sending.

1. Match the charge, customer, cumulative refunded amount and currency in
   Stripe Dashboard.
2. Confirm the refund is permitted by the approved refund policy and identify
   the authorising finance record.
3. Confirm Stripe owns delivery of the processor refund receipt. AccountPulse
   does not claim a receipt was delivered until that is verified separately.
4. Record the business outcome and any customer communication in the approved
   finance record. Leave the AccountPulse queue unchanged; it is read-only
   operational evidence.
5. Escalate an unknown, duplicate, excessive or cross-customer refund
   immediately as a financial incident.

## Dispute and chargeback response

An opened dispute blocks sending even when it relates to a safely retained
historical subscription.

1. Open the dispute in Stripe Dashboard and record its response deadline.
2. Confirm the customer, charge, amount and dispute state match the AccountPulse
   case. Do not upload evidence from an unverified request or email link.
3. Notify the designated finance and security contacts. Preserve invoices,
   accepted terms, service records and customer communications under the
   approved retention and privacy procedures.
4. Submit evidence only through Stripe's approved dispute workflow and record
   who submitted it and when.
5. A provider-confirmed win may resolve the case, but service still requires
   explicit owner reactivation after the full checklist above. A loss or other
   review-required outcome remains a blocking hold. Escalate it; do not edit the
   database or invent a resolution.

## Cancellation and receipts

Scheduled and effective cancellation behaviour, processor receipt delivery and
all customer lifecycle emails remain commercial-release blockers. Until their
end-to-end evidence is complete:

- verify cancellation state and timing directly in Stripe Dashboard;
- do not describe a held AccountPulse notice as a cancellation email or
  receipt;
- do not restore service solely because a cancellation was reversed; apply the
  same trusted-state and no-blocking-case checks; and
- escalate any disagreement between Stripe and AccountPulse rather than
  choosing the more permissive state.

## Incident escalation

Escalate immediately when any of these occur:

- Stripe and AccountPulse identify different customers or subscriptions;
- a blocking case does not suspend sending;
- a paid/recovered event does not resolve the matching case;
- an owner can reactivate while a blocking case remains unresolved;
- a duplicate or older event changes the final case incorrectly;
- a held notice is delivered, or its immutable content changes;
- the billing queue exposes raw payloads, secrets, event IDs or card data; or
- the webhook, worker, database or audit trail is unavailable.

Pause affected onboarding and customer sending. Preserve timestamps, safe
provider references, AccountPulse case IDs, workflow/release identifiers and
relevant platform audit events. Never preserve secrets or raw card data in the
incident record.

## Required audit evidence

For each operational review retain:

- AccountPulse customer and billing case ID;
- safe Stripe object reference, amount, currency and provider state;
- whether the subscription was current or retired;
- whether sending was blocked and the observed organisation state/version;
- Stripe Dashboard verification time and operator;
- the decision, reason, escalation owner and due date;
- any explicit reactivation audit event; and
- confirmation that held notices were not represented as delivered.

For release evidence, prove signed failure, recovery, refund, dispute-open and
dispute-close handling; duplicate and out-of-order safety; blocking-case
reactivation refusal; redaction; and the read-only owner queue. This foundation
does not close the separate SMTP, lifecycle-email, receipt, cancellation,
monitoring/backup, data-lifecycle or genuine beta-journey gates.
