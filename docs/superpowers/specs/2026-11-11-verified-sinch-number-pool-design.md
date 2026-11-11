# Verified Sinch Number Pool Design

## Intent

AccountPulse needs a safe Australian beta path while the Sinch EMSP and automated-number-provisioning arrangements are being negotiated. AccountPulse will not order numbers from Sinch in this release. The platform owner will lease and verify dedicated numbers in Sinch, place them in an AccountPulse pool, and AccountPulse will allocate only verified entries to paid customers.

## Goals

- Prevent automatic customer allocation of an unverified Sinch number.
- Preserve one dedicated Australian reply number per paid organisation.
- Keep customer sending blocked until a verified number is assigned and ready.
- Make verification state visible and auditable in the owner console.
- Preserve the 30-day quarantine before number reuse.
- Leave the current internal legacy organisation and Customer Live sending mode unchanged.

## Non-goals

- Purchasing, renting or activating numbers through the Sinch Numbers API.
- Creating Sinch subaccounts or completing the EMSP agreement.
- Supporting non-Australian number pools.
- Changing subscription prices, SMS allowances or Xero connection limits.

## Approaches considered

1. **Treat a provider ID as verification.** This is the smallest code change, but a copied provider ID does not prove the number can send or receive through the AccountPulse Sinch account.
2. **Store explicit provider verification evidence.** Add a non-secret verification timestamp, require the owner to confirm the Sinch ownership/outbound/inbound checks, and allow automatic allocation only from verified rows. This is the selected approach because it fails closed without requiring Sinch provisioning APIs.
3. **Manually assign every customer number.** This is safe but defeats self-service activation and does not scale even to the 50-connection Core beta tier.

## Behaviour

`sms_number_pool.provider_verified_at` is null until the platform owner completes the Sinch checks. A provider number ID is mandatory when recording verification. Verification records only the timestamp, actor and operational reason; it never stores credentials, message content or customer phone data.

The owner may verify an unassigned `AVAILABLE` pool entry. Paid-subscription provisioning uses one transaction and a row lock to select the oldest `AVAILABLE` entry whose provider ID and verification timestamp are both present. It reserves that entry for the organisation and then marks it `READY`. If no eligible entry exists, provisioning fails with `SMS_NUMBER_POOL_EXHAUSTED`; customer sending remains blocked by `REPLY_NUMBER_NOT_READY`.

The existing manual fallback remains available: an owner may assign an unverified number to a customer as `RESERVED`, perform the controlled Sinch tests, then use **Mark ready**. That action stores the provider ID and verification timestamp before enabling the number.

Owner-initiated quarantine or release clears provider verification. A subscription cancellation may preserve verification while the number remains quarantined and bound to the same organisation, allowing that same customer to reactivate safely during cooling. Returning any number to the shared pool clears verification, so the owner must repeat the controlled Sinch checks before it is eligible for a different automatic assignment. This deliberately favours safety without breaking same-customer reactivation during beta.

## Safety and evidence

- Automatic allocation requires `status = AVAILABLE`, a provider number ID and `provider_verified_at`.
- Database uniqueness continues to enforce one active number per organisation and no duplicate provider number ID.
- Every verification, assignment, ready, quarantine and pool-return action remains owner-only and audited.
- Tests cover unverified exclusion, verified selection, empty verified pool, manual verification and mandatory re-verification after quarantine return.
- No deployment step may alter organisation send mode, rollout scope or live acknowledgement.
