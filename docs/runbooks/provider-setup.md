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
2. Bill Chaser uses `https://au.app.api.sinch.com`. **Test connection** performs the read-only `GET /v1/webhooks/messages?page=0&page_size=1` check. A successful test must not send a message.
3. Ask Sinch Support to confirm `API_SECURE_CALLBACKS` is enabled. Sinch requires HTTPS and supports TLS 1.2/1.3; use TLS 1.3 where available.
4. Create an RSA/SHA-512 callback signing key with `POST /v1/iam/signature_keys` and body `{"digest":"SHA512","cipher":"RSA"}`. Store the returned `key_id` and public key. Enable it with `PATCH /v1/iam/signature_keys/enabled` and body `{"key_id":"KEY_ID"}`. Only one key can be enabled at a time.
5. Store the public key as JSON keyed by ID in `production/bill-chaser-5000/sinch-webhook-public-key`, for example `{"KEY_ID":"-----BEGIN PUBLIC KEY-----\\n…\\n-----END PUBLIC KEY-----"}`. Never store the Sinch private key; it remains with Sinch.
6. Create three POST/JSON webhooks to `https://HOST/api/webhooks/sinch`, with five retries and a retry delay of 30 seconds:

   - `RECEIVED_SMS`, with a template producing `event_type=REPLY`, `reply_id`, `source_number`, `destination_number`, `received_date`, `content`, optional `message_id`, and `metadata`.
   - `OPT_OUT_SMS`, with a template producing `event_type=OPT_OUT`, `notification_id`, `source_number`, `destination_number`, `received_date`, `content`, and optional `message_id`.
   - `ENROUTE_DR`, `SUBMITTED_DR`, `DELIVERED_DR`, `EXPIRED_DR`, `REJECTED_DR`, and `FAILED_DR`, with a template producing `event_type=DELIVERY_REPORT`, `message_id`, `status`, numeric `status_code`, `timestamp`, and `metadata`.

7. Verify callbacks contain `X-MessageMedia-Signature`, `X-MessageMedia-Digest-Type`, `X-MessageMedia-Cipher-Type`, and `X-MessageMedia-Key-Id`. Bill Chaser verifies the signature over the request line, Date header, and exact raw body before storing the event.
8. Send one allowlisted SMS, verify its delivery callback, reply to it, and send `STOP`. The reply must pause the whole customer; the opt-out must also suppress future SMS.

## Rotation

- Xero/Sinch API credentials: add a new secret version, test, force worker deployment, then revoke the old credential.
- Xero webhook key: coordinate the app change and web deployment as one maintenance action; watch signature-failure alarms.
- Sinch callback key: create the new key, store both public keys, deploy web, enable the new Sinch key, verify a signed callback, then remove the old public key.
- Session secret: first disable live sending, rotate, force web deployment, and expect all user sessions to be invalidated.
