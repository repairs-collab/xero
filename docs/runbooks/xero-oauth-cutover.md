# AccountPulse Xero OAuth cutover rehearsal

This runbook moves the Motts organisation from its existing Xero Custom Connection to the AccountPulse standard OAuth app without changing live sending or deleting the legacy connection. The rehearsal is complete only when OAuth sync totals reconcile, a refresh-token rotation succeeds, and a tenant-routed webhook is processed. Disabling the legacy connection requires a separate approval after the evidence has been reviewed.

## Fixed application details

- Xero app: AccountPulse
- Xero app ID: `26d72582-25a5-4d15-acb9-7642d8c1fa0c`
- Application URL: `https://ap.motts.com.au`
- Launcher URL: `https://ap.motts.com.au/start`
- OAuth callback: `https://ap.motts.com.au/xero/callback`
- Webhook delivery URL: `https://ap.motts.com.au/api/webhooks/xero`
- OAuth scopes: `openid profile email offline_access accounting.invoices accounting.contacts.read accounting.settings.read`
- Webhook event category: invoices, with create and update events routed by Xero tenant ID

Do not generate or paste a client secret into a chat, source file, deployment log, or support ticket. Create it only when the OVH deployment secret process is ready, then place it in the protected production environment as `XERO_OAUTH_CLIENT_SECRET`. Store the app client ID as `XERO_OAUTH_CLIENT_ID`.

## Preconditions

1. `https://ap.motts.com.au` must have a valid TLS certificate and route to the AccountPulse web container.
2. The launcher, callback, support, privacy, and terms routes must return successful HTTPS responses.
3. The unapplied database migrations must pass against a PostgreSQL rehearsal database.
4. The production environment must contain the OAuth client ID, OAuth client secret, callback URL, refresh-token encryption key ring, and active key ID.
5. The AccountPulse webhook key must be stored separately from any key belonging to the original Bill Chaser app. Do not replace or reuse the legacy key during the rehearsal.
6. Customer sending must remain in its existing live state. Do not change `sendMode`, `rolloutScope`, `liveSendAcknowledged`, sequence modes, approvals, queued messages, or recipient safeguards.

## Connect and reconcile

1. Sign in as an AccountPulse Admin and open **Settings → Integrations**.
2. Select **Connect Xero**, authorise the AccountPulse app, and choose the Motts Xero organisation. Do not disconnect or disable the existing Custom Connection.
3. Run **Sync Xero now**. Confirm the job completes without sending a reminder.
4. Compare AccountPulse with the current Xero dashboard. Record the outstanding authorised invoice count and total amount due from both systems. Do not proceed while either value differs.
5. Run the read-only readiness command inside the worker container:

   ```text
   xero-oauth-readiness --organisation-id <accountpulse-organisation-id>
   ```

6. Confirm the report shows:

   - the legacy connection is present and enabled;
   - OAuth status is `CONNECTED`;
   - the OAuth tenant matches the organisation's Xero ID;
   - no required OAuth scopes are missing;
   - the latest successful sync has a current reconciliation;
   - invoice count and amount match the reviewed Xero figures; and
   - `readyForApprovedCutover` is `true`.

The command reads connection, sync, reconciliation, and invoice totals only. It cannot change sending status, sequences, approvals, messages, connection enablement, credentials, or tokens.

## Prove token rotation and webhook routing

1. Keep the worker running long enough for the first OAuth access token to expire and refresh. Confirm the Xero connection remains `CONNECTED` and a later sync succeeds. Never print or inspect the refresh token itself.
2. Configure the AccountPulse app's invoice create and update webhook topics only after the AccountPulse webhook key is available in the protected deployment environment.
3. Keep the AccountPulse webhook key separate from the original Bill Chaser app key during any overlap. If both apps deliver webhooks during rehearsal, use separately configured endpoints or an approved dual-key verification window; never overwrite the legacy key merely to make the new app pass.
4. Create or update a harmless test invoice in Xero. Confirm AccountPulse returns HTTP 200, records the event under the organisation resolved from its tenant ID, and queues exactly one processing job.
5. An event carrying an unknown tenant must return HTTP 200 but must not be recorded or assigned to any organisation. Investigate the count-only unknown-tenant diagnostic before cutover.

## Approval and rollback boundary

Prepare a short evidence record containing the reconciliation figures, readiness output, successful post-refresh sync time, and webhook event ID. Request a separate production approval before disabling the legacy Xero provider record.

Disconnecting the AccountPulse OAuth connection is reversible: an Admin can reconnect and authorise it again. Disabling the legacy provider record is also reversible while its protected credentials remain available. Deleting legacy credentials, changing live sending, clearing operational data, or changing sequence automation is outside this command and outside this rehearsal. Those actions require their own reviewed change and explicit approval.
