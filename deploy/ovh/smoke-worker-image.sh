#!/usr/bin/env bash
set -Eeuo pipefail

image=${1:-}
if [[ ! "$image" =~ ^accountpulse-worker:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]]; then
  echo 'Pass the locally built accountpulse-worker image tag.' >&2
  exit 64
fi

docker image inspect "$image" >/dev/null
network=$(docker network create --internal "accountpulse-worker-smoke-$$-$RANDOM")
suffix=${network:0:12}
database_container="accountpulse-worker-smoke-db-$suffix"
migration_container="accountpulse-worker-smoke-migrate-$suffix"
worker_container="accountpulse-worker-smoke-app-$suffix"

cleanup() {
  docker rm --force --volumes "$worker_container" "$migration_container" "$database_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$database_container" --network "$network" \
  --network-alias smoke-db \
  --env POSTGRES_DB=accountpulse_smoke --env POSTGRES_PASSWORD=smoke-db-password \
  postgres:17-alpine >/dev/null

for attempt in {1..30}; do
  if docker exec "$database_container" pg_isready -h 127.0.0.1 \
    -U postgres -d accountpulse_smoke >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    echo 'Smoke-test PostgreSQL failed to listen on TCP.' >&2
    docker logs --tail 30 "$database_container" >&2 || true
    exit 1
  fi
  sleep 2
done

# Only synthetic values enter these containers. The internal network blocks egress.
holiday_coverage=$(date -u -d '+400 days' +%F)
worker_environment=(
  --pull never --network "$network"
  --env NODE_ENV=production
  --env SEND_MODE=dry-run
  --env DATABASE_URL=postgresql://postgres:smoke-db-password@smoke-db:5432/accountpulse_smoke
  --env PUBLIC_BASE_URL=https://accountpulse-smoke.invalid
  --env XERO_OAUTH_CLIENT_ID=smoke-xero-id
  --env XERO_OAUTH_CLIENT_SECRET=smoke-xero-secret
  --env XERO_OAUTH_REDIRECT_URI=https://accountpulse-smoke.invalid/xero/callback
  --env XERO_TOKEN_ACTIVE_KEY_ID=smoke
  --env 'XERO_TOKEN_ENCRYPTION_KEYS_JSON={"smoke":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}'
  --env 'SINCH_API_CREDENTIALS={"apiKey":"smoke-sinch-key","apiSecret":"smoke-sinch-secret"}'
  --env SMS_NUMBER_QUARANTINE_DAYS=30
  --env DEBT_CONTACT_HOLIDAY_CALENDAR_VERSION=smoke-test
  --env "DEBT_CONTACT_HOLIDAY_COVERAGE_END=$holiday_coverage"
  --env "DEBT_CONTACT_HOLIDAY_DATES_JSON=[\"$holiday_coverage\"]"
  --env VOICE_GATEWAY_SIGNING_SECRET=smoke-voice-secret
  --env VOICE_GATEWAY_URL=http://voice-smoke.invalid
  --env VOICE_GATEWAY_ACCEPT_CALLS=false
  --env STRIPE_SECRET_KEY=sk_test_smoke_only
  --env STRIPE_WEBHOOK_SECRET=whsec_smoke_only
  --env STRIPE_SOLO_MONTHLY_PRICE_ID=price_smoke_monthly
  --env STRIPE_SOLO_ANNUAL_PRICE_ID=price_smoke_annual
  --env STRIPE_SMS_OVERAGE_PRICE_ID=price_smoke_overage
  --env STRIPE_PORTAL_CONFIGURATION_ID=bpc_smoke_portal
)

timeout --kill-after=5s 120s docker run --rm --name "$migration_container" \
  "${worker_environment[@]}" "$image" node /app/worker.mjs migrate
docker run --detach --name "$worker_container" \
  "${worker_environment[@]}" "$image" >/dev/null

for attempt in {1..50}; do
  worker_details=$(docker inspect --type container --format \
    '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' \
    "$worker_container")
  read -r state health restarts <<< "$worker_details"
  if [[ "$state" == running && "$health" == healthy && "$restarts" == 0 ]]; then
    echo 'Built worker image started and registered its job handlers.'
    exit 0
  fi
  if [[ "$restarts" != 0 || "$state" == restarting || "$state" == dead ||
        "$state" == exited || "$health" == unhealthy || "$health" == none ]]; then
    break
  fi
  sleep 2
done

echo "Built worker image failed startup smoke test (state=$state, health=$health, restarts=$restarts)." >&2
docker logs --tail 60 "$worker_container" >&2 || true
exit 1
