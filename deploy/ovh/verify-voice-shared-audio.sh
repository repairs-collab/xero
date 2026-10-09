#!/bin/sh
set -eu

asterisk_image=${1:?Asterisk image is required}
gateway_image=${2:?Voice gateway image is required}

asterisk_uid=$(docker run --rm --entrypoint id "$asterisk_image" -u asterisk)
gateway_uid=$(docker run --rm --entrypoint id "$gateway_image" -u node)

if [ "$asterisk_uid" != "$gateway_uid" ]; then
  printf 'Shared audio UID mismatch: Asterisk=%s gateway=%s\n' "$asterisk_uid" "$gateway_uid" >&2
  exit 1
fi

audio_root=$(mktemp -d)
cleanup() {
  rm -rf "$audio_root"
}
trap cleanup EXIT INT TERM
chmod 0700 "$audio_root"

docker run --rm \
  -v "$audio_root:/dev/shm/accountpulse-voice" \
  --entrypoint sh \
  "$gateway_image" \
  -c 'mkdir -m 0700 /dev/shm/accountpulse-voice/capability && printf audio > /dev/shm/accountpulse-voice/capability/asterisk-8khz.wav'

docker run --rm \
  -v "$audio_root:/var/lib/asterisk/sounds/accountpulse:ro" \
  --entrypoint sh \
  "$asterisk_image" \
  -c 'test -r /var/lib/asterisk/sounds/accountpulse/capability/asterisk-8khz.wav'

printf 'Shared audio permissions verified for UID %s.\n' "$asterisk_uid"
