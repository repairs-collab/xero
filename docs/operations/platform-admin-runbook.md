# AccountPulse platform-owner console runbook

This runbook covers the private `/platform-admin` console. It is for the
AccountPulse platform owner and release operator, not customer administrators.
The console can inspect every customer, manage trials and platform suspension,
administer customer users, register and assign Sinch numbers, set SMS allowances,
and review the append-only platform audit log.

## Safety rules

- Release only through the protected OVH process in `deploy/ovh/release.sh`.
- Keep the existing `SEND_MODE`, rollout scope, customer sequences, Xero links,
  assigned numbers and SMS allowances unchanged during deployment.
- Never paste Sinch, Stripe, Xero, database or Cognito secrets into console
  reasons. Reasons are visible in the platform audit log.
- Do not set a number to `READY` until a real outbound SMS and inbound reply have
  both been verified for that exact number in the Australian Sinch account.
- Suspension is an operational stop, not subscription cancellation. Stripe
  remains authoritative for paid subscription state.
- A normal rollback changes application images only. Do not drop the additive
  platform-administration schema.

## Before release

1. Record the candidate full Git SHA and the currently deployed SHA.
2. Confirm the release has passed lint, type-check, unit/integration, build and
   browser tests.
3. Inspect the pending migrations, including
   `packages/db/drizzle/0022_yummy_darwin.sql`. They must contain no credential
   values or destructive changes to customer status, numbers or allowances.
4. Confirm the protected OVH environment file and image manifest are present.
   This release adds no new secret or environment variable.
5. Confirm enough disk space exists for the immutable images and a PostgreSQL
   custom-format backup.

The OVH release script creates a non-empty `pg_dump` backup before migration and
records its path in the release metadata. Do not continue if that backup step or
the previous-image manifest check fails.

## Migration and owner verification

Run the normal protected OVH release. The candidate worker applies migrations
before the web and worker images are promoted. After migration, use a protected
database session to run read-only checks:

```sql
select email, platform_role, disabled_at
from users
where lower(email) = 'repairs@motts.com.au';

select count(*) as other_platform_owners
from users
where platform_role = 'OWNER'
  and lower(email) <> 'repairs@motts.com.au';

select platform_status, count(*)
from organisations
group by platform_status
order by platform_status;
```

Expected result: the active `repairs@motts.com.au` row is `OWNER`, the second
query is zero unless another owner was deliberately approved after this release,
and pre-existing organisations remain `ACTIVE`. Stop and investigate any
unexpected owner or suspended customer.

## Post-release smoke check

1. Confirm `https://ap.motts.com.au/health/ready` succeeds with normal TLS
   validation.
2. Sign in as `repairs@motts.com.au` and open `/platform-admin`.
3. Confirm Overview, Customers, Sinch & SMS, and Audit load.
4. Confirm the known beta customer displays the expected Xero tenant,
   subscription/trial, assigned number, SMS usage and last sync.
5. Sign in as an ordinary customer administrator and confirm `/platform-admin`
   returns a not-found page and the customer navigation has no platform link.
6. Confirm page source and browser-visible text contain no token, ciphertext,
   secret reference or provider credential.
7. Perform read-only checks on the existing customer application, billing,
   outbox and audit pages. Do not change sending state as a smoke test.

## Sinch number lifecycle

### Register and verify the allocation pool

1. In **Sinch & SMS**, register an Australian E.164 number such as
   `+61412345678`, its non-secret Sinch provider number ID if already known, and
   an operational reason.
2. Confirm the number appears as `AVAILABLE` and **Not verified for automatic
   allocation**. A provider ID by itself is not proof that the number is safe.
3. In Sinch APAC, confirm ownership, a controlled outbound SMS, the inbound
   reply/webhook route and the exact non-secret provider number ID. Enter that
   evidence in the reason field, confirm the checklist and select **Verify for
   automatic allocation**.
4. Confirm the number remains `AVAILABLE` but now shows **Verified for automatic
   allocation**. Only records with this owner verification are eligible for
   automatic paid-customer allocation. If the pool is empty, onboarding must
   remain blocked rather than assigning an unverified number or changing any
   customer's live-sending state.

### Assign manually

1. Assign an available number to the intended customer. Exactly one owner can win a concurrent
   assignment; if a conflict appears, refresh and inspect the current owner.
2. The number is now `RESERVED`. This is not permission to send customer SMS.

### Verify before READY

In Sinch APAC, verify that the exact number:

- is owned by the AccountPulse account and permitted as the REST API source;
- can submit a controlled SMS to a staff handset;
- receives a staff reply in the Sinch inbox/webhook path;
- routes that reply to the assigned AccountPulse organisation; and
- has the correct non-secret provider number ID.

Record a concise verification reason, enter the provider number ID, and only
then select **Mark ready**. Do not include message content, phone-owner data or
credentials in the reason. This manual fallback also records the provider
verification time before changing the assigned number to `READY`.

### Release and cooling

Releasing an assigned number starts a 30-day `QUARANTINED` period. The former
organisation remains associated during cooling so late replies stay correctly
routed. The return-to-pool action must fail before the cooling date. After the
date, verify there are no unresolved reply-routing incidents, then return it to
the pool with a reason. Owner-initiated quarantine/release clears allocation
verification. Subscription cooling may retain it only while the number remains
bound to the same customer so that customer can reactivate safely; returning it
to the shared pool always clears it. Complete the full Sinch verification
checklist again before the number can be selected for another customer. Never
bypass cooling by editing the database.

## SMS allowance changes

On the customer detail page, compare the requested plan with current committed
and reserved SMS parts. Enter included parts from 1 to 1,000,000 and a warning
percentage from 1 to 100, add the commercial reason, confirm, and save. The
change must not rewrite usage history. Check the audit entry and Billing view
afterward.

## Trial changes

Stripe is authoritative for paid subscriptions. Extend only a `TRIALING`
subscription, by no more than 90 days from server time. State the approved
reason and confirm the new date. If the record changed or Stripe activated or
cancelled the subscription first, refresh; do not force the stale action. Ending
a trial is immediate and must be treated as a customer-impacting operation.

## Suspend and reactivate

Before suspension, verify the customer, reason and impact with the owner. Select
**Suspend account** and confirm. Suspension must:

- keep sign-in, historical reads, outbox, audit and billing access available;
- block customer operational server actions; and
- block automatic/manual/test SMS and voice dispatch in the worker.

Confirm the customer sees the suspension banner and that a direct operational
action is denied. Review the platform audit event. Reactivate only after the
underlying issue is resolved and the current platform status/version is visible.
Record a new reason, reactivate, and verify normal entitlement checks resume.
Suspension or reactivation must never alter Customer Live or dry-run settings.

## Customer user administration

The owner console reuses the existing invitation, role and disable safeguards.
It cannot remove the last active organisation administrator. Use a reason for
every invite, resend, role change and disable action. Confirm the target
organisation and email before submitting, then verify the corresponding
platform audit entry.

## Audit review

Use `/platform-admin/audit` to filter by customer, actor and event. Verify the
actor, target, reason and safe before/after summary. The audit table is
append-only. Never attempt to correct history by updating or deleting an event;
record a new corrective action instead.

## Application rollback

If the new application is unhealthy, choose the previous recorded immutable SHA
and run the protected OVH rollback described in `docs/runbooks/deployment.md`.
The rollback script restores web and worker images together, leaves PostgreSQL
untouched and checks `/health/ready`.

The platform migrations are additive and compatible with the prior application.
Do not drop `platform_admin_audit_events`, `users.platform_role`,
`sms_number_pool.provider_verified_at` or the organisation platform-status
columns during application rollback. Keep the
pre-release backup for investigation. If a database restore is genuinely
required, stop and follow `docs/runbooks/restore.md` into a new database target;
never overwrite production as part of a normal rollback.

After rollback, recheck health, customer login, Xero sync, SMS/email sending,
Inbox and the production sending state. Do not replay jobs or customer messages
whose provider outcome is uncertain.
