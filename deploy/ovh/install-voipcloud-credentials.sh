#!/bin/sh
set -eu

umask 077

config_dir=${1:-/opt/bc5000/config}
config_file="$config_dir/bc5000-config.json"
secrets_file="$config_dir/bc5000-secrets.json"

test -f "$config_file"
test -f "$secrets_file"

payload_file=$(mktemp "$config_dir/.voipcloud-payload.XXXXXX")
config_tmp=$(mktemp "$config_dir/.bc5000-config.XXXXXX")
secrets_tmp=$(mktemp "$config_dir/.bc5000-secrets.XXXXXX")

cleanup() {
  rm -f "$payload_file" "$config_tmp" "$secrets_tmp"
}
trap cleanup EXIT HUP INT TERM

cat >"$payload_file"

jq -e '
  type == "object" and
  (.VOIPCLOUD_API_KEY | type == "string" and length > 0) and
  (.VOIPCLOUD_API_USER_NUMBER | type == "string" and test("^[0-9]+$")) and
  (.VOIPCLOUD_SIP_USER_NUMBER | type == "string" and length > 0) and
  (.VOIPCLOUD_SIP_PASSWORD | type == "string" and length > 0) and
  (.VOIPCLOUD_SIP_SERVER | type == "string" and length > 0)
' "$payload_file" >/dev/null

jq -s '
  .[0] + {
    VOIPCLOUD_API_USER_NUMBER: .[1].VOIPCLOUD_API_USER_NUMBER,
    VOIPCLOUD_SIP_USER_NUMBER: .[1].VOIPCLOUD_SIP_USER_NUMBER,
    VOIPCLOUD_SIP_SERVER: .[1].VOIPCLOUD_SIP_SERVER
  }
' "$config_file" "$payload_file" >"$config_tmp"

jq -s '
  .[0] + {
    VOIPCLOUD_API_KEY: .[1].VOIPCLOUD_API_KEY,
    VOIPCLOUD_SIP_PASSWORD: .[1].VOIPCLOUD_SIP_PASSWORD
  }
' "$secrets_file" "$payload_file" >"$secrets_tmp"

chmod --reference="$config_file" "$config_tmp"
chown --reference="$config_file" "$config_tmp"
chmod --reference="$secrets_file" "$secrets_tmp"
chown --reference="$secrets_file" "$secrets_tmp"

mv -f "$config_tmp" "$config_file"
mv -f "$secrets_tmp" "$secrets_file"

trap - EXIT HUP INT TERM
rm -f "$payload_file"

printf 'VoIPcloud credentials installed in protected configuration.\n'
