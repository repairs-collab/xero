#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if (( EUID != 0 )) || (( $# != 4 )); then
  echo 'Run as root with the deploy directory, verified age binary, age public recipient file and SSH public key file.' >&2
  exit 64
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
deploy_root=$(cd -- "$1" && pwd -P)
[[ "$deploy_root" =~ ^/[A-Za-z0-9._/-]+$ && -f "$deploy_root/docker-compose.yml" ]] ||
  { echo 'The AccountPulse deployment directory is invalid.' >&2; exit 65; }
for file in "$2" "$3" "$4"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo 'An installation input is missing or invalid.' >&2; exit 65; }
done
printf '%s  %s\n' eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c "$2" |
  sha256sum --check --status ||
  { echo 'The supplied age v1.3.2 Linux amd64 binary did not match its pinned checksum.' >&2; exit 65; }
mapfile -t recipients < <(tr -d '\r' < "$3")
mapfile -t public_keys < <(tr -d '\r' < "$4")
[[ ${#recipients[@]} == 1 && "${recipients[0]}" =~ ^age1[0-9a-z]{58}$ &&
   ${#public_keys[@]} == 1 ]] ||
  { echo 'Supply one native age recipient and one dedicated Ed25519 public key.' >&2; exit 65; }
read -r key_type public_key _ <<< "${public_keys[0]}"
[[ "$key_type" == ssh-ed25519 && "$public_key" =~ ^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$ ]] ||
  { echo 'The SSH key must be a dedicated Ed25519 public key.' >&2; exit 65; }

reader=accountpulse-backup
reader_dir=/var/lib/accountpulse-backup-reader
export_dir=/var/lib/accountpulse/backup-export
config_dir=/etc/accountpulse/backup
bin_dir=/usr/local/libexec/accountpulse
for path in "$reader_dir" "$reader_dir/.ssh" "$export_dir" "$config_dir" "$bin_dir" \
  "$config_dir/age-recipient" /etc/accountpulse/daily-backup.env; do
  [[ ! -L "$path" ]] || { echo 'A backup installation path is a symbolic link.' >&2; exit 65; }
done
findmnt --noheadings --output TARGET --target /var/lib | grep -Fxq / ||
  { echo 'The backup export must be on the OVH system filesystem.' >&2; exit 65; }

# The default key file contains one forced command under a dedicated account.
# Decline unusual SSH configurations before installing the grant.
ssh_config=$(/usr/sbin/sshd -T -C "user=$reader,host=localhost,addr=127.0.0.1")
[[ "$ssh_config" == *$'\nusepam yes\n'* &&
   "$ssh_config" == *$'\nauthorizedkeyscommand none\n'* &&
   "$ssh_config" == *$'\ntrustedusercakeys none\n'* &&
   "$ssh_config" == *$'\nforcecommand none\n'* ]] &&
  grep -Eq '^authorizedkeysfile (%h/)?\.ssh/authorized_keys( (%h/)?\.ssh/authorized_keys2)?$' <<< "$ssh_config" ||
  { echo 'Review the effective SSH configuration before creating the backup reader.' >&2; exit 65; }

getent group "$reader" >/dev/null || groupadd --system "$reader"
if ! id "$reader" >/dev/null 2>&1; then
  useradd --system --gid "$reader" --home-dir "$reader_dir" --no-create-home --shell /bin/sh "$reader"
fi
reader_record=$(getent passwd "$reader")
IFS=: read -r _ _ reader_uid reader_gid _ reader_home reader_shell <<< "$reader_record"
[[ "$reader_uid" != 0 && "$reader_home" == "$reader_dir" && "$reader_shell" == /bin/sh &&
   "$reader_gid" == "$(getent group "$reader" | cut -d: -f3)" &&
   "$(id -G "$reader")" == "$reader_gid" &&
   "$(passwd -S "$reader" | awk '{print $2}')" == L ]] ||
  { echo 'The backup account is not an isolated system reader.' >&2; exit 65; }

install -d -m 0755 -o root -g root "$reader_dir" "$reader_dir/.ssh" "$bin_dir"
install -d -m 0700 -o root -g root "$config_dir"
install -d -m 0750 -o root -g "$reader" "$export_dir"
findmnt --noheadings --output TARGET --target "$export_dir" | grep -Fxq / ||
  { echo 'The backup export must be on the OVH system filesystem.' >&2; exit 65; }

grant='restrict,command="/usr/bin/timeout 120 /usr/local/libexec/accountpulse/owner-recurring-backup serve"'
key_line="$grant ssh-ed25519 $public_key accountpulse-backup-reader"
authorized_keys="$reader_dir/.ssh/authorized_keys"
[[ ! -L "$authorized_keys" && ( ! -e "$authorized_keys" || -f "$authorized_keys" ) &&
   ! -e "${authorized_keys}2" && ! -L "${authorized_keys}2" ]] ||
  { echo 'The backup reader key path is not isolated.' >&2; exit 65; }
if [[ -e "$authorized_keys" ]] &&
   { [[ "$(stat -c '%u:%a' -- "$authorized_keys")" != '0:644' ]] ||
     ! cmp -s -- "$authorized_keys" <(printf '%s\n' "$key_line"); }; then
  echo 'The backup reader key file differs from the expected single grant.' >&2
  exit 65
fi
install -m 0700 -o root -g root "$2" "$bin_dir/age"
install -m 0755 -o root -g root "$source_dir/owner-recurring-backup.py" "$bin_dir/owner-recurring-backup"
printf '%s\n' "${recipients[0]}" > "$config_dir/age-recipient"
printf 'ACCOUNT_PULSE_BACKUP_DEPLOY_ROOT=%s\n' "$deploy_root" > /etc/accountpulse/daily-backup.env
install -m 0644 "$source_dir/accountpulse-daily-backup.service" "$source_dir/accountpulse-daily-backup.timer" /etc/systemd/system/
if [[ ! -e "$authorized_keys" ]]; then
  printf '%s\n' "$key_line" > "$authorized_keys"
  chmod 0644 "$authorized_keys"
fi
systemctl daemon-reload
echo 'AccountPulse daily backup installed. Start the service once for commissioning before enabling its timer.'
