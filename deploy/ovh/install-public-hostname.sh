#!/usr/bin/env bash
set -Eeuo pipefail

PUBLIC_HOSTNAME=${1:-ap.motts.com.au}
CADDYFILE=${ACCOUNT_PULSE_CADDYFILE:-/opt/bc5000/Caddyfile}
SITE_FILE=${ACCOUNT_PULSE_SITE_FILE:-/opt/bc5000/accountpulse-site.caddy}
CADDY_CONTAINER=${ACCOUNT_PULSE_CADDY_CONTAINER:-bc5000-caddy}
BACKUP_DIR=${ACCOUNT_PULSE_CADDY_BACKUP_DIR:-/opt/bc5000/caddy-backups}
DEPLOY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

if [[ "$PUBLIC_HOSTNAME" != "ap.motts.com.au" ]]; then
  echo "This reviewed change is scoped only to ap.motts.com.au." >&2
  exit 64
fi
for command in docker curl openssl install mktemp grep cmp; do
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

reload_caddy() {
  # Docker file bind mounts keep the original inode. Recreate Caddy once if a
  # previous installer replaced that inode; otherwise a forced reload is enough.
  if cmp -s "$CADDYFILE" <(docker exec "$CADDY_CONTAINER" cat /etc/caddy/Caddyfile 2>/dev/null); then
    docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
  else
    local project_name image_name rebind_compose network_name
    local -a network_names=() inspected_networks=()
    mapfile -t inspected_networks < <(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' "$CADDY_CONTAINER")
    for network_name in "${inspected_networks[@]}"; do
      [[ -n "$network_name" ]] && network_names+=("$network_name")
    done
    project_name=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CADDY_CONTAINER")
    image_name=$(docker inspect --format '{{.Config.Image}}' "$CADDY_CONTAINER")
    [[ ${#network_names[@]} -gt 0 ]] || { echo "Caddy is not connected to a Docker network." >&2; return 65; }
    for network_name in "${network_names[@]}"; do
      [[ "$network_name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid Caddy network name." >&2; return 65; }
    done
    [[ "$project_name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Invalid Caddy Compose project name." >&2; return 65; }
    [[ "$image_name" =~ ^[A-Za-z0-9_./:@-]+$ ]] || { echo "Invalid Caddy image name." >&2; return 65; }
    rebind_compose=$(mktemp "$DEPLOY_ROOT/.caddy-rebind.XXXXXX.yml")
    {
      cat <<YAML
name: $project_name
services:
  caddy:
    image: $image_name
    container_name: $CADDY_CONTAINER
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - $CADDYFILE:/etc/caddy/Caddyfile:ro
      - /srv/data/caddy/data:/data
      - /srv/data/caddy/config:/config
    networks:
YAML
      for network_name in "${network_names[@]}"; do
        printf '      - %s\n' "$network_name"
      done
      printf 'networks:\n'
      for network_name in "${network_names[@]}"; do
        printf '  %s:\n    external: true\n    name: %s\n' "$network_name" "$network_name"
      done
    } > "$rebind_compose"
    if ! docker compose -f "$rebind_compose" up -d --force-recreate caddy; then
      rm -f "$rebind_compose"
      return 70
    fi
    rm -f "$rebind_compose"
  fi
}

if grep -Fq "$PUBLIC_HOSTNAME" "$CADDYFILE"; then
  reload_caddy
  curl --fail --show-error --silent --retry 18 --retry-delay 5 --retry-all-errors --connect-timeout 10 "https://${PUBLIC_HOSTNAME}/health/ready" >/dev/null
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
    cat "$backup" > "$CADDYFILE"
    chmod 0644 "$CADDYFILE"
    reload_caddy || true
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
installed=true
cat "$candidate" > "$CADDYFILE"
chmod 0644 "$CADDYFILE"
reload_caddy

curl --fail --show-error --silent --retry 18 --retry-delay 5 --retry-all-errors --connect-timeout 10 "https://${PUBLIC_HOSTNAME}/health/ready" >/dev/null
curl --fail --show-error --silent https://billchaser.motts.com.au/health/ready >/dev/null

openssl s_client -connect "${PUBLIC_HOSTNAME}:443" -servername "$PUBLIC_HOSTNAME" </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates -ext subjectAltName

installed=false
trap - ERR
echo "$PUBLIC_HOSTNAME is serving valid HTTPS and the existing Motts health check still passes."
