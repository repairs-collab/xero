# Unknown send outcome runbook

An `UNKNOWN` outcome means Bill Chaser cannot prove whether the provider accepted the request. Never retry blindly: the customer may already have received it.

1. Disable live sending if unknown outcomes are widespread. Open the task and note the organisation, customer, invoice, channel, provider, idempotency key, attempt time, and provider message ID if present. Do not copy message content into incident channels.
2. For Sinch, if a provider message ID exists, call `GET https://au.app.api.sinch.com/v1/messages/{messageId}`. Also search Sinch delivery reports for the same ID and destination/time. `DELIVERED`, `SUBMITTED`, or `ENROUTE` proves acceptance; record the status and do not resend.
3. If there is no Sinch message ID, search the Sinch portal/reporting window by destination, timestamp, and content hash metadata. A matching accepted message means **mark accepted**. No match is not proof of non-delivery after a timeout.
4. For Xero email, inspect the Xero invoice history and contact communication record. If Xero accepted or sent the email, mark it accepted and do not resend.
5. If the provider confirms rejection before dispatch, mark the attempt failed with the provider case/reference. Only then may the Operator create a new explicit attempt.
6. If the provider cannot determine the result, leave it `UNKNOWN`, complete the review task with the evidence, and use a manual non-duplicating contact method if needed.
7. Add the incident ID and evidence references to the audit timeline. Never edit the original attempt, provider ID, hash, or timestamp.

Escalate when more than three unknowns occur in 15 minutes, authentication/rate-limit alarms accompany them, or the result cannot be reconciled within one business day.
