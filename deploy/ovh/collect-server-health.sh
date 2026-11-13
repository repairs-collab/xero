#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

OUTPUT_DIR=${1:-/var/lib/accountpulse/server-health}
OUTPUT_FILE="$OUTPUT_DIR/server-health.json"

for command in awk date df docker getconf install mktemp mv; do
  command -v "$command" >/dev/null || {
    echo "Required command is unavailable: $command" >&2
    exit 69
  }
done

install -d -m 0755 "$OUTPUT_DIR"
TEMP_FILE=$(mktemp "$OUTPUT_DIR/.server-health.XXXXXX")
cleanup() {
  rm -f "$TEMP_FILE"
}
trap cleanup EXIT HUP INT TERM

read -r UPTIME_SECONDS _ < /proc/uptime
UPTIME_SECONDS=${UPTIME_SECONDS%%.*}
CPU_CORES=$(getconf _NPROCESSORS_ONLN)
read -r LOAD_1 LOAD_5 LOAD_15 _ < /proc/loadavg

read -r MEMORY_TOTAL MEMORY_USED MEMORY_FREE < <(
  awk '
    /^MemTotal:/ { total = $2 * 1024 }
    /^MemAvailable:/ { available = $2 * 1024 }
    END {
      if (total <= 0 || available < 0 || available > total) exit 1
      printf "%.0f %.0f %.0f\n", total, total - available, available
    }
  ' /proc/meminfo
)

read -r DISK_TOTAL DISK_USED DISK_FREE < <(
  df -B1 --output=size,used,avail / | awk 'NR == 2 { print $1, $2, $3 }'
)

require_unsigned_integer() {
  [[ "$1" =~ ^[0-9]+$ ]] || {
    echo "Host metric is not an unsigned integer." >&2
    exit 65
  }
}

require_non_negative_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
    echo "Host load metric is invalid." >&2
    exit 65
  }
}

for value in \
  "$UPTIME_SECONDS" "$CPU_CORES" \
  "$MEMORY_TOTAL" "$MEMORY_USED" "$MEMORY_FREE" \
  "$DISK_TOTAL" "$DISK_USED" "$DISK_FREE"; do
  require_unsigned_integer "$value"
done
for value in "$LOAD_1" "$LOAD_5" "$LOAD_15"; do
  require_non_negative_number "$value"
done
(( CPU_CORES > 0 && MEMORY_TOTAL > 0 && DISK_TOTAL > 0 )) || {
  echo "Host capacity metric is zero." >&2
  exit 65
}

ADDITIONAL_DISK=null
# Match the exact device and mount so df cannot report the parent filesystem.
if read -r ADDITIONAL_TOTAL ADDITIONAL_USED ADDITIONAL_FREE < <(
  df -B1 --output=source,target,size,used,avail -- /srv/data 2>/dev/null |
    awk '$1 == "/dev/sdb" && $2 == "/srv/data" { print $3, $4, $5 }'
); then
  for value in "$ADDITIONAL_TOTAL" "$ADDITIONAL_USED" "$ADDITIONAL_FREE"; do
    require_unsigned_integer "$value"
  done
  printf -v ADDITIONAL_DISK '{"diskId":698708443,"totalBytes":%s,"usedBytes":%s,"freeBytes":%s}' \
    "$ADDITIONAL_TOTAL" "$ADDITIONAL_USED" "$ADDITIONAL_FREE"
fi

container_status() {
  local container_name=$1
  local state running health
  if ! state=$(docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null); then
    printf 'DOWN'
    return
  fi
  read -r running health <<< "$state"
  if [[ "$running" != true ]]; then
    printf 'DOWN'
    return
  fi
  case "$health" in
    healthy|none) printf 'HEALTHY' ;;
    starting) printf 'STARTING' ;;
    unhealthy) printf 'UNHEALTHY' ;;
    *) printf 'UNHEALTHY' ;;
  esac
}

WEB_STATUS=$(container_status bc5000-web)
WORKER_STATUS=$(container_status bc5000-worker)
POSTGRES_STATUS=$(container_status bc5000-postgres)
CADDY_STATUS=$(container_status bc5000-caddy)
CHECKED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$TEMP_FILE" <<JSON
{
  "schemaVersion": 1,
  "checkedAt": "$CHECKED_AT",
  "host": {
    "uptimeSeconds": $UPTIME_SECONDS,
    "cpuCores": $CPU_CORES,
    "load1": $LOAD_1,
    "load5": $LOAD_5,
    "load15": $LOAD_15
  },
  "memory": {
    "totalBytes": $MEMORY_TOTAL,
    "usedBytes": $MEMORY_USED,
    "freeBytes": $MEMORY_FREE
  },
  "disk": {
    "totalBytes": $DISK_TOTAL,
    "usedBytes": $DISK_USED,
    "freeBytes": $DISK_FREE
  },
  "additionalDisk": $ADDITIONAL_DISK,
  "services": [
    {"name": "web", "status": "$WEB_STATUS"},
    {"name": "worker", "status": "$WORKER_STATUS"},
    {"name": "postgres", "status": "$POSTGRES_STATUS"},
    {"name": "caddy", "status": "$CADDY_STATUS"}
  ]
}
JSON

chmod 0644 "$TEMP_FILE"
mv -f "$TEMP_FILE" "$OUTPUT_FILE"
trap - EXIT HUP INT TERM

