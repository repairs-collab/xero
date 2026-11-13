# Paid beta direct-debit preflight

This procedure is mandatory before a paid beta account can request Australian
direct debit. It does not call Stripe or change a provider payment method.
Provider inspection and any corrective action are performed manually by the
platform owner in Stripe.

## Fail-closed rule

An organisation with any unresolved `LEGACY_UNBOUND` direct-debit record is
not eligible for a new request, setup link, mandate activation, or setup-link
delivery. The customer Billing page must show a neutral support message. The
Owner panel must show `RECONCILIATION_REQUIRED` and the exact legacy request ID.

Do not treat a card-only Billing Portal configuration as proof that Stripe will
collect by card. The effective collection path can also be influenced by a
subscription default, the customer's invoice default or source fallback,
historical subscription episodes, open invoices, and scheduled invoice retry
state.

Initial-card evidence is eligible only when AccountPulse has a validated paid
Checkout attempt whose Session, Stripe customer and Stripe subscription all
match the current billing episode. Migration `0042` moves evidence that cannot
meet that identity test out of current eligibility, preserves the opaque values
in legacy storage and the audit log, and blocks direct-debit requests. Do not
copy the legacy values back or override this check. The customer must complete
a fresh AccountPulse card Checkout for the current subscription episode before
requesting direct debit.

## Read-only database preflight

Run this query against the production database before admitting a paid beta
account or selecting a rollback image:

```sql
SELECT organisation_id, id AS direct_debit_request_id, legacy_status,
       requested_at
FROM direct_debit_requests
WHERE status = 'LEGACY_UNBOUND'
  AND provider_reconciled_at IS NULL
ORDER BY organisation_id, requested_at, id;
```

Zero rows is required for an unrestricted paid-beta release. When rows are
returned, only those affected organisations remain blocked; do not bypass or
delete the records.

## Owner verification for each displayed request

For the exact organisation and legacy request ID shown in the Owner panel:

1. Open the matching Stripe customer.
2. Inspect the effective payment method on every relevant current and
   historical subscription episode.
3. Inspect `invoice_settings.default_payment_method` and the legacy customer
   source fallback.
4. Inspect open invoices, scheduled retries, and any pending automatic
   collection that could still use the legacy payment method.
5. If a legacy default or retry remains, resolve it manually in Stripe. Never
   enter or copy customer bank, BSB, or card details into AccountPulse.
6. Record exactly one safe outcome for the displayed request. Enter only an
   opaque reference in this format:
   `cus_REFERENCE|sub_REFERENCE|pm_REFERENCE`, or use `none` in the final
   segment only when no effective payment method remains.
7. Refresh the Owner panel. If another legacy request is displayed, repeat the
   procedure for that exact ID. A stale or duplicate submission must fail and
   must not reconcile the next request.

The audit event must identify the owner, timestamp, organisation, exact legacy
request ID, structured outcome, and validated opaque provider reference.

## Release and rollback boundary

Migration `0038` quarantines ambiguous historical state. Later migrations add
the evidence binding and a database trigger that prevents older application
code from inserting or promoting fresh direct-debit state while unresolved
history exists.

Both automatic release rollback and `deploy/ovh/rollback.sh` use the same
compatibility check. If unresolved history exists, web and worker remain
stopped and the rollback must fail. Restore the current compatible images,
complete Owner verification, and only then reconsider an older image. Do not
restore an old database and do not mutate Stripe as part of rollback.

## Completion evidence

Record the following in the beta release evidence:

- the read-only preflight result;
- the current immutable application SHA;
- the database migration version;
- the Owner audit event IDs for every affected request;
- confirmation that customer request/setup/activation remained blocked until
  all records for that organisation were resolved;
- confirmation that any current initial-card evidence is backed by the matching
  `solo_checkout_attempts` Session/customer/subscription episode, or that the
  customer completed a fresh card Checkout after quarantine;
- confirmation that no provider call or payment-method mutation was performed
  by the migration or rollback scripts.
