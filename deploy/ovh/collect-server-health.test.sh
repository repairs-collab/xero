#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

mkdir "$WORK/bin"
cat > "$WORK/bin/docker" <<'SH'
#!/usr/bin/env bash
printf 'true healthy\n'
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
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH"

bash "$SCRIPT_DIR/collect-server-health.sh" "$WORK/mounted"
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
PY

for mount in parent other missing; do
  ADDITIONAL_MOUNT="$mount" bash "$SCRIPT_DIR/collect-server-health.sh" "$WORK/mounted"
  python3 - "$WORK/mounted/server-health.json" <<'PY'
import json
import sys
from pathlib import Path

snapshot = json.loads(Path(sys.argv[1]).read_text())
assert snapshot["additionalDisk"] is None
PY
done
