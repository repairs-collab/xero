# AccountPulse controlled launch runbook

Deploying AccountPulse does not reset data and does not open customer sending. Production must remain **Controlled live**, with the technical recipient allowlist unchanged, until the protected reset and the later customer activation receive separate approvals.

1. Confirm the launch checklist names owners and evidence for migration, restore, webhooks, provider tests, roles, alarms, and rollback.
2. Deploy the verified commit. Confirm the Sending controls page still shows **Controlled live**, the expected technical allowlist, and every enabled sequence in **Review**.
3. In Integrations, test Xero and Sinch. Xero must report the expected organisation and exactly the three approved scopes. Both successful authentication timestamps must be within 24 hours.
4. Send one controlled Test SMS to an allowlisted company number. Verify provider acceptance or delivery, callback handling, opt-out safety, audit evidence, and no duplicate provider call under replay. A live Xero-email test is not required.
5. Drill the protected reset in staging with disposable seeded data. Confirm the snapshot, deleted/preserved records, fresh-sync state, and failure/abort paths before requesting production-reset approval.
6. After explicit production-reset approval, follow `operational-reset.md`. The reset keeps AccountPulse **Controlled live**, pauses workers before deletion, and returns every enabled sequence to **Review**.
7. Request a fresh Xero sync. Compare active contacts, outstanding invoices, totals by currency, generated approvals, and enabled sequences with Xero. Record the exact reconciliation acknowledgement.
8. Recheck all customer-rollout gates. Another sync, stale provider check, missing Test-SMS evidence, Automatic sequence, or active reset must block activation.
9. Request a separate explicit customer-rollout approval. An Administrator types the exact final acknowledgement in Sending controls; deployment, reset, and sync never perform this action.
10. Observe the first small, named cohort in Review mode for one full business day. Monitor sends, replies, failures, queue age, provider headroom, and unknown outcomes.
11. Expand Review-mode cohorts gradually. Move an individual sequence to Automatic only after Finance and Operations sign off its evidence.

The 30-day escalation task remains manual. Completing it requires a resolution note and does not stop daily SMS; pause or close the chase explicitly when appropriate.

Immediately choose **Return to Controlled live** for an unexpected customer, duplicate, stale sync, provider authentication failure, sustained queue age over five minutes, or unreconciled unknown send. Choose **Disable all provider sending** for an incident requiring an emergency Dry run.
