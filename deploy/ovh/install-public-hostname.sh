#!/usr/bin/env bash
set -Eeuo pipefail

PUBLIC_HOSTNAME=${1:-ap.motts.com.au}
CADDYFILE=${ACCOUNT_PULSE_CADDYFILE:-/opt/bc5000/Caddyfile}
SITE_FILE=${ACCOUNT_PULSE_SITE_FILE:-/opt/bc5000/accountpulse-site.caddy}
CADDY_CONTAINER=${ACCOUNT_PULSE_CADDY_CONTAINER:-bc5000-caddy}
BACKUP_DIR=${ACCOUNT_PULSE_CADDY_BACKUP_DIR:-/opt/bc5000/caddy-backups}

if [[ "$PUBLIC_HOSTNAME" != "ap.motts.com.au" ]]; then
  echo "This reviewed change is scoped only to ap.motts.com.au." >&2
  exit 64
fi
for command in docker curl openssl install mktemp grep; do
  command -v "$command" >/dev/null || {
    echo "Required command is unavailable: $command" >&2
    exit 69
  }
done
[[ -f "$CADDYFILE" ]] || { echo "Missing live Caddyfile: $CADDYFILE" >&2; exit 66; }
[[ -f "$SITE_FILE" ]] || { echo "Missing reviewed site block: $SITE_FILE" >&2; exit 66; }
grep -Fq 'billchaser.motts.com.au' "$CADDYFILE" || {
  echo "The existing Motts hostname was not found; refusing an unsafe change." >&2
  exit 65
}
if grep -Fq "$PUBLIC_HOSTNAME" "$CADDYFILE"; then
  curl --fail --show-error --silent --retry 12 --retry-delay 5 "https://${PUBLIC_HOSTNAME}/health/ready" >/dev/null
  curl --fail --show-error --silent https://billchaser.motts.com.au/health/ready >/dev/null
  openssl s_client -connect "${PUBLIC_HOSTNAME}:443" -servername "$PUBLIC_HOSTNAME" </dev/null 2>/dev/null |
    openssl x509 -noout -subject -issuer -dates -ext subjectAltName
  echo "$PUBLIC_HOSTNAME already serves valid HTTPS and the existing Motts health check still passes."
  exit 0
fi

curl --fail --show-error --silent https://billchaser.motts.com.au/health/ready >/dev/null

mkdir -p "$BACKUP_DIR"
candidate=$(mktemp "${CADDYFILE}.candidate.XXXXXX")
backup="$BACKUP_DIR/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ)"
installed=false

cleanup() {
  rm -f "$candidate"
}

on_error() {
  local status=$?
  trap - ERR
  if [[ "$installed" == true && -f "$backup" ]]; then
    install -m 0644 "$backup" "$CADDYFILE"
    docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
  fi
  exit "$status"
}

trap cleanup EXIT
# ERR trap protects the existing billchaser.motts.com.au route.
trap on_error ERR

{
  cat "$CADDYFILE"
  printf '\n'
  cat "$SITE_FILE"
  printf '\n'
} > "$candidate"

docker run --rm -v "$candidate:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

install -m 0644 "$CADDYFILE" "$backup"
install -m 0644 "$candidate" "$CADDYFILE"
installed=true
docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

curl --fail --show-error --silent --retry 12 --retry-delay 5 "https://${PUBLIC_HOSTNAME}/health/ready" >/dev/null
curl --fail --show-error --silent https://billchaser.motts.com.au/health/ready >/dev/null

openssl s_client -connect "${PUBLIC_HOSTNAME}:443" -servername "$PUBLIC_HOSTNAME" </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates -ext subjectAltName

installed=false
trap - ERR
echo "$PUBLIC_HOSTNAME is serving valid HTTPS and the existing Motts health check still passes."
