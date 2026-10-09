# VoIPcloud native-call capability test

This is a staff-only release gate. It does not authorise customer calls. Keep the AccountPulse voice feature disabled and keep `VOICE_GATEWAY_ACCEPT_CALLS=false` except during the single controlled test window.

Automatic customer voice must remain disabled in **Settings > Voice reminders** throughout preparation, migration, deployment and testing. Customer Live SMS and Xero email sending remain enabled and must not be changed as part of this procedure.

## Required inputs

- A dedicated VoIPcloud SIP user and password, separate from office handsets.
- The Australian VoIPcloud API key and SIP server assigned to that user.
- The OVH public IP, with SIP/RTP firewall rules restricted to confirmed VoIPcloud source ranges.
- One product-owner-approved staff mobile number. Never substitute a customer number.
- The approved PBX transfer target: the existing queue on Tab 1, internal extension `1003`.
- The public office number `+61 3 5032 4518` remains the spoken callback and fallback; it is not the primary option 2 transfer route.

Use the Compose-managed `voice_audio` tmpfs volume and verify it is mounted with UID/GID 1000 and mode `0700` before starting the profile. The volume must be writable only by the non-root gateway and mounted read-only into Asterisk. Supply secrets through the protected deployment environment, not Git, shell history, screenshots, or chat.

## Preparation and migration

1. Record the deployed image versions, current database migration, `SEND_MODE`, rollout scope, Customer Live acknowledgement, and current SMS/email queue counts.
2. Take and verify a database backup using the normal encrypted OVH backup process. Record the restore command and backup identifier without copying credentials into the release notes.
3. Confirm the deployment environment explicitly resolves `VOICE_GATEWAY_ACCEPT_CALLS=false`. Do not rely only on the Compose default.
4. Confirm every organisation has `organisation_voice_settings.automatic_enabled=false`. If any row is true, disable it in the AccountPulse Administrator UI before continuing.
5. Apply the database migration and deploy the web, worker, Asterisk and voice-gateway images. Start the voice profile with the acceptance gate still false.
6. Verify web, worker, database, Asterisk and voice-gateway health; zero active voice channels; no due or active customer voice request; and normal SMS/email queue progress.

Rollback is required if migration, health, queue processing or authentication fails. Restore the previous images first. Restore the database only when the migration cannot be safely retained and after reconfirming the backup identifier. In every rollback path, leave `VOICE_GATEWAY_ACCEPT_CALLS=false` and automatic customer voice disabled.

## Staff-number sequence proof

Use only the product-owner-approved staff mobile. Prepare a dedicated internal Xero test contact whose phone is that staff number and whose two open test invoices contain fictional names, invoice references and small fictional balances. Do not repurpose a customer record. Sync and verify those two records before the test.

1. Keep automatic customer voice disabled. Create a temporary **Review first** voice sequence for the internal test contact and a single due stage inside the current calling window.
2. Run calculation once and verify it creates one review item containing both test invoice links, the sequence name and stage. A second calculation must not create another call.
3. Approve only that test item. Before opening the gateway, verify the approved call destination is the staff mobile and that there are no other approved, queued, submitting, accepted, in-progress or unknown calls.
4. Temporarily set `VOICE_GATEWAY_ACCEPT_CALLS=true` in both the worker and gateway, deploy that environment-only change, and allow exactly the approved staff call to run.
5. Verify the call, both invoice details behind option 1, option 2 transfer to queue `1003`, one-at-a-time dispatch and the configured cooldown. A second test occurrence must remain waiting until cooldown expires.
6. Immediately restore `VOICE_GATEWAY_ACCEPT_CALLS=false` in both services and redeploy the environment. Confirm zero active channels and that automatic customer voice is still disabled.
7. Disable and archive the temporary sequence. Close the fictional internal test invoices in Xero using the approved accounting process, sync again, and retain only safe call status evidence.

If a dedicated internal test contact and fictional invoices are not available, do not substitute customer data and do not open the gateway. Use the deterministic integration tests as consolidation/cooldown evidence and postpone the external sequence proof.

## Ten-item evidence checklist

1. Confirm the normal web and worker services remain healthy and Customer Live SMS/email/Xero settings are unchanged.
2. Start only the `voice-capability` profile with voice acceptance still false; verify Asterisk registers the dedicated SIP user and ARI is reachable only on the private Docker network.
3. Confirm MixMonitor, Monitor, and the ARI recording endpoint are disabled, no recording is configured, and the shared `/dev/shm/accountpulse-voice` directory is empty. (`res_stasis_recording` is an internal dependency of ARI playback in Asterisk 22 and must load, but AccountPulse never invokes it.)
4. After confirming there are no other releasable calls, temporarily set `VOICE_GATEWAY_ACCEPT_CALLS=true`, target the approved staff mobile, and submit one call with fictional invoice data.
5. Confirm the staff mobile sees the intended verified caller ID and that no prompt plays before the remote party actually answers.
6. Confirm the first human prompt names the fictional account but states no invoice number or amount.
7. Press 1 and verify the fictional invoice number and amount are clear and correct; then verify generated audio is purged.
8. Run a second staff call, press 2, and verify PBX queue `1003` rings, answers, and carries two-way audio. Confirm no invoice facts are disclosed before transfer and an unanswered queue produces one safe `TRANSFER_UNANSWERED` outcome plus the approved callback guidance.
9. Run a third staff call to controlled voicemail and verify only the generic callback message is left. Run a fourth call and press 9; verify exactly one wrong-number outcome.
10. Set `VOICE_GATEWAY_ACCEPT_CALLS=false` again. Compare AccountPulse, gateway, Asterisk, and VoIPcloud timestamps/call IDs; confirm no audio, recording, transcript, destination, invoice, account name, API key, or SIP password remains in logs or temporary storage.

## Release evidence

The release record must show `send_mode=live`, `rollout_scope=CUSTOMER`, `live_send_acknowledged=true`, `VOICE_GATEWAY_ACCEPT_CALLS=false`, `automatic_enabled=false`, zero active voice channels, healthy SMS/email queue processing, the deployed image identifiers, migration version and the safe IDs/timestamps of the staff proof. Never include a phone number, invoice fact, provider key, SIP password, audio, recording or transcript.

## Mandatory stop conditions

Stop immediately and leave voice disabled if answer timing, DTMF 1/2/9, caller ID, transfer, voicemail classification, one-call correlation, or audio purge is unreliable. Do not test on a customer. Ask VoIPcloud whether the account supports an outbound SIP trunk/route compatible with Asterisk before changing the architecture.
