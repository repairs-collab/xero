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

The rollback script accepts only a manifest previously recorded for that exact immutable SHA. It takes the same exclusive lock, stops web and worker, and transactionally changes scheduled cancellations to incomplete and pauses the affected organisations before starting the selected images. Automatic rollback uses the same safeguard. If stopping services or reconciliation fails, older images must remain stopped until the failure is resolved. PostgreSQL and its records are preserved; no database restore occurs. The script checks `/health/ready`. Review forward database migrations for compatibility before rolling application code back.

Before a paid beta release or rollback involving the direct-debit migrations,
complete the fail-closed preflight in
[`paid-beta-direct-debit.md`](paid-beta-direct-debit.md). Never assume a
card-only Billing Portal configuration proves the effective Stripe collection
path is card-only.

If a database restore is genuinely required, stop and use the separate restore procedure with a new database target. Never overwrite the current database or replay customer communications as part of a normal rollback.

## Backup and release evidence

Pre-release backups are stored in `${OVH_DEPLOY_PATH}/backups` and named with the candidate SHA and UTC timestamp. Release and rollback metadata live under `${OVH_DEPLOY_PATH}/releases/FULL_SHA`. Apply the organisation's retention and encrypted off-host backup policy to both directories.

## Owner-only server health snapshot

The AccountPulse Owner console reads a sanitized host snapshot from a read-only
mount. It never receives the Docker socket, a shell, host credentials or a host
filesystem path. The snapshot contains uptime, CPU load, memory and root disk
capacity, the live capacity and ID of OVH disk 698708443 (nominal 200 GB), a UTC
check time, and the health of the fixed `web`, `worker`, `postgres` and `caddy`
containers. The worker health check requires a fresh heartbeat written after
queue and handler registration. The collector also reports aggregate counts
for Customer Live workspaces with no completed reminder calculation in
25 minutes or no successful Xero sync in 90 minutes. The query uses a
bounded, read-only transaction and outputs only counts.

The protected release installs the collector if the OVH deployment account
already has noninteractive permission to run the installer. If the release
reports that host installation is needed, install from the reviewed release
directory:

```bash
cd /the/protected/OVH_DEPLOY_PATH
sudo ./install-server-health-monitor.sh
```

The installer runs one collection, then enables a five-minute systemd timer.
Verify it without changing application state:

```bash
systemctl status accountpulse-server-health.timer --no-pager
systemctl status accountpulse-server-health.service --no-pager
test -r /var/lib/accountpulse/server-health/server-health.json
journalctl -u accountpulse-server-health.service -p warning --since today
```

The collector logs an alert when it detects a worker failure, overdue
reminder checks or stale Xero sync. Owner → Server health shows the same
checks. To deliver alerts by email, configure the existing mail relay in
root-owned `/etc/accountpulse/server-health-mail.curl` with mode `0600`.
Set `url` to its TLS-only `smtps://` endpoint and supply `user`,
`mail-from` and `mail-rcpt` for `ap@motts.com.au`. The collector accepts
only SMTPS and emails the same alert at most once per hour while it persists.
Keep credentials off GitHub and out of the snapshot. This runs on the OVH
host and cannot alert during a complete host outage.

Do not add the Docker socket to the web container. Do not extend the snapshot
with hostnames, IP addresses, environment values, credentials, process command
lines, customer data or provider secrets. If the collector is absent, fails, or
has not refreshed for more than 15 minutes, the Owner console must show
**Unavailable** rather than reusing old values.

### Owner worker repair

Install the protected runner after releasing the worker heartbeat and the
repair migration. Use the existing deployment directory and the OVH account
with host administration access.

```bash
cd /the/protected/OVH_DEPLOY_PATH
sudo bash ./install-worker-repair.sh
systemctl status accountpulse-worker-repair.timer --no-pager
journalctl -u accountpulse-worker-repair.service -n 20 --no-pager
```

Once the runner reports in, the Owner can request a repair from
**Owner → System**. Each request permits one verified worker restart. The
runner waits while a deployment holds the host lock and declines a restart
when the worker is healthy or starting, the image needs a corrected release,
or queued work requires review. Sending settings and queued records stay
intact. New scheduler work and authorised operator actions follow the
existing rules. Review the worker state and logs if a started repair expires.

## Secret rotation

Edit the protected `accountpulse.env` on staging first, run a staging release of the currently approved SHA, and verify integration health. Then repeat through the protected production environment. Keep the previous Xero encryption key in `XERO_TOKEN_ENCRYPTION_KEYS_JSON` during key rotation until every stored envelope has been re-encrypted with the active key.

For Sinch callback key rotation, retain both public key IDs during the overlap. Removing an old credential is a separate, audited operation after traffic confirms it is no longer used.

## Solo shared SMS and allowance

Follow the [Sinch provider setup](provider-setup.md#shared-pool-for-accountpulse-solo)
to link an existing Australian Sinch sub-account to each Solo workspace and
use its shared sender pool. The subscription reserves no number at signup.
Before enabling Customer Live for a new workspace, verify payment, complete
onboarding and verify a controlled test through the linked account.

Exercise inbound isolation by sending from two configured workspaces to the
same approved test handset. Check that replies and STOP messages go only to
the correct workspace. The callback resolver requires verified account and
outbound-message evidence. Missing or conflicting evidence stays out of
customer inboxes.

Verify that each workspace has 1,000 included outbound parts and an A$0.11
ex GST charge per additional committed part. Exercise the threshold with
controlled billing data and verify the overage is recorded and reported once.
Further overage is blocked if the verified metered setup, rate or reporting
backlog fails its checks.

During the Motts compatibility period, set `WEBHOOK_ORGANISATION_ID` only to
the existing `INTERNAL_LEGACY` organisation UUID. A reply that has no dedicated
pool match may use its provider-signed `organisationId` metadata only after the
database confirms that exact organisation is `INTERNAL_LEGACY`; legacy opt-outs
are resolved through their original stored provider message ID. There is no
blanket fixed-tenant callback fallback in multi-tenant mode, and Solo replies
never use legacy metadata. Remove the value only after the legacy Sinch sender
path has been deliberately retired.

Existing dedicated-number assignments keep their current sender and
lifecycle. The legacy internal workspace continues to use the account default.
Verification OTPs remain platform-funded. An unknown submission outcome
remains reserved until reconciliation. A definite provider rejection
releases the reservation.

## Legacy AWS application resources

Decommissioning the former AWS application stacks, alarms, databases, logs, images or deployment roles is not part of an AccountPulse release. It requires a separate inventory, data-retention evidence, traffic verification, owner approval and recoverable deletion plan. Cognito remains active unless a separately approved identity migration replaces it.
