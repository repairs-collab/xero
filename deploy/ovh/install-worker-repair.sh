#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  echo "Run this installer as root." >&2
  exit 77
fi

SCRIPT_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
DEPLOY_ROOT=$(cd -- "${1:-$SCRIPT_ROOT}" && pwd -P)
if [[ ! "$DEPLOY_ROOT" =~ ^/[A-Za-z0-9._/-]+$ || ! -f "$DEPLOY_ROOT/.release.lock" ]]; then
  echo "A protected AccountPulse deployment directory with its release lock is required." >&2
  exit 65
fi

install -d -m 0755 /etc/accountpulse
umask 077
printf 'ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT=%s\n' "$DEPLOY_ROOT" > /etc/accountpulse/worker-repair.env
install -m 0755 "$SCRIPT_ROOT/run-worker-repair.sh" /usr/local/sbin/accountpulse-run-worker-repair
install -m 0644 "$SCRIPT_ROOT/accountpulse-worker-repair.service" /etc/systemd/system/
install -m 0644 "$SCRIPT_ROOT/accountpulse-worker-repair.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl start accountpulse-worker-repair.service
systemctl enable --now accountpulse-worker-repair.timer

echo "AccountPulse worker repair runner is installed."
