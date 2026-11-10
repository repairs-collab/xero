# AccountPulse OVH deployment runbook

The AccountPulse web app, worker, PostgreSQL data, release artifacts and voice services run on OVH. AWS Cognito remains an external identity provider only; it is not an application hosting platform or a release target.

## AccountPulse public origin preparation

The confirmed commercial origin is `https://ap.motts.com.au`. The customer launcher is
`https://ap.motts.com.au/start`, direct self-signup is
`https://ap.motts.com.au/auth/login?mode=signup&returnTo=%2Fonboarding`, the Xero callback is
`https://ap.motts.com.au/xero/callback`, and the Xero webhook is
`https://ap.motts.com.au/api/webhooks/xero`.

Crazy Domains now has an `A` record for `ap.motts.com.au` pointing to the existing OVH IPv4
address `15.235.63.138`, with TTL 300. On 2026-11-09 the authoritative
`ns1.crazydomains.com` answer was verified, and the existing `billchaser.motts.com.au` record was
left unchanged. The new hostname is not yet callback-ready because HTTPS and application routing
have not passed verification. Before beta deployment, add the hostname to the existing OVH HTTPS
reverse proxy without removing the `billchaser.motts.com.au` site, obtain and verify its
certificate, and prove that the launcher, callback and webhook paths reach the new AccountPulse
web container. Record the DNS answer, certificate subject/expiry and HTTP readiness results in the
release evidence. Do not register the URLs as production-ready before those checks pass.

On 2026-11-10 an external browser check reached ERR_SSL_PROTOCOL_ERROR for
`https://ap.motts.com.au/`. This proves the DNS destination is not yet serving
a valid TLS endpoint for that hostname; it is not an application-level failure.

The reviewed host change is split into `deploy/ovh/accountpulse-site.caddy`
and `deploy/ovh/install-public-hostname.sh`. Transfer both to the protected
production deploy path, inspect the live Caddyfile and run the installer only
through an approved production change. The installer:

1. refuses to proceed unless the existing `billchaser.motts.com.au` block and
   health endpoint are present;
2. refuses to append a duplicate `ap.motts.com.au` block;
3. validates a candidate Caddyfile before replacing the live file;
4. stores a timestamped recoverable backup;
5. reloads Caddy and restores the old file if any later check fails;
6. verifies both host health endpoints with normal certificate validation; and
7. prints the new certificate subject, issuer, validity and subject alternative
   names for release evidence.

Do not bypass a TLS warning and do not point the hostname at a different
temporary application merely to obtain a certificate.

## Verified OVH host baseline

The OVH control panel was inspected on 10 November 2026. The current target is
active VPS `vps-b27aff15.vps.ovh.ca` at IPv4 `15.235.63.138`, Beauharnois (BHS),
Canada. It has the Standard automated-backup option with a daily schedule at
04:38 UTC and rotation 1; one restore point dated 9 November 2026 at 15:38 was
available. Snapshot was disabled. Treat this as provider-level rollback
evidence only: retain the release script's PostgreSQL backup and complete the
staging restore drill before commercial promotion.

## Protected environments

Create GitHub environments named `staging` and `production`. Require a reviewer for both, with the production reviewer group kept smaller. Configure these environment values:

- Variables: `OVH_HOST`, `OVH_PORT`, `OVH_USER`, `OVH_DEPLOY_PATH`, `HOSTNAME`
- Secrets: `OVH_SSH_PRIVATE_KEY`, `OVH_SSH_HOST_KEY`

`OVH_SSH_HOST_KEY` is the complete, independently verified `known_hosts` line for the OVH server. The workflow installs it before any connection and never uses an unverified host-key scan.

On each OVH environment, create the protected file `${OVH_DEPLOY_PATH}/accountpulse.env` from `deploy/ovh/env.example`. It must be readable only by the deployment account. Keep the populated environment file, database backups and release records outside Git.

The deployment account needs Docker access and write access only to its environment's `OVH_DEPLOY_PATH`. Staging and production use different paths, databases, hostnames and environment files.

## Normal release

Run the `AccountPulse OVH Release` workflow for a reviewed commit on `main`.

1. GitHub installs locked dependencies, audits, lints, type-checks, tests and builds once.
2. The workflow builds web and worker images tagged with the full Git commit SHA and uploads those exact images as a short-lived artifact.
3. After staging approval, the workflow transfers the images, Compose file and release scripts over host-key-pinned SSH.
4. `release.sh` takes an exclusive lock, records the previous image manifest, creates a PostgreSQL custom-format backup, runs the database migration in the candidate worker image, starts the candidate images and checks `/health/ready`.
5. A failed migration or readiness check restores the previous Compose image values. The pre-release database backup is retained for investigation; it is never overwritten automatically.
6. The workflow records staging release metadata. Production receives the same image artifact only after production approval and repeats the same checks.

Never use a mutable image tag. Record the Git SHA, workflow URL, environment approval, backup path, migration result, readiness result and downloaded release-metadata artifact as release evidence.

## Rollback

List the recorded releases under `${OVH_DEPLOY_PATH}/releases`. Choose a known-good full Git SHA, then run on the relevant OVH host:

```bash
cd /the/protected/OVH_DEPLOY_PATH
./rollback.sh FULL_40_CHARACTER_GIT_SHA accountpulse.example.com
```

The rollback script accepts only a manifest previously recorded for that exact immutable SHA. It takes the same exclusive lock, restores the selected web and worker images, leaves PostgreSQL untouched and checks `/health/ready`. Review any forward database migration for compatibility before rolling application code back.

If a database restore is genuinely required, stop and use the separate restore procedure with a new database target. Never overwrite the current database or replay customer communications as part of a normal rollback.

## Backup and release evidence

Pre-release backups are stored in `${OVH_DEPLOY_PATH}/backups` and named with the candidate SHA and UTC timestamp. Release and rollback metadata live under `${OVH_DEPLOY_PATH}/releases/FULL_SHA`. Apply the organisation's retention and encrypted off-host backup policy to both directories.

## Secret rotation

Edit the protected `accountpulse.env` on staging first, run a staging release of the currently approved SHA, and verify integration health. Then repeat through the protected production environment. Keep the previous Xero encryption key in `XERO_TOKEN_ENCRYPTION_KEYS_JSON` during key rotation until every stored envelope has been re-encrypted with the active key.

For Sinch callback key rotation, retain both public key IDs during the overlap. Removing an old credential is a separate, audited operation after traffic confirms it is no longer used.

## Solo SMS number pool and allowance

Migration `0018_keen_shadow_king.sql` adds the dedicated Australian number
pool, per-organisation allowance settings and append-only usage ledger. Before
enabling paid Solo onboarding in an environment:

1. Acquire and register numeric Australian two-way numbers in the AccountPulse
   Sinch account. Confirm each number is permitted as the REST API
   `source_number` and can receive replies.
2. Insert only those provider-owned numbers into `sms_number_pool` with a unique
   provider reference and `AVAILABLE` status. Do not add a sender ID or a number
   that has not passed a real reply test.
3. Set `SMS_NUMBER_QUARANTINE_DAYS` to the period approved in the provider
   contract and legal/privacy review. There is intentionally no application
   default. A cancelled account job fails closed rather than releasing a number
   under an invented period.
4. Reconcile a test Stripe subscription. The signed ACTIVE webhook publishes
   `sms-number.provision`; the worker reserves one number and records READY
   evidence. Payment does not itself enable Customer Live.
5. Complete the eight-step onboarding checklist. The final step reads the READY
   pool record; it is not a manually editable checkbox.
6. Send a multi-part test and verify Billing shows committed and reserved parts.
   Paid customer sends stop before exceeding 2,000 parts unless a verified rate
   and explicit AUD-cent cap have both been configured.
7. Reply to the assigned number. The webhook must resolve the organisation by
   `destination_number` before debtor/contact matching. An unknown destination
   is acknowledged but not persisted into any tenant.

During the Motts compatibility period, set `WEBHOOK_ORGANISATION_ID` only to
the existing `INTERNAL_LEGACY` organisation UUID. A reply that has no dedicated
pool match may use its provider-signed `organisationId` metadata only after the
database confirms that exact organisation is `INTERNAL_LEGACY`; legacy opt-outs
are resolved through their original stored provider message ID. There is no
blanket fixed-tenant callback fallback in multi-tenant mode, and Solo replies
never use legacy metadata. Remove the value only after the legacy Sinch sender
path has been deliberately retired.

Provider submission uses the provider-neutral SMS boundary. The Sinch adapter
sets the assigned numeric number as `source_number`; legacy internal tenants
retain the account-default sender path. Verification OTPs remain
platform-funded and are excluded from the customer allowance. An unknown
submission outcome remains reserved until reconciliation; a definite provider
rejection releases the reservation.

The number-pool import and quarantine release are protected operational
activities. Public beta is blocked until the pool inventory, live reply routing,
provider billing reconciliation and approved quarantine period have release
evidence.

## Legacy AWS application resources

Decommissioning the former AWS application stacks, alarms, databases, logs, images or deployment roles is not part of an AccountPulse release. It requires a separate inventory, data-retention evidence, traffic verification, owner approval and recoverable deletion plan. Cognito remains active unless a separately approved identity migration replaces it.
