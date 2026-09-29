# AccountPulse launch checklist

Customer live sending stays disabled until every required row has an evidence link, a named approver, and an approval date. Store evidence in the launch change record; never paste credentials, message bodies, phone numbers, or customer data into this file.

## Release identification

- Release commit: `________________________________________`
- Staging deployment: `________________________________________`
- Production change record: `________________________________________`
- Launch cohort owner: `________________________________________`
- Planned launch window (Australia/Sydney): `________________________`

## Required evidence and sign-off

| Gate | Required evidence | Evidence link | Named approver | Date (AEDT/AEST) | Approved |
| --- | --- | --- | --- | --- | --- |
| Database migration | Staging migration task exit `0`; schema journal and app readiness check |  |  |  | [ ] |
| Restore drill | Restore-to-new-instance record, consistency queries, and recovery timing |  |  |  | [ ] |
| Xero Custom Connection | `Bill Chaser 5000` token test with exactly `accounting.invoices accounting.contacts.read accounting.settings.read`; evidence that no tenant header is sent |  |  |  | [ ] |
| Xero webhook | Intent-to-receive succeeds; valid signature accepted; altered signature rejected |  |  |  | [ ] |
| Sinch Engage APAC | Authentication succeeds against `au.app.api.sinch.com`; TLS and callback URL verified |  |  |  | [ ] |
| Sinch callbacks | Delivery, reply, opt-out, duplicate replay, and invalid RSA signature tests pass |  |  |  | [ ] |
| Controlled Test SMS | Allowlisted company number is accepted or delivered; safe evidence ID and timestamp appear in Sending controls |  |  |  | [ ] |
| Reply pause | Customer reply creates a customer-wide pause before any later send claim |  |  |  | [ ] |
| Dry-run audit | Due, 7-day, 21-day, 30-day, and daily stages create expected previews/tasks without provider calls |  |  |  | [ ] |
| Allowlist audit | Only approved normalised test destinations are eligible for controlled live sends |  |  |  | [ ] |
| Mode audit | Every enabled sequence is in Review before customer activation |  |  |  | [ ] |
| Role audit | Admin and Operator browser journeys pass; MFA enforcement is visible in Cognito |  |  |  | [ ] |
| Unknown outcomes | SMS and Xero email timeout-after-dispatch drills enter `UNKNOWN` and follow reconciliation without blind resend |  |  |  | [ ] |
| Payment race | Payment arriving immediately before the send lock cancels the provider call |  |  |  | [ ] |
| Monitoring | ECS, RDS, queue age, stale sync, provider auth, webhook signature, and unknown-outcome alarms are green and routed |  |  |  | [ ] |
| Rollback drill | Live sending disabled, workers drained, prior immutable images restored, readiness checks pass |  |  |  | [ ] |
| Protected reset drill | Staging snapshot, worker drain, organisation-scoped deletion, retry, abort, and preserved-data checks pass |  |  |  | [ ] |
| Production reset | Protected workflow records the approved commit, snapshot, manifests, and successful completion; production remains Controlled live |  |  |  | [ ] |
| Fresh Xero reconciliation | Current sync counts and currency totals match Xero; exact acknowledgement is tied to that sync |  |  |  | [ ] |
| Review cohort | First cohort reviewed by Finance; exact rendered messages, grouping, phone selection, and exclusions approved |  |  |  | [ ] |

## Final production authorisation

- Finance owner: `________________________` Signature: `________________` Date: `____________`
- Operations owner: `_____________________` Signature: `________________` Date: `____________`
- Engineering owner: `____________________` Signature: `________________` Date: `____________`
- Security owner: `_______________________` Signature: `________________` Date: `____________`

Only after all four final authorisations and a separate customer-rollout approval:

1. Confirm the organisation is **Controlled live**, the technical allowlist is unchanged, and no reset is active.
2. Recheck provider health, controlled Test-SMS evidence, Xero sync freshness, reconciliation, alarms, and Review-only sequences.
3. Enable **Customer live** using the exact final acknowledgement shown in Sending controls.
4. Keep the selected cohort in Review mode for its first cycle.
5. Record the first provider submissions and outcomes in the change record.
6. Return to **Controlled live** on an unexpected recipient, duplicate, stale invoice, invalid signature, or unknown outcome. Use emergency **Dry run** if all provider sending must stop.
