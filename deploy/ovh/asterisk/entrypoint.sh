#!/bin/sh
set -eu

: "${ASTERISK_ARI_USERNAME:?ASTERISK_ARI_USERNAME is required}"
: "${ASTERISK_ARI_PASSWORD:?ASTERISK_ARI_PASSWORD is required}"
: "${VOIPCLOUD_SIP_SERVER:?VOIPCLOUD_SIP_SERVER is required}"
: "${VOIPCLOUD_SIP_DOMAIN:?VOIPCLOUD_SIP_DOMAIN is required}"
: "${VOIPCLOUD_API_USER_NUMBER:?VOIPCLOUD_API_USER_NUMBER is required}"
: "${VOIPCLOUD_SIP_USER_NUMBER:?VOIPCLOUD_SIP_USER_NUMBER is required}"
: "${VOIPCLOUD_SIP_PASSWORD:?VOIPCLOUD_SIP_PASSWORD is required}"
: "${ASTERISK_EXTERNAL_ADDRESS:?ASTERISK_EXTERNAL_ADDRESS is required}"

umask 077
envsubst '$ASTERISK_ARI_USERNAME $ASTERISK_ARI_PASSWORD' \
  < /etc/asterisk/ari.conf.template > /tmp/ari.conf
envsubst '$VOIPCLOUD_SIP_SERVER $VOIPCLOUD_SIP_DOMAIN $VOIPCLOUD_API_USER_NUMBER $VOIPCLOUD_SIP_USER_NUMBER $VOIPCLOUD_SIP_PASSWORD $ASTERISK_EXTERNAL_ADDRESS' \
  < /etc/asterisk/pjsip.conf.template > /tmp/pjsip.conf
install -o asterisk -g asterisk -m 0600 /tmp/ari.conf /etc/asterisk/ari.conf
install -o asterisk -g asterisk -m 0600 /tmp/pjsip.conf /etc/asterisk/pjsip.conf
rm -f /tmp/ari.conf /tmp/pjsip.conf

exec asterisk -f -U asterisk -G asterisk -vvv
