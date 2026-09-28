# AccountPulse Final Customer Rollout Design

**Date:** 29 September 2026  
**Status:** Approved
**Production state while this is built:** Controlled-live; technical allowlist enforced  
**Final activation:** Requires a separate explicit approval after deployment, reset, fresh sync, and verification

## 1. Purpose

AccountPulse currently has two global sending states: dry-run and live. Live sending always enforces the technical recipient allowlist, which is appropriate for provider testing but cannot represent a final customer rollout.

This change adds an explicit customer-rollout scope, an audited operational-data reset for a clean Xero resynchronisation, and a protected approval flow. The final build must be deployable without deleting data or opening customer sending. Production remains controlled-live until the reset and final rollout are approved as separate operations.

## 2. Confirmed product decisions

- Current controlled SMS testing has succeeded and replaces any pre-live test-email requirement.
- Xero email does not need a live test before customer rollout. Xero connection health, scope validation, fresh invoice data, recipient review, and normal per-send safeguards remain required.
- The operational reset keeps global provider sending live but keeps the recipient scope controlled. It does not switch AccountPulse back to dry-run.
- The reset removes imported and generated operational data while preserving access, integrations, policy configuration, audit/security history, SMS opt-outs, and the technical test allowlist.
- Every sequence is returned to `REVIEW` mode by the reset. Sequences can be promoted to `AUTOMATIC` individually only after later review.
- Final customer rollout requires a separate explicit Admin approval after the fresh Xero sync is reconciled.
- The 30-day escalation task remains manual. Completing the task does not implicitly stop or resume daily SMS reminders.

## 3. Sending state model

Keep the existing global `sendMode` because it is the emergency provider-call control:

- `dry-run`: no provider call can be made.
- `live`: provider calls may be made, subject to the recipient scope and all message-level safeguards.

Add `rolloutScope` to the organisation:

- `CONTROLLED`: only normalised destinations on `recipientAllowlist` may reach providers.
- `CUSTOMER`: eligible customer reminders and replies may reach providers without appearing on the technical allowlist.

Existing organisations are migrated to `CONTROLLED`. The production organisation therefore stays controlled-live throughout deployment and reset.

The supported combinations are:

| Send mode | Rollout scope | Behaviour |
| --- | --- | --- |
| `dry-run` | `CONTROLLED` | No provider calls; safest emergency state |
| `live` | `CONTROLLED` | Provider calls only to the technical allowlist |
| `live` | `CUSTOMER` | Provider calls to all otherwise-eligible customer destinations |

`dry-run` plus `CUSTOMER` is not persisted. An emergency stop returns the organisation to dry-run and controlled scope, so returning to customer-live requires the full approval flow again.

### Scope enforcement

One shared send-policy function determines whether a provider call is allowed. Every outbound path uses it:

- Automated SMS reminders.
- Automated Xero invoice-email requests.
- Approved manual customer SMS and Xero email reminders.
- Escalation SMS.
- Operator replies.

The Test SMS administrator tool remains allowlist-only even in customer scope. It must never become a way to send arbitrary SMS messages outside customer workflows.

Customer scope does not bypass any existing protection. Suppressions, opt-outs, reminder-whitelist entries, pauses, disputes, promises to pay, invoice eligibility, approved payment links, approval expiry, source-version checks, quiet hours, provider limits, idempotency, and unknown-outcome handling continue to apply.

## 4. Customer-rollout activation

The Sending controls page displays the three meaningful states as `Dry run`, `Controlled live`, and `Customer live`.

An Admin can request customer rollout only when all gates pass:

1. `sendMode` is `live` and `rolloutScope` is `CONTROLLED`.
2. Xero and Sinch have successful authentication timestamps within 24 hours.
3. Xero has completed a successful sync within 15 minutes.
4. The organisation has non-empty imported invoice/contact data after the reset.
5. A Test SMS to a technical allowlisted number was accepted or delivered within seven days.
6. No operational reset is running.
7. Every enabled reminder sequence is in `REVIEW` mode.
8. The Admin types the exact customer-rollout acknowledgement.

The acknowledgement is distinct from controlled activation and states that approved reminders may be sent to customers. Activation writes an immutable `CUSTOMER_ROLLOUT_ACTIVATED` audit event containing the actor, timestamp, before/after scope, sync timestamp, controlled-SMS evidence ID, and enabled-sequence count. It does not store message content or credentials.

The page also provides:

- `Return to controlled live`, requiring an Admin reason and preserving the technical allowlist.
- `Disable all provider sending`, requiring an Admin reason and returning to dry-run plus controlled scope.

No deployment, migration, reset, or sync automatically activates customer scope.

## 5. Operational-data reset

The reset is a protected release operation, not a general-purpose button. It runs as a one-off production task through the existing protected deployment workflow after the final build is live and after a separate user approval.

### Preconditions

- The deployed application version includes the new scope enforcement everywhere.
- The organisation is `live` plus `CONTROLLED`.
- The requesting actor is an Admin.
- The exact reset acknowledgement and target organisation ID are supplied.
- No reset is already active.
- Customer rollout is not active.

### Maintenance and recoverability

The reset changes an operational-maintenance flag to block new sync, approval, send, reply, and escalation mutations while leaving sign-in, settings, audit access, and health endpoints available. The deployment workflow pauses worker job claims and waits for in-flight external-call work to finish before deletion.

Before deletion, the workflow:

1. Creates a recoverable production database snapshot.
2. Records a count manifest for every affected table.
3. Records the deployed commit and organisation ID.
4. Purges queued organisation-owned operational jobs so pre-reset jobs cannot run against the new dataset.

### Deleted data

Delete the production organisation's imported and generated operational data in one database transaction:

- Contacts and contact channels.
- Invoices and invoice chases.
- Stage instances and approvals.
- Outbound messages and message attempts, including Test SMS history.
- Conversations, inbound messages, operator replies, and assignments.
- Escalation and data-quality tasks.
- Pauses, disputes, and promises to pay.
- Reminder-whitelist entries.

Foreign-key order and organisation scoping are explicit. The reset must not use an unscoped truncate or broad recursive delete.

### Preserved data

- Organisation identity and the current technical recipient allowlist.
- `sendMode = live` and `rolloutScope = CONTROLLED`.
- Users, memberships, invitations, and Cognito configuration.
- Xero and Sinch connection references and provider-test history.
- Reminder sequences, versions, stages, templates, calendars, and exclusions.
- Audit events, webhook security history, and operational reset manifests.
- Channel suppressions and opt-outs, including SMS opt-outs. Consent safety survives a fresh sync.
- AWS secrets, infrastructure, alarms, and backups.

The reset sets every sequence to `REVIEW`, clears the Xero sync cursor and last-successful-sync timestamp, and records a `PRODUCTION_OPERATIONAL_DATA_RESET` audit event with deleted row counts and snapshot reference. It never records credentials or message bodies.

### Failure behaviour

- A deletion failure rolls back the whole data transaction.
- Customer scope remains disabled.
- The technical allowlist and controlled-live state remain unchanged.
- Worker claims remain paused until an operator resolves the failure or explicitly aborts the reset.
- The pre-reset snapshot remains available for recovery.

After a successful reset, worker claims resume, the maintenance flag clears, and the application shows zero imported receivables until the fresh Xero sync is requested.

## 6. Fresh Xero sync and reconciliation

The Admin requests a new Xero sync after reset. The sync starts without an old cursor and imports the current receivables dataset. Controlled-live scope ensures that non-allowlisted customer destinations still cannot reach providers during or after import.

Before the customer-rollout gate can pass, the application displays and records:

- Last successful sync timestamp.
- Imported active contact count.
- Imported outstanding invoice count.
- Total outstanding amount by currency.
- Number of generated approval items.
- Number of enabled sequences and confirmation that all are `REVIEW`.

The operator compares these values with Xero. Reconciliation acknowledgement is audited and tied to the sync timestamp so another sync invalidates it.

## 7. User interface

### Sending controls

- Clearly labels `Controlled live` versus `Customer live`.
- Shows the technical allowlist only as a controlled-testing safeguard.
- Removes the requirement to send a test Xero email.
- Shows the successful controlled-SMS evidence and timestamp.
- Shows each customer-rollout gate with a specific pass/fail reason.
- Requires the exact final acknowledgement before enabling customer scope.

### Reset status

The Admin settings area displays reset preparation, snapshot created, deletion completed, sync required, reconciliation complete, and ready-for-final-approval states. The destructive execution remains in the protected release workflow rather than an always-available web button.

### Activity and audit

Audit views include controlled activation, reset request, snapshot reference, reset completion/failure, reconciliation approval, customer rollout, return to controlled mode, and emergency dry-run events.

## 8. Error handling and concurrency

- All state transitions use compare-and-set conditions so stale pages cannot overwrite a newer safety state.
- Only one reset or scope transition can run for an organisation at a time.
- Provider health or sync freshness changing during final activation causes a refusal, not a warning-only success.
- A job claimed before scope changes re-reads organisation and recipient policy immediately before the provider call.
- Missing records caused by an approved reset are treated as safely cancelled/no-op outcomes rather than endlessly retried failures.
- Returning to controlled mode takes effect before the response is shown and is revalidated by workers before any subsequent provider call.

## 9. Testing strategy

### Database and service tests

- Migration backfills `rolloutScope = CONTROLLED` without changing `sendMode`.
- Controlled scope allows only normalised allowlisted destinations.
- Customer scope permits eligible customer destinations but never bypasses channel or business safeguards.
- Test SMS remains allowlist-only in every scope.
- Admin-only acknowledgements and compare-and-set transitions are enforced.
- Reset deletes every specified operational record and preserves every specified configuration, audit, webhook, and suppression record.
- Reset sets all sequences to `REVIEW`, clears sync state, and leaves controlled-live active.
- Reset failure rolls back deletions and does not enable customer scope.

### Worker tests

- SMS, Xero email, manual reminders, escalation SMS, and replies all use the shared send policy.
- Workers re-read scope immediately before provider calls.
- Pre-reset/missing work is cancelled without provider calls or retry storms.
- Opt-outs and suppressions survive reset and remain enforced after fresh sync.

### Browser journeys

- Sending controls distinguish dry-run, controlled-live, and customer-live.
- Failed gates explain the exact corrective action.
- No test-email gate appears.
- Reset status and fresh-sync reconciliation are visible.
- Customer rollout cannot be activated without all gates and the exact acknowledgement.
- Successful final activation and rollback are visible and audited.

### Release verification

- Full lint, typecheck, unit/integration suite, production build, and browser journeys pass.
- Staging exercises reset against seeded disposable data and verifies preserved records.
- Production deployment completes without running the reset or changing rollout scope.
- Reset and final activation each require their own protected production approval.

## 10. Deployment sequence

1. Deploy schema and application support with existing organisations backfilled to controlled scope.
2. Verify production remains live plus controlled and the test allowlist is unchanged.
3. Ask for explicit production-reset approval.
4. Snapshot, pause claims, run the audited reset, and resume claims.
5. Request a fresh Xero sync and reconcile counts/totals.
6. Verify provider health, controlled-SMS evidence, sync freshness, and review-only sequences.
7. Ask for explicit customer-rollout approval.
8. On approval, type the final acknowledgement and activate customer scope.
9. Observe the first approved review-mode cohort and retain immediate return-to-controlled and emergency dry-run controls.

## 11. Non-goals

- The build does not automatically activate customer scope.
- The reset does not run automatically during deployment.
- The reset does not delete audit history, security evidence, suppressions, users, integrations, or policy configuration.
- The reset does not move AccountPulse to dry-run.
- The rollout does not promote any sequence to automatic mode.
- The rollout does not add a generic email provider or require a live Xero test email.
