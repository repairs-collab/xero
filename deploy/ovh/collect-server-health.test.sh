#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

mkdir "$WORK/bin"
cat > "$WORK/bin/docker" <<'SH'
#!/usr/bin/env bash
case "$1" in
  inspect)
    if [[ "${*: -1}" == bc5000-worker ]]; then
      printf '%s\n' "${WORKER_STATE:-true false healthy}"
    else
      printf 'true false healthy\n'
    fi
    ;;
  exec)
    if [[ "${OPS_PROBE_FAIL:-false}" == true ]]; then
      echo 'private database error' >&2
      exit 1
    fi
    printf '%s\n' "${OPS_COUNTS:-0 0}"
    ;;
  *) exit 2 ;;
esac
SH
cat > "$WORK/bin/df" <<'SH'
#!/usr/bin/env bash
case "${*: -1}" in
  /) printf '1B-blocks Used Avail\n100000000000 40000000000 60000000000\n' ;;
  /srv/data)
    printf 'Filesystem Mounted on 1B-blocks Used Avail\n'
    case "${ADDITIONAL_MOUNT:-expected}" in
      expected) printf '/dev/sdb /srv/data 198000000000 75000000000 123000000000\n' ;;
      parent) printf '/dev/sda1 / 100000000000 40000000000 60000000000\n' ;;
      other) printf '/dev/sdc /srv/data 198000000000 75000000000 123000000000\n' ;;
      missing) exit 1 ;;
    esac
    ;;
  *) exit 2 ;;
esac
SH
cat > "$WORK/bin/curl" <<'SH'
#!/usr/bin/env bash
[[ "$*" == *"--proto =smtps"* ]]
cat >> "$MOCK_MAILBOX"
SH
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH"
export MOCK_MAILBOX="$WORK/alert-mail"

touch "$WORK/operations.sql"
OPS_COUNTS="2 3" bash "$SCRIPT_DIR/collect-server-health.sh" "$WORK/mounted" "$WORK/operations.sql" 2>"$WORK/alerts"
grep -q 'ACCOUNTPULSE_REMINDER_SCHEDULE_STALE workspaces=2' "$WORK/alerts"
grep -q 'ACCOUNTPULSE_XERO_SYNC_STALE workspaces=3' "$WORK/alerts"
python3 - "$WORK/mounted/server-health.json" <<'PY'
import json
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_text()
snapshot = json.loads(raw)
assert snapshot["disk"] == {
    "totalBytes": 100_000_000_000,
    "usedBytes": 40_000_000_000,
    "freeBytes": 60_000_000_000,
}
assert snapshot["additionalDisk"] == {
    "diskId": 698708443,
    "totalBytes": 198_000_000_000,
    "usedBytes": 75_000_000_000,
    "freeBytes": 123_000_000_000,
}
assert "/srv/data" not in raw and "/dev/sdb" not in raw
assert snapshot["operations"] == {"overdueReminderWorkspaces": 2, "staleXeroWorkspaces": 3}
PY

WORKER_STATE="true true starting" OPS_PROBE_FAIL=true bash "$SCRIPT_DIR/collect-server-health.sh" "$WORK/mounted" "$WORK/operations.sql" 2>"$WORK/alerts"
grep -q 'ACCOUNTPULSE_WORKER_UNAVAILABLE state=DOWN' "$WORK/alerts"
grep -q 'ACCOUNTPULSE_OPERATIONS_PROBE_UNAVAILABLE' "$WORK/alerts"
! grep -q 'private database error' "$WORK/alerts"
python3 - "$WORK/mounted/server-health.json" <<'PY'
import json
import sys
from pathlib import Path

snapshot = json.loads(Path(sys.argv[1]).read_text())
assert snapshot["operations"] is None
assert next(service for service in snapshot["services"] if service["name"] == "worker")["status"] == "DOWN"
PY

WORKER_STATE="true false none" OPS_COUNTS="0 0" bash "$SCRIPT_DIR/collect-server-health.sh" "$WORK/mounted" "$WORK/operations.sql" 2>"$WORK/alerts"
grep -q 'ACCOUNTPULSE_WORKER_UNAVAILABLE state=UNHEALTHY' "$WORK/alerts"
! grep -q '_STALE' "$WORK/alerts"

touch "$WORK/mail.curl"
for run in first duplicate; do
  OPS_COUNTS="0 1" bash "$SCRIPT_DIR/collect-server-health.sh" "$WORK/mounted" "$WORK/operations.sql" "$WORK/mail.curl" 2>"$WORK/alerts"
done
test "$(grep -c 'Subject: AccountPulse operations alert' "$MOCK_MAILBOX")" = 1
grep -q 'ACCOUNTPULSE_XERO_SYNC_STALE workspaces=1' "$MOCK_MAILBOX"

for mount in parent other missing; do
  ADDITIONAL_MOUNT="$mount" bash "$SCRIPT_DIR/collect-server-health.sh" "$WORK/mounted" "$WORK/operations.sql"
  python3 - "$WORK/mounted/server-health.json" <<'PY'
import json
import sys
from pathlib import Path

snapshot = json.loads(Path(sys.argv[1]).read_text())
assert snapshot["additionalDisk"] is None
PY
done
