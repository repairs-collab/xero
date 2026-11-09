#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_SHA=${1:-}
PUBLIC_HOSTNAME=${2:-}

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Rollback target must be a recorded 40-character Git commit." >&2
  exit 64
fi
if [[ ! "$PUBLIC_HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Public hostname is invalid." >&2
  exit 64
fi

DEPLOY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
COMPOSE_FILE="$DEPLOY_ROOT/docker-compose.yml"
BASE_ENV=${ACCOUNT_PULSE_ENV_FILE:-$DEPLOY_ROOT/accountpulse.env}
CURRENT_MANIFEST="$DEPLOY_ROOT/current-images.env"
TARGET_MANIFEST="$DEPLOY_ROOT/releases/${TARGET_SHA}/images.env"
ROLLBACK_METADATA="$DEPLOY_ROOT/releases/${TARGET_SHA}/rollback-metadata.json"

[[ -f "$COMPOSE_FILE" ]] || { echo "Missing $COMPOSE_FILE" >&2; exit 66; }
[[ -f "$BASE_ENV" ]] || { echo "Missing protected environment file $BASE_ENV" >&2; exit 66; }
[[ -f "$TARGET_MANIFEST" ]] || { echo "Unknown release $TARGET_SHA" >&2; exit 66; }
grep -Fxq "ACCOUNT_PULSE_WEB_IMAGE=accountpulse-web:${TARGET_SHA}" "$TARGET_MANIFEST"
grep -Fxq "ACCOUNT_PULSE_WORKER_IMAGE=accountpulse-worker:${TARGET_SHA}" "$TARGET_MANIFEST"

exec 9>"$DEPLOY_ROOT/.release.lock"
flock -n 9 || { echo "Another AccountPulse release or rollback is active." >&2; exit 75; }

cp "$TARGET_MANIFEST" "$CURRENT_MANIFEST"
compose=(docker compose --env-file "$BASE_ENV" --env-file "$CURRENT_MANIFEST" -f "$COMPOSE_FILE")
"${compose[@]}" up -d
curl --fail --show-error --silent --retry 12 --retry-delay 5 \
  "https://${PUBLIC_HOSTNAME}/health/ready" >/dev/null

printf '{\n  "targetReleaseSha": "%s",\n  "hostname": "%s",\n  "rolledBackAt": "%s"\n}\n' \
  "$TARGET_SHA" "$PUBLIC_HOSTNAME" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$ROLLBACK_METADATA"

echo "AccountPulse is healthy on recorded release $TARGET_SHA. Database contents were preserved."
