# AccountPulse voice reminders: provider setup and release

This runbook releases the Retell + VoIPline manual voice reminder feature without changing Customer Live SMS, Xero email, Xero sync, or Inbox behaviour. Voice is a separate switch and must remain disabled until the final controlled-call checks pass and an Administrator explicitly enables it.

## Safety boundaries

- AccountPulse uses one locked, versioned generic opening. It does not generate a customer-specific script.
- No financial details are disclosed in the opening, voicemail, wrong-person, or no-response paths.
- Option 1 first confirms that the recipient is the customer or authorised to discuss the account, then reads the approved invoice numbers and amounts.
- Option 2 transfers immediately to the configured office destination. It is also available after option 1 details.
- A spoken wrong-person outcome ends the call, creates a VOICE suppression, and creates a contact-review task.
- AccountPulse does not request or retain recordings, audio, transcripts, summaries, sentiment, or arbitrary provider analysis. Incoming payloads are reduced to allow-listed operational outcomes.
- A submitted call is never automatically redialled when provider acceptance is uncertain. It is reconciled or sent to manual review.
- Every call is prepared and confirmed individually. Voice has no automatic sequence mode in this release.
- Administrator test calls are labelled `TEST`, use a staff-controlled destination, and remain separate from Customer Live and the manual customer-voice switch.
- A TEST call never changes the Xero customer's saved contact details, consumes customer call-frequency limits, creates customer contact-review work, or adds a customer voice suppression.

## 1. Retell configuration

Create a production Retell agent and pin an immutable version. Select an Australian-English voice and record the agent ID, pinned version, voice ID, voice label, private API key, and domain-restricted public preview key.

Configure the locked flow with these branches:

1. Generic opening: identify the business and say the call concerns an account matter, without naming an invoice or amount.
2. Option 1: confirm identity or authority, then read `invoice_details_json`, `combined_amount`, and `currency`. Offer option 2 after the details.
3. Option 2: warm-transfer immediately without account disclosure.
4. Wrong person: apologise, end the call, and return the structured `WRONG_PERSON` outcome.
5. No response, busy, or no answer: end without account disclosure and return the applicable structured outcome.
6. Voicemail: play only the locked generic callback message. Do not include invoice numbers or amounts.
7. Unanswered transfer: return `TRANSFER_UNANSWERED`; do not retry the call automatically.

Required fact-only outbound variables are:

- `accountpulse_call_id`
- `invoice_details_json`
- `combined_amount`
- `currency`
- `callback_number`
- `fallback_office_number`
- `transfer_sip_uri` when configured

The adapter does not send the customer name or generated prose. Structured outcomes accepted by AccountPulse are identity confirmed/not confirmed, reminder delivered, voicemail left, wrong person, transfer requested/transferred/unanswered, no answer, busy, invalid destination, and provider rejected.

Disable recording and transcript retention in Retell. Disable optional summaries, sentiment, and unrestricted custom analysis. Configure the public preview key for only:

- `https://billchaser.motts.com.au`
- the controlled staging hostname

Enable reCAPTCHA for browser preview when the Retell account supports it; otherwise record the provider's explicit unsupported status. Never use `*` as an allowed origin.

Register the signed webhook URL:

`https://billchaser.motts.com.au/api/webhooks/retell`

The webhook must send `x-retell-signature`. A request with a missing, invalid, stale, or future signature must return 401 before its body is recorded or queued.

## 2. VoIPline configuration

Use the verified Australian business caller identity assigned to the AccountPulse outbound route. Configure the Retell outbound SIP route through VoIPline and a warm-transfer destination for the main office queue.

Confirm with VoIPline that:

- the displayed Australian number is registered and approved for the business;
- the Retell source/trunk is authorised;
- DTMF passes in both directions;
- the office queue accepts the transfer SIP URI;
- the fallback office number reaches the same approved team;
- voicemail detection and caller-ID presentation comply with the current Australian rules and the account's carrier configuration.

Do not place customer calls while configuring the trunk. Use only an approved staff-owned test number.

## 3. OVH secret and deployment configuration

AccountPulse compute, PostgreSQL, and HTTPS run on the OVH VPS. Cognito remains the retained authentication service. Do not add voice resources to the legacy AWS CDK stacks.

Store the private Retell API key only in the root-owned file:

`/opt/bc5000/config/bc5000-secrets.json`

Add a `RETELL_API_KEY` value without printing it to the terminal, logs, a ticket, source control, or PostgreSQL. Keep the file owned by root with mode 600. The non-secret database reference is `env:RETELL_API_KEY`.

The web and worker containers receive the private value server-side. It must never appear in a `NEXT_PUBLIC_` variable. The browser receives only the domain-restricted public preview key on the authorised Administrator settings page.

Build the web and worker images from one verified commit, tag them with that full commit SHA, copy/load them on OVH, and set `ACCOUNT_PULSE_WEB_IMAGE` and `ACCOUNT_PULSE_WORKER_IMAGE` in the root-owned OVH configuration. Back up the live compose file and database before changing services. Preserve the live `SEND_MODE`, rollout scope, Cognito, Xero, Sinch, Caddy, and unrelated site configuration.

Before bringing up the release:

1. confirm `organisation_voice_settings` has no enabled production row;
2. run the worker migration command once;
3. start web and worker with the exact same SHA-tagged images;
4. wait for the web health check and worker health check;
5. install and enable `accountpulse-voice-monitor.timer`;
6. run the monitor once manually and require a zero exit status.

The timer raises a failed unit for unknown outcomes, recent provider failures, stale voice jobs, Retell webhook lag, or repeated signature failures. Inspect it with the system journal and the safe metric names only; never copy provider payloads into alerts.

## 4. Staging test matrix

Run all scenarios with fictional invoices and an approved staff-owned number:

1. Option 1 confirms identity/authority, reads both approved invoice facts, and completes normally.
2. Option 2 at the opening warm-transfers without disclosing account details.
3. Option 2 after details warm-transfers successfully.
4. No response leaves no financial message and returns a safe terminal outcome.
5. Voicemail plays only the generic callback message.
6. Wrong person ends the call, suppresses the number, and creates a contact-review task.
7. Office transfer unanswered returns `TRANSFER_UNANSWERED` and does not redial.
8. Busy, no-answer, invalid-destination, and known provider-rejection outcomes appear safely in history.
9. Unknown dispatch creates reconciliation work and never produces a second provider submission.
10. Stale invoice/contact facts, closed calling window, active dispute/promise/pause/whitelist, and frequency limits block the call before submission.

For every scenario compare:

- the AccountPulse call ID, state, safe outcome, audit/timeline row, and task/suppression state;
- the matching Retell call record;
- the matching VoIPline call-detail record and transfer result.

Confirm that AccountPulse storage, logs, job payloads, activity rows, and alerts contain no audio, transcript, recording URL, customer speech, unrestricted metadata, or customer-specific generated script.

## 5. Production controlled checks

Keep the production voice switch disabled. Re-run provider connection testing and the fictional in-browser preview as an Administrator.

In **Settings > Voice reminders > Test voice call**, enter an existing invoice number and an approved staff-owned Australian number. Review the displayed Xero customer, invoice number, due date, amount, currency, and normalised test destination before confirming. The test uses the real locked provider flow while the customer voice switch remains off.

Perform exactly two approved TEST calls:

1. one outbound call to a staff-owned mobile number covering option 1;
2. one staff-controlled call covering option 2 and a real warm transfer to the office queue.

Verify caller ID, DTMF, Australian-English voice, office ringing, connected transfer audio, safe AccountPulse history, provider records, monitor health, and absence of recordings/transcripts. Recheck Xero sync, SMS test sending, Xero email controls, and Inbox after the deployment.

Confirm both calls are visibly marked `TEST` in customer history and that neither call changes the customer phone, customer call-frequency history, suppression list, or escalation tasks. Do not use a customer-controlled destination for these checks.

Only after these checks pass should the Administrator type the exact enablement acknowledgement in AccountPulse. Enabling voice does not change Customer Live SMS/email status.

## 6. Rollback

Disable manual voice calls in Administrator settings. Do not change Customer Live, Xero, Sinch, Cognito, or the organisation sending mode. Leave call history, audits, suppressions, and review tasks intact.

If application rollback is required, restore the previous SHA-tagged web and worker images together, rerun health checks, and keep voice disabled. Never delete uncertain call records or requeue them as new calls.
