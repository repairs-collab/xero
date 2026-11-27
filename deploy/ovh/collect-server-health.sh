#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

OUTPUT_DIR=${1:-/var/lib/accountpulse/server-health}
OPERATIONS_SQL=${2:-/usr/local/share/accountpulse/server-health-operations.sql}
ALERT_MAIL_CONFIG=${3:-/etc/accountpulse/server-health-mail.curl}
OUTPUT_FILE="$OUTPUT_DIR/server-health.json"

for command in awk date df docker getconf install mktemp mv timeout; do
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
  local state running restarting health
  if ! state=$(timeout 4s docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name" 2>/dev/null); then
    printf 'DOWN'
    return
  fi
  read -r running restarting health <<< "$state"
  if [[ "$running" != true || "$restarting" == true ]]; then
    printf 'DOWN'
    return
  fi
  case "$health" in
    healthy) printf 'HEALTHY' ;;
    none)
      if [[ "$container_name" == bc5000-worker ]]; then
        printf 'UNHEALTHY'
      else
        printf 'HEALTHY'
      fi
      ;;
    starting) printf 'STARTING' ;;
    unhealthy) printf 'UNHEALTHY' ;;
    *) printf 'UNHEALTHY' ;;
  esac
}

WEB_STATUS=$(container_status bc5000-web)
WORKER_STATUS=$(container_status bc5000-worker)
POSTGRES_STATUS=$(container_status bc5000-postgres)
CADDY_STATUS=$(container_status bc5000-caddy)

alert_codes=()
alert_lines=()
alert() {
  local priority=$1 code=$2 detail=${3:-}
  printf '<%s>%s%s\n' "$priority" "$code" "${detail:+ $detail}" >&2
  alert_codes+=("$code")
  alert_lines+=("$code${detail:+ $detail}")
}

if [[ "$WORKER_STATUS" == DOWN || "$WORKER_STATUS" == UNHEALTHY ]]; then
  alert 3 ACCOUNTPULSE_WORKER_UNAVAILABLE "state=$WORKER_STATUS"
fi

OPERATIONS=null
if [[ -r "$OPERATIONS_SQL" ]] && counts=$(timeout 10s docker exec -i bc5000-postgres sh -ceu \
  'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' \
  < "$OPERATIONS_SQL" 2>/dev/null) && [[ "$counts" =~ ^(0|[1-9][0-9]{0,9})\ (0|[1-9][0-9]{0,9})$ ]]; then
  overdue_reminder_workspaces=${BASH_REMATCH[1]}
  stale_xero_workspaces=${BASH_REMATCH[2]}
  printf -v OPERATIONS '{"overdueReminderWorkspaces":%s,"staleXeroWorkspaces":%s}' \
    "$overdue_reminder_workspaces" "$stale_xero_workspaces"
  if (( overdue_reminder_workspaces > 0 )); then
    alert 3 ACCOUNTPULSE_REMINDER_SCHEDULE_STALE "workspaces=$overdue_reminder_workspaces"
  fi
  if (( stale_xero_workspaces > 0 )); then
    alert 3 ACCOUNTPULSE_XERO_SYNC_STALE "workspaces=$stale_xero_workspaces"
  fi
else
  alert 4 ACCOUNTPULSE_OPERATIONS_PROBE_UNAVAILABLE
fi

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
  "operations": $OPERATIONS,
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

# Email is optional. Use the administrator's existing TLS mail relay only
# when explicitly configured, and limit repeats of the same active alert.
if [[ -r "$ALERT_MAIL_CONFIG" ]]; then
  alert_state="$OUTPUT_DIR/.last-emailed-alert"
  if (( ${#alert_codes[@]} == 0 )); then
    rm -f "$alert_state"
  else
    last_epoch=0
    last_alert=''
    if [[ -f "$alert_state" ]]; then
      read -r last_epoch last_alert < "$alert_state" || true
    fi
    now_epoch=$(date +%s)
    alert_signature=$(IFS=,; echo "${alert_codes[*]}")
    if [[ "$last_alert" != "$alert_signature" || ! "$last_epoch" =~ ^[0-9]{1,12}$ ]] ||
      (( now_epoch - 10#$last_epoch >= 3600 || now_epoch < 10#$last_epoch )); then
      if {
        printf 'From: AccountPulse Operations <ap@motts.com.au>\r\n'
        printf 'To: ap@motts.com.au\r\n'
        printf 'Date: %s\r\n' "$(LC_ALL=C date -R)"
        printf 'Subject: AccountPulse operations alert\r\n'
        printf 'Content-Type: text/plain; charset=UTF-8\r\n\r\n'
        printf 'Checked at %s\r\n' "$CHECKED_AT"
        printf '%s\r\n' "${alert_lines[@]}"
        printf '\r\nOpen Owner panel > Server health to review.\r\n'
      } | curl --disable --config "$ALERT_MAIL_CONFIG" --proto '=smtps' \
        --max-time 8 --silent --upload-file - >/dev/null 2>&1; then
        printf '%s %s\n' "$now_epoch" "$alert_signature" > "$alert_state"
      else
        printf '<3>ACCOUNTPULSE_ALERT_EMAIL_FAILED\n' >&2
      fi
    fi
  fi
fi

