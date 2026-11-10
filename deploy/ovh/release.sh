#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_SHA=${1:-}
PUBLIC_HOSTNAME=${2:-}

if [[ ! "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release SHA must be a full 40-character lowercase Git commit." >&2
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
RELEASE_DIR="$DEPLOY_ROOT/releases/$RELEASE_SHA"
ARTIFACT_DIR="$DEPLOY_ROOT/artifacts/$RELEASE_SHA"
BACKUP_DIR="$DEPLOY_ROOT/backups"
CANDIDATE_MANIFEST="$RELEASE_DIR/images.env"
PREVIOUS_MANIFEST="$RELEASE_DIR/previous-images.env"
METADATA_FILE="$RELEASE_DIR/release-metadata.json"

for command in docker flock curl zstd; do
  command -v "$command" >/dev/null || {
    echo "Required command is unavailable: $command" >&2
    exit 69
  }
done

[[ -f "$COMPOSE_FILE" ]] || { echo "Missing $COMPOSE_FILE" >&2; exit 66; }
[[ -f "$BASE_ENV" ]] || { echo "Missing protected environment file $BASE_ENV" >&2; exit 66; }
[[ -f "$ARTIFACT_DIR/accountpulse-web.tar.zst" ]] || { echo "Missing web image artifact" >&2; exit 66; }
[[ -f "$ARTIFACT_DIR/accountpulse-worker.tar.zst" ]] || { echo "Missing worker image artifact" >&2; exit 66; }

mkdir -p "$RELEASE_DIR" "$BACKUP_DIR"
exec 9>"$DEPLOY_ROOT/.release.lock"
flock -n 9 || { echo "Another AccountPulse release or rollback is active." >&2; exit 75; }

printf 'ACCOUNT_PULSE_WEB_IMAGE=accountpulse-web:%s\n' "$RELEASE_SHA" > "$CANDIDATE_MANIFEST"
printf 'ACCOUNT_PULSE_WORKER_IMAGE=accountpulse-worker:%s\n' "$RELEASE_SHA" >> "$CANDIDATE_MANIFEST"

if [[ -f "$CURRENT_MANIFEST" ]]; then
  cp "$CURRENT_MANIFEST" "$PREVIOUS_MANIFEST"
else
  grep -E '^ACCOUNT_PULSE_(WEB|WORKER)_IMAGE=' "$BASE_ENV" > "$PREVIOUS_MANIFEST" || true
fi
if [[ ! -s "$PREVIOUS_MANIFEST" ]]; then
  echo "No previous image manifest is available; refusing a release without rollback metadata." >&2
  exit 65
fi

zstd -dc "$ARTIFACT_DIR/accountpulse-web.tar.zst" | docker load
zstd -dc "$ARTIFACT_DIR/accountpulse-worker.tar.zst" | docker load
docker image inspect "accountpulse-web:${RELEASE_SHA}" >/dev/null
docker image inspect "accountpulse-worker:${RELEASE_SHA}" >/dev/null

base_compose=(docker compose --env-file "$BASE_ENV" -f "$COMPOSE_FILE")
if [[ -f "$CURRENT_MANIFEST" ]]; then
  current_compose=(docker compose --env-file "$BASE_ENV" --env-file "$CURRENT_MANIFEST" -f "$COMPOSE_FILE")
else
  current_compose=("${base_compose[@]}")
fi

"${current_compose[@]}" up -d postgres
for attempt in {1..30}; do
  if "${current_compose[@]}" exec -T postgres sh -c \
    'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    echo "PostgreSQL did not become ready for the pre-release backup." >&2
    exit 70
  fi
  sleep 2
done

BACKUP_FILE="$BACKUP_DIR/pre-${RELEASE_SHA}-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${current_compose[@]}" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP_FILE"
test -s "$BACKUP_FILE"

rollback_armed=false
rollback_images() {
  if [[ "$rollback_armed" != true ]]; then
    return 0
  fi
  echo "Release failed; restoring the previous Compose image values." >&2
  cp "$PREVIOUS_MANIFEST" "$CURRENT_MANIFEST"
  local rollback_compose=(docker compose --env-file "$BASE_ENV" --env-file "$CURRENT_MANIFEST" -f "$COMPOSE_FILE")
  "${rollback_compose[@]}" up -d
}

on_error() {
  local status=$?
  trap - ERR
  set +e
  rollback_images
  exit "$status"
}
trap on_error ERR

candidate_compose=(docker compose --env-file "$BASE_ENV" --env-file "$CANDIDATE_MANIFEST" -f "$COMPOSE_FILE")
"${candidate_compose[@]}" run --rm worker node /app/worker.mjs migrate

cp "$CANDIDATE_MANIFEST" "$CURRENT_MANIFEST"
rollback_armed=true
active_compose=(docker compose --env-file "$BASE_ENV" --env-file "$CURRENT_MANIFEST" -f "$COMPOSE_FILE")
"${active_compose[@]}" up -d

curl --fail --show-error --silent --retry 12 --retry-delay 5 \
  "https://${PUBLIC_HOSTNAME}/health/ready" >/dev/null

PREVIOUS_SHA=$(sed -n 's/^ACCOUNT_PULSE_WEB_IMAGE=.*://p' "$PREVIOUS_MANIFEST" | head -n 1)
printf '{\n  "releaseSha": "%s",\n  "previousReleaseSha": "%s",\n  "hostname": "%s",\n  "backup": "%s",\n  "releasedAt": "%s"\n}\n' \
  "$RELEASE_SHA" "$PREVIOUS_SHA" "$PUBLIC_HOSTNAME" "$BACKUP_FILE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$METADATA_FILE"

rollback_armed=false
trap - ERR
echo "AccountPulse release $RELEASE_SHA is healthy."
