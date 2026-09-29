# Protected operational reset runbook

This runbook is for an approved AccountPulse staging drill or production operational-data reset. It is not a deployment step. It never activates Customer live and never changes AccountPulse to Dry run.

## Required state and approvals

- The exact commit is already deployed and verified in the target environment.
- Sending controls shows **Controlled live**, not Customer live.
- The technical recipient allowlist is correct and must be preserved.
- Every enabled reminder sequence is in Review.
- The named email belongs to an active AccountPulse Administrator.
- Record the organisation UUID, a newly generated reset-run UUID, current operational-state version, deployed 40-character commit, and the exact acknowledgement shown below.
- Production requires approval through the protected GitHub `production` environment. Reset approval is separate from deployment and later Customer-live approval.

Exact reset acknowledgement:

> I understand this will permanently reset AccountPulse operational data for this organisation

## Staging drill

1. Seed staging with disposable imported receivables, approvals, messages, conversations, tasks, pauses, promises/disputes, a reminder whitelist entry, an SMS opt-out, audit events, integrations, users, the technical allowlist, and reminder configuration.
2. Run **Protected AccountPulse operational reset** with `target_environment=staging` and `operation=reset`.
3. Verify the workflow checks the deployed worker image, prepares maintenance mode, drains workers to zero, creates an encrypted RDS snapshot, records row/job manifests, executes the reset, restores workers, and passes `/health/ready`.
4. Verify deleted and preserved classes below, then request a fresh Xero sync and reconcile the new dataset.
5. Exercise an injected failure in a disposable environment. Confirm deletion rolls back, workers remain paused, and the durable SSM deployment lock blocks a normal deploy. Rerun the same GitHub workflow run, dispatch a retry while the intact same-run lock records the snapshot identifier, or explicitly abort with the same reset-run UUID.

## Production reset

1. Reconfirm the required state immediately before approval. A stale operational-state version must be refused.
2. Open **Actions → Protected AccountPulse operational reset → Run workflow**.
3. Select `production` and `reset`, then enter the approved identifiers and exact acknowledgement. Do not enter credentials, message text, phone numbers, invoice details, or other customer data.
4. Approve the protected production environment only after comparing the inputs with the change record.
5. Monitor these ordered phases: deployed-commit verification; reset preparation; worker drain; encrypted snapshot availability; reset execution; worker restoration; readiness check.
6. Record the workflow URL, reset-run UUID, snapshot identifier, prepare/execute task ARNs, deletion manifest, job-purge manifest, and completion audit event.
7. Confirm Sending controls shows **Controlled live**, reset complete, and fresh Xero sync required. The allowlist, users, suppressions, integrations, and configuration must be unchanged.

## Deleted data

Deletion is organisation-scoped and transactional. It removes imported/generated contacts and contact channels; invoices and invoice chases; stage instances and approvals; outbound messages and attempts (including Test-SMS history); conversations, inbound messages, operator replies, and assignments; tasks; pauses; disputes; promises to pay; and reminder-whitelist entries. Queued organisation-owned operational jobs are purged in the same transaction.

## Preserved data

The reset preserves organisation identity, live/Controlled scope, and the technical allowlist; users, memberships, invitations, and Cognito; Xero/Sinch connection references and provider health history; reminder sequences, versions, stages, templates, calendars, and exclusions; audit events, webhook security history, reconciliation/reset manifests; suppressions and SMS opt-outs; AWS secrets, infrastructure, alarms, and backups. It returns sequences to Review and clears the Xero cursor and successful-sync/reconciliation pointers.

## Failure, retry, and abort

If any phase after drain fails, do not restart workers manually and do not resend unknown outcomes. The durable `/accountpulse/<environment>/operational-reset-lock` parameter blocks later deployments from silently changing the worker task or desired count. The workflow reports the last durable phase and the current ECS desired/running/pending counts.

- Before `reset-completed`, a deletion failure rolls back the transaction, Customer scope remains disabled, the snapshot remains available, and the organisation stays in maintenance/failed state. Rerun the same GitHub workflow run, or start a new dispatch with the same reset-run UUID. A supplied `snapshot_id` is accepted only when it exactly matches the non-empty snapshot already stored in that run's durable deployment lock; the workflow also validates that the snapshot belongs to the target database. If that lock is missing or has no recorded snapshot, stop for AWS Administrator investigation instead of attaching an arbitrary snapshot. Preparation and execution are idempotent for that exact run.
- At `reset-completed` or `workers-restored`, deletion has succeeded and abort is no longer valid. If worker restoration or readiness failed, rerun the same approved reset with the same run and snapshot identifiers. The completed execute is a no-op; the workflow restores the baseline worker capacity, rechecks readiness, and then clears the deployment lock.
- If investigation says a pre-completion reset must not continue, run the workflow with `operation=abort`, the same reset-run UUID, the approving Admin email, deployed commit, and a credential-free reason. Abort never creates a snapshot or invokes prepare/execute; workers and autoscaling resume only after the audited abort succeeds, then the deployment lock is cleared.
- If the workflow failed before a reset run was created, the conservative deployment lock may remain. Confirm in Sending controls and the audit trail that no reset is active before an AWS Administrator removes that exact environment lock. Never remove a lock merely to unblock a queued deploy.
- Do not abort while deletion is actively executing. Do not restore from the snapshot over the source database. If recovery requires restoration, follow `restore.md` and restore to a new instance.

The deploy role needs scoped permission to read CloudFormation outputs; describe and scale the exact ECS worker service; run, wait for, list, and describe the exported worker tasks; read/update its Application Auto Scaling target; call `rds:CreateDBSnapshot` plus `rds:DescribeDBSnapshots` for the target database; and get/put/delete only the environment's operational-reset SSM parameter. It does not need to read Secrets Manager values because ECS injects existing task secrets.

## Fresh sync and separate final approval

After a successful reset, request a fresh Xero sync with no old cursor. While still Controlled live, compare active contacts, outstanding invoices, totals per currency, generated approvals, and enabled Review sequences with Xero. Record the exact reconciliation acknowledgement. Recheck current Xero/Sinch tests and send a new allowlisted Test SMS because the reset removed prior Test-SMS history.

Only after every gate passes should a separate customer-rollout approval be requested. Enabling Customer live remains an explicit Administrator action in Sending controls. Observe the first Review-mode cohort and keep **Return to Controlled live** and emergency **Disable all provider sending** immediately available.
