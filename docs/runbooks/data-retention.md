# AccountPulse data-retention and account-closure runbook

This runbook is the implementation record for AccountPulse Solo. It is not
legal advice and is not yet approved public policy. Support, security and
privacy enquiries go to ap@motts.com.au.

## Owner-approved policy target — 12 November 2026

K Heaton is the AccountPulse Privacy Officer. The owner selected five years
after account cancellation as the retention period for invoice, customer,
message, call and audit records, and a 14-day service target for verified data
export or deletion requests. Legally required records and legal holds are
excluded from deletion until the obligation ends. This is the approved policy
target; the implementation gaps identified below must be closed and tested
before the product promises automated deletion.

## Account closure

An expired trial or effective subscription cancellation immediately pauses
customer sending, disconnects Xero and removes the encrypted Xero refresh
token. AccountPulse records a review date 30 days later.

The 30-day date is **not an automatic database purge**. It remains an early
account-closure review date. A subscription cancellation also records
`deletion_eligible_at` as the trusted cancellation time plus five calendar
years. Existing cases are not guessed or backfilled when no trusted
cancellation time exists.

The daily retention job atomically changes a due SCHEDULED case to
REVIEW_REQUIRED. Retries are idempotent, a LEGAL_HOLD remains unchanged, and an
audit event records that automatic purge is disabled. Reaching the five-year
date does not delete anything: it only permits a separately authorised,
tenant-scoped manual review after legal-hold, required-evidence and backup-ageing
checks. This prevents an unresolved invoice, protected billing/audit record or
backup copy from being silently destroyed.

## Verified export and deletion requests

The owner console records only verified requests and opaque support-case
references. It sets `target_at = verified_at + 14 days`; the database rejects a
different target. Reusing the same tenant/idempotency key returns the original
request only when its verified facts match, and otherwise reports a conflict.

At or before the target, an owner can re-evaluate the request. The recurring
retention job also moves requests into review when the target becomes due:

- export requests move to IN_REVIEW;
- deletion requests under LEGAL_HOLD become BLOCKED with LEGAL_HOLD taking
  precedence over every other condition;
- requests before `deletion_eligible_at` remain BLOCKED;
- eligible requests remain BLOCKED until approved backup-ageing evidence is
  recorded; and
- an otherwise eligible request becomes MANUAL_REVIEW_REQUIRED so protected
  invoice, billing, mandate and audit evidence can be scoped before any
  separately authorised deletion.

Every select and mutation includes both request ID and organisation ID. A
successful transition increments the request version and writes one audit
event; retrying the same transition returns the existing state without another
audit. There is no owner-console control or worker path that performs destructive
tenant deletion.

## Record-category matrix

| Record category | Trigger | Current period | Implemented action | Account-deletion treatment |
| --- | --- | --- | --- | --- |
| Xero refresh token | Disconnect, expired trial or effective cancellation | Immediate | Revoke the remote Xero connection, null the encrypted local token and mark the connection disconnected | No token survives the disconnect |
| OAuth state and pending encrypted token | Consumed or expired OAuth transaction | At expiry | A global 15-minute cleanup deletes consumed/expired transient rows in bounded batches | Not tenant business data; removed independently |
| Unresolved contacts and invoices | Account review date reached | Until authorised review | Preserve and place the account in REVIEW_REQUIRED | Never automatically purge while business/legal handling is undecided |
| Outbound message content and provider payload | Related invoice resolved | 24 months | Replace content with [RETAINED_METADATA_ONLY]; replace provider payload with a metadata-only marker | Hashes, timestamps, outcomes, provider IDs and audit metadata remain |
| Inbound message and operator-reply content | Every invoice for the contact resolved | 24 months | Redact bodies and provider payloads; an unresolved or recently resolved invoice blocks redaction | Conversation metadata remains |
| Raw webhook projection | Event successfully processed | 90 days | Delete in bounded batches | An unprocessed event is never deleted by age alone |
| Customer, invoice, message, call and audit metadata | Account cancellation | Five years | Record deletion eligibility; preserve metadata after shorter content minimisation; never automatically delete | Legal holds and required evidence override eligibility; scoped manual review is mandatory |
| Subscription/payment record | Subscription/payment event | **Decision required** | Preserve; no automatic deletion duration is coded | Finance and Australian legal review must approve a period |
| Direct-debit mandate evidence | Provider-confirmed BECS mandate/service agreement | Up to seven years only where BECS or Stripe rules require it | Retain only the required mandate evidence through Stripe or securely | This narrow exception does not extend the period for other billing or account records |
| Database and release backup | Backup creation/source deletion | **Hosting evidence required** | Pre-release database dumps are created before deployment; no expiry deletion is coded | Public policy must use the verified OVH/off-site expiry, not an assumed duration |

The five-year account-record period is the owner-approved policy target. The
24-month content-redaction and 90-day raw-webhook periods remain shorter
data-minimisation controls that retain required metadata without keeping every
raw payload. Subscription/payment and backup durations remain deliberately
unset. Seven years applies only to direct-debit mandate evidence when BECS or
Stripe rules require it; it is not an audit, invoice, customer, message, call,
general billing or backup period. Do not copy the historical seven-year audit
or 35-day backup statements into public policy.

## Isolation, idempotency and retry safeguards

- Every tenant-content select, update and delete includes organisation_id;
  selected IDs are rechecked with the same tenant before a mutation.
- Account review transition requires the same organisation, SCHEDULED status
  and a due date. A second run cannot create a second transition audit.
- Verified-request intake uses a tenant-scoped idempotency key and rejects a
  conflicting replay. Owner review requires the same organisation, request ID
  and expected version; a repeated completed transition is a no-op.
- LEGAL_HOLD is evaluated before eligibility or backup evidence for every
  deletion request. Export review does not create deletion authority.
- Content redaction is idempotent because rows already containing the retained
  marker are excluded.
- Webhook cleanup requires processed_at and tenant ownership.
- OAuth cleanup deletes only selected consumed/expired IDs. A failed batch is
  retried by the recurring queue; active authorisations remain untouched.
- Batches are bounded. A later schedule continues remaining work instead of
  running an unbounded destructive transaction.
- Xero disconnect is checked before revocation and local token removal so a
  retry does not recreate or reuse a token.

## Backup and restoration safeguards

The release script creates a PostgreSQL custom-format backup before migration,
keeps it outside Git and records its path in immutable release metadata. Normal
application rollback changes images only and never overwrites PostgreSQL.
Database restoration must target a new disposable database first, followed by
tenant-count, subscription, Xero-connection and message/audit consistency
checks.

### Observed OVH evidence — 10 November 2026

The OVH control panel identifies the current AccountPulse target as active VPS
`vps-b27aff15.vps.ovh.ca`, IPv4 `15.235.63.138`, in Beauharnois (BHS), Canada.
It reports the **Standard** automated-backup option with a daily schedule at
04:38 UTC and **rotation 1**. At inspection time exactly one restore point was
available: 9 November 2026 at 15:38. Snapshot was separately shown as disabled.

This proves that one provider restore point exists; it does not prove database
consistency, encryption scope, a longer retention window or successful restore.
Rotation 1 is not sufficient evidence for a published backup-retention promise.
The application-level pre-release PostgreSQL dump and a restore-to-disposable-
database drill remain mandatory before commercial promotion.

The following facts are still required from the OVH control panel and host
before public privacy wording is approved:

1. OVH legal processor entity and contracted product.
2. The contractually supported public wording for the confirmed Beauharnois
   (BHS), Canada VPS region.
3. Automated-backup encryption and restore scope, plus confirmation of the
   effective expiry behaviour of the observed rotation-1 Standard backup.
4. Whether a separate encrypted off-host copy exists and its expiry period.
5. Date and evidence of the most recent restore-to-new-database drill.

Until those checks are completed, the only verified hosting statement is that
the application target is the OVH VPS identified in the deployment record;
Cognito remains an external identity provider.

## Decisions required before automatic deletion can be built

- Australian legal confirmation that the selected five-year audit period is
  appropriate for AccountPulse records and obligations.
- Australian tax/finance period for subscription and payment records.
- Approved backup expiry and how deletions age out of every backup tier.
- Whether customers receive an export and final deletion notice.
- Who can clear LEGAL_HOLD or approve destructive tenant deletion.
- Exact treatment of unresolved invoices after account closure.

No live customer purge is authorised by this runbook.
