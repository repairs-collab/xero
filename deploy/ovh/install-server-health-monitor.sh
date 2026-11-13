#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  echo "Run this installer as root." >&2
  exit 77
fi

DEPLOY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

for file in \
  collect-server-health.sh \
  accountpulse-server-health.service \
  accountpulse-server-health.timer; do
  [[ -f "$DEPLOY_ROOT/$file" ]] || {
    echo "Missing reviewed monitor file: $file" >&2
    exit 66
  }
done

install -d -m 0755 /var/lib/accountpulse/server-health
install -m 0755 \
  "$DEPLOY_ROOT/collect-server-health.sh" \
  /usr/local/sbin/accountpulse-collect-server-health
install -m 0644 \
  "$DEPLOY_ROOT/accountpulse-server-health.service" \
  /etc/systemd/system/accountpulse-server-health.service
install -m 0644 \
  "$DEPLOY_ROOT/accountpulse-server-health.timer" \
  /etc/systemd/system/accountpulse-server-health.timer

systemctl daemon-reload
systemctl start accountpulse-server-health.service
systemctl enable --now accountpulse-server-health.timer

echo "AccountPulse server-health snapshot collection is installed."

