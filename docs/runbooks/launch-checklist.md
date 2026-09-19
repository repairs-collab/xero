# Bill Chaser 5000 launch checklist

Production live sending stays disabled until every required row has an evidence link, a named approver, and an approval date. Store evidence in the launch change record; never paste credentials, message bodies, phone numbers, or customer data into this file.

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
| Xero email | One allowlisted invoice submitted to Xero; audit event and Xero-side receipt verified |  |  |  | [ ] |
| Sinch Engage APAC | Authentication succeeds against `au.app.api.sinch.com`; TLS and callback URL verified |  |  |  | [ ] |
| Sinch callbacks | Delivery, reply, opt-out, duplicate replay, and invalid RSA signature tests pass |  |  |  | [ ] |
| Reply pause | Customer reply creates a customer-wide pause before any later send claim |  |  |  | [ ] |
| Dry-run audit | Due, 7-day, 21-day, 30-day, and daily stages create expected previews/tasks without provider calls |  |  |  | [ ] |
| Allowlist audit | Only approved normalised test destinations are eligible for controlled live sends |  |  |  | [ ] |
| Mode audit | All sequences start in Review; only the approved cohort sequence is Automatic |  |  |  | [ ] |
| Role audit | Admin and Operator browser journeys pass; MFA enforcement is visible in Cognito |  |  |  | [ ] |
| Unknown outcomes | SMS and Xero email timeout-after-dispatch drills enter `UNKNOWN` and follow reconciliation without blind resend |  |  |  | [ ] |
| Payment race | Payment arriving immediately before the send lock cancels the provider call |  |  |  | [ ] |
| Monitoring | ECS, RDS, queue age, stale sync, provider auth, webhook signature, and unknown-outcome alarms are green and routed |  |  |  | [ ] |
| Rollback drill | Live sending disabled, workers drained, prior immutable images restored, readiness checks pass |  |  |  | [ ] |
| Review cohort | First cohort reviewed by Finance; exact rendered messages, grouping, phone selection, and exclusions approved |  |  |  | [ ] |

## Final production authorisation

- Finance owner: `________________________` Signature: `________________` Date: `____________`
- Operations owner: `_____________________` Signature: `________________` Date: `____________`
- Engineering owner: `____________________` Signature: `________________` Date: `____________`
- Security owner: `_______________________` Signature: `________________` Date: `____________`

Only after all four final authorisations:

1. Confirm the organisation is still in `dry-run`.
2. Recheck provider health, Xero sync freshness, alarms, and the recipient allowlist.
3. Enable live mode using the exact acknowledgement shown in Admin Settings.
4. Keep the selected cohort in Review mode for its first cycle.
5. Record the first provider submissions and outcomes in the change record.
6. Stop and return to `dry-run` on any unexpected recipient, duplicate, stale invoice, invalid signature, or unknown outcome.
