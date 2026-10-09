#!/bin/sh
set -eu

threshold="${RETELL_SIGNATURE_FAILURE_ALARM_COUNT:-3}"
count="$(docker logs --since 5m bc5000-web 2>&1 | grep -c 'retell_webhook_signature_failures_total' || true)"

printf '{"metric":"retell_webhook_signature_failures_total","value":%s}\n' "$count"
if [ "$count" -ge "$threshold" ]; then
  printf '{"alarm":"RETELL_WEBHOOK_SIGNATURE_FAILURE_SPIKE","value":%s}\n' "$count" >&2
  exit 2
fi
