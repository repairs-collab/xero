# Provider setup runbook

No credential value is pasted into Bill Chaser 5000. Store credentials in AWS Secrets Manager and enter only the Sydney secret ARN in Admin Settings → Integrations.

## Safely write a secret

This pattern avoids shell history and process-argument disclosure:

```bash
set +x
umask 077
SECRET_FILE="$(mktemp)"
trap 'rm -f "$SECRET_FILE"' EXIT
read -rsp 'Client/API ID: ' CLIENT_ID; printf '\n'
read -rsp 'Client/API secret: ' CLIENT_SECRET; printf '\n'
jq -n --arg id "$CLIENT_ID" --arg secret "$CLIENT_SECRET" \
  '{clientId:$id,clientSecret:$secret}' >"$SECRET_FILE"
unset CLIENT_ID CLIENT_SECRET
aws secretsmanager put-secret-value --region ap-southeast-2 \
  --secret-id production/bill-chaser-5000/xero-api \
  --secret-string "file://${SECRET_FILE}"
rm -f "$SECRET_FILE"; trap - EXIT
```

For Sinch, use JSON keys `apiKey` and `apiSecret` and secret ID `production/bill-chaser-5000/sinch-api`.

## Xero Custom Connection

1. Open Xero Developer → My Apps → **Bill Chaser 5000** and confirm it is a Custom Connection for the intended organisation.
2. Configure exactly these scopes: `accounting.invoices accounting.contacts.read accounting.settings.read`. Do not add `offline_access`; Custom Connections use client credentials. Bill Chaser does not send `xero-tenant-id` for this connection type.
3. Store the client ID/secret with the safe pattern above. In Bill Chaser, set the Xero secret reference and choose **Test connection**. The test must report all three scopes and the expected Xero organisation.
4. Copy Xero's webhook signing key to `production/bill-chaser-5000/xero-webhook` without printing it.
5. In the Xero app's Webhooks section, set the delivery URL to `https://HOST/api/webhooks/xero`, enable invoice events, and save. Complete Xero's intent-to-receive validation; Bill Chaser returns `200` only when the signature and payload are valid.
6. Confirm a signed invoice test event appears under Activity with one stored webhook and one invoice-refresh job, even if Xero retries it.

## Sinch Engage APAC

1. In Sinch Engage, go to Settings → API and create API credentials. Store `apiKey` and `apiSecret` in `production/bill-chaser-5000/sinch-api`.
2. Bill Chaser uses `https://au.app.api.sinch.com`. **Test connection** performs the read-only `GET /v1/replies` check. A successful test must not send a message.
3. Ask Sinch Support to confirm `API_SECURE_CALLBACKS` is enabled. Sinch requires HTTPS and supports TLS 1.2/1.3; use TLS 1.3 where available.
4. Create an RSA/SHA-512 callback signing key with `POST /v1/iam/signature_keys` and body `{"digest":"SHA512","cipher":"RSA"}`. Store the returned `key_id` and public key. Enable it with `PATCH /v1/iam/signature_keys/enabled` and body `{"key_id":"KEY_ID"}`. Only one key can be enabled at a time.
5. Store the public key as JSON keyed by ID in `production/bill-chaser-5000/sinch-webhook-public-key`, for example `{"KEY_ID":"-----BEGIN PUBLIC KEY-----\\n…\\n-----END PUBLIC KEY-----"}`. Never store the Sinch private key; it remains with Sinch.
6. The deployment generates `production/bill-chaser-5000/sinch-webhook-token`. Retrieve it only through an approved secret-reading session; do not print it, paste it into tickets, or store it in source control.
7. In Sinch Engage **API settings â†’ Webhooks**, create three POST/JSON webhooks to `https://HOST/api/webhooks/sinch`, with five retries and a retry delay of 30 seconds. Add the custom header `X-AccountPulse-Webhook-Token` to each webhook with the exact secret value from step 6. Use these event selections and parser-compatible body fields:

   - **Receive an SMS**: `event_type=REPLY`, `reply_id=$moId`, `message_id=$mtId`, `source_number=$sourceAddress`, `destination_number=$destinationAddress`, `received_date=$receivedTimestamp`, and `content=$moContent`.
   - **Opt-out occurred**: `event_type=OPT_OUT`, `notification_id=$notificationId`, `message_id=$messageId`, `source_number=$sourceAddress`, `destination_number=$destinationAddress`, `received_date=$receivedTimestamp`, and `content=$moContent`. Do not use `$moId` for this event; Sinch opt-outs have their own notification ID.
   - **Delivery reports** (all available submitted, en route, delivered, expired, rejected, and failed events): `event_type=DELIVERY_REPORT`, `message_id=$mtId`, `status=$status`, `status_code=$statusCode`, and `timestamp=$receivedTimestamp`.

8. Save each webhook and confirm the Sinch list contains exactly these three AccountPulse webhooks. A test callback must return `202`; a wrong or missing shared-token header must return `401`. Legacy per-message callbacks may instead contain the `X-MessageMedia-*` signature headers and remain supported.
9. Send one approved SMS, verify its delivery callback, reply to it, and send `STOP`. The reply must appear in Inbox and pause the whole customer; the opt-out must also suppress future SMS. Do not mark provider setup complete until all three checks pass.
10. If replies existed before the webhooks were installed, run the one-off `recover-inbound-replies` worker command. It confirms only replies stored successfully (or deliberately excluded by the latest completed reset), reports safe reply IDs for failures, and exits non-zero unless the provider queue is fully drained.

### Shared pool for AccountPulse Solo

1. Use one Australian Sinch Engage sub-account per AccountPulse company and confirm the parent credentials can act on its behalf. Confirm any Sinch sub-account fees before adding new ones. Set the sub-account's default sender to **Shared Numbers Pool**. Leave the parent account's sender as configured for existing traffic. [Sinch sub-account setup](https://support.app.sinch.com/hc/en-us/articles/10540831428751-Sub-accounts)
2. Configure the three callback types above for each sub-account. Include `account_id=$accountId` in all three. Include the original `message_id=$messageId` and echoed `metadata` when available. In the opt-out template, use a conditional such as `#if($messageId)"message_id":"$messageId",#end` before another field so an unsolicited STOP omits the field. Sinch may omit `destination_number` for shared sends. [Sinch Engage API reference](https://developers.app.sinch.com/)
3. In **Owner panel → SMS → Shared SMS and company inboxes**, select the company and enter its Sinch sub-account ID after confirming the default sender and callbacks. AccountPulse sends via that account and maintains the company’s own 1,000-part monthly allowance and A$0.11 ex GST per additional part.
4. For the beta, use two controlled companies to send an invoice reminder for a test contact using the same approved handset. Reply separately to both threads. Verify the replies, delivery reports and a STOP reach only the company that sent the corresponding message. Also verify that a reply with missing or conflicting linkage never appears in a customer inbox. Confirm this at the handset and in both AccountPulse inboxes before enabling shared SMS for customers.
5. For a missing reply, inspect it in the relevant Sinch sub-account. Keep its original message ID and reply ID for investigation. Run `recover-inbound-replies` scoped to the affected AccountPulse organisation when appropriate.

## Rotation

- Xero/Sinch API credentials: add a new secret version, test, force worker deployment, then revoke the old credential.
- Xero webhook key: coordinate the app change and web deployment as one maintenance action; watch signature-failure alarms.
- Sinch callback key: create the new key, store both public keys, deploy web, enable the new Sinch key, verify a signed callback, then remove the old public key.
- Sinch webhook token: schedule a short maintenance window, create a new secret version, deploy the web task, immediately replace the custom header on all three Sinch webhooks, then verify a `202` test callback. Roll back both the secret version and webhook headers together if verification fails.
- Session secret: first disable live sending, rotate, force web deployment, and expect all user sessions to be invalidated.
