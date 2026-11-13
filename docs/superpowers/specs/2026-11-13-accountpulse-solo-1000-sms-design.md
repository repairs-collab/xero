# AccountPulse Solo 1,000 SMS Design

## Intent

Keep AccountPulse Solo at A$299 per month excluding GST while changing the
included allowance from 2,000 to 1,000 outbound SMS parts per monthly allowance
cycle. The change protects the commercial margin while allowing low-volume
customers to share the provider bundle efficiently.

## Product rules

- Solo includes up to 1,000 outbound SMS parts per monthly allowance cycle.
- Annual billing keeps the approved 5% discount and still resets the allowance
  monthly.
- Unused parts expire, do not roll over, have no cash value and do not reduce
  the fixed subscription price.
- Additional outbound SMS parts above the included 1,000 are billed at A$0.11
  each excluding GST. A billing hold or failed payment still blocks sending.
- Usage is counted only when AccountPulse reserves or commits real SMS parts
  under the existing ledger rules. Provider cost therefore follows actual
  accepted traffic, although Sinch's fixed plan fee does not fall when bundle
  credits are unused.
- One dedicated Australian reply number remains included after successful
  payment and provisioning.

## Compatibility

The existing internal identifier `SOLO_AU_2000` remains unchanged for this
release because it is embedded in Stripe metadata, database constraints and
subscription lifecycle events. It is a legacy opaque identifier and must not
be shown to customers. Renaming it during the allowance change would create an
unnecessary billing migration risk.

New Solo organisations receive 1,000 parts. The database migration also moves
existing uncustomised Solo rows that still equal the old 2,000 default to
1,000. Any organisation with an audited owner allowance adjustment keeps its
explicitly configured amount.

## Customer and marketing copy

All active app, support, legal, marketing and Xero-listing copy must say:

> AccountPulse Solo includes up to 1,000 outbound SMS parts in each monthly
> allowance cycle. Additional outbound SMS parts cost A$0.11 each excluding
> GST. Unused included parts and overage do not roll over.

Historical implementation plans may retain their original values when clearly
superseded by this design, but no current operational or customer-facing
document may advertise 2,000 parts.

## Approaches considered

1. **Keep the stable plan identifier and change the entitlement** — selected.
   It delivers the commercial change with the smallest billing and deployment
   risk.
2. **Create `SOLO_AU_1000` immediately** — clearer naming, but it requires a
   coordinated Stripe product/price, webhook, database and live-subscription
   migration before beta.
3. **Leave the application at 2,000 and change only marketing** — rejected
   because the app would grant more usage than the advertised plan and the
   cost control would not exist.

## Release checks

- The domain default, database default, repository fallbacks and owner new-
  customer form all resolve to 1,000.
- The 80% warning begins at 800 projected parts.
- Exactly 1,000 parts are included and the 1,001st eligible part is recorded as
  metered overage at A$0.11 excluding GST.
- Existing audited custom allowances remain unchanged by migration.
- Billing, support, legal, marketing and listing copy contain no active 2,000-
  part claim and state the approved A$0.11 overage rate consistently.
