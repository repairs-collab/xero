# VoIPcloud native-call capability test

This is a staff-only release gate. It does not authorise customer calls. Keep the AccountPulse voice feature disabled and keep `VOICE_GATEWAY_ACCEPT_CALLS=false` except during the single controlled test window.

## Required inputs

- A dedicated VoIPcloud SIP user and password, separate from office handsets.
- The Australian VoIPcloud API key and SIP server assigned to that user.
- The OVH public IP, with SIP/RTP firewall rules restricted to confirmed VoIPcloud source ranges.
- One product-owner-approved staff mobile number. Never substitute a customer number.
- The approved PBX transfer target: the existing queue on Tab 1, internal extension `1003`.
- The public office number `+61 3 5032 4518` remains the spoken callback and fallback; it is not the primary option 2 transfer route.

Use the Compose-managed `voice_audio` tmpfs volume and verify it is mounted with UID/GID 1000 and mode `0700` before starting the profile. The volume must be writable only by the non-root gateway and mounted read-only into Asterisk. Supply secrets through the protected deployment environment, not Git, shell history, screenshots, or chat.

## Ten-item evidence checklist

1. Confirm the normal web and worker services remain healthy and Customer Live SMS/email/Xero settings are unchanged.
2. Start only the `voice-capability` profile with voice acceptance still false; verify Asterisk registers the dedicated SIP user and ARI is reachable only on the private Docker network.
3. Confirm MixMonitor, Monitor, and the ARI recording endpoint are disabled, no recording is configured, and the shared `/dev/shm/accountpulse-voice` directory is empty. (`res_stasis_recording` is an internal dependency of ARI playback in Asterisk 22 and must load, but AccountPulse never invokes it.)
4. Temporarily set `VOICE_GATEWAY_ACCEPT_CALLS=true`, target the approved staff mobile, and submit one call with fictional invoice data.
5. Confirm the staff mobile sees the intended verified caller ID and that no prompt plays before the remote party actually answers.
6. Confirm the first human prompt names the fictional account but states no invoice number or amount.
7. Press 1 and verify the fictional invoice number and amount are clear and correct; then verify generated audio is purged.
8. Run a second staff call, press 2, and verify PBX queue `1003` rings, answers, and carries two-way audio. Confirm no invoice facts are disclosed before transfer and an unanswered queue produces one safe `TRANSFER_UNANSWERED` outcome plus the approved callback guidance.
9. Run a third staff call to controlled voicemail and verify only the generic callback message is left. Run a fourth call and press 9; verify exactly one wrong-number outcome.
10. Set `VOICE_GATEWAY_ACCEPT_CALLS=false` again. Compare AccountPulse, gateway, Asterisk, and VoIPcloud timestamps/call IDs; confirm no audio, recording, transcript, destination, invoice, account name, API key, or SIP password remains in logs or temporary storage.

## Mandatory stop conditions

Stop immediately and leave voice disabled if answer timing, DTMF 1/2/9, caller ID, transfer, voicemail classification, one-call correlation, or audio purge is unreliable. Do not test on a customer. Ask VoIPcloud whether the account supports an outbound SIP trunk/route compatible with Asterisk before changing the architecture.
