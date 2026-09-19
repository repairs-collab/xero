# Controlled launch runbook

Production begins in dry-run and review mode. Do not enable live mode from infrastructure configuration.

1. Confirm the launch checklist has named owners and evidence for migration, restore, webhooks, provider tests, roles, alarms, and rollback.
2. In Integrations, test Xero and Sinch. Xero must report the expected organisation and exactly the three approved scopes. Both successful authentication timestamps must be within 24 hours.
3. Run a Xero sync and confirm freshness is under 15 minutes. Compare invoice count and amount due to Xero.
4. Keep every sequence in **Review**. Confirm the default stages: due-date SMS; 7-day Xero email + firm SMS; 21-day final-warning SMS; 30-day escalation task with business-day daily SMS thereafter.
5. Add only company-controlled E.164 numbers to the launch allowlist. Keep global mode `dry-run`; review rendered previews and prove that provider call counts remain zero.
6. Switch to live only for the controlled test, type the exact acknowledgement shown in the app, and send one SMS and one Xero email to controlled accounts. Verify delivery, reply pause, opt-out suppression, audit entries, and no duplicate call under replay. Record `CONTROLLED_TEST_PASSED` evidence.
7. Return to dry-run. Review wording, segment counts, invoice links, email recipients, quiet hours, and all stop conditions.
8. Approve the first customer cohort in review mode. Use a small, named cohort with a documented maximum invoice count and value. Observe sends, replies, failure rate, queue age, provider headroom, and unknown outcomes for one full business day.
9. Expand review-mode cohorts gradually. Individual sequences may move to automatic only after their review-mode evidence is signed by the Finance Owner and System Owner.
10. The 30-day escalation task remains manual. Completing it requires a resolution note and does not stop daily SMS; pause or close the chase explicitly when appropriate.

Immediately return to dry-run for an unexpected customer, duplicate, signature failure, stale sync, provider authentication failure, sustained queue age over five minutes, or any unreconciled unknown send.
