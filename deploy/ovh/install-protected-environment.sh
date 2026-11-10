#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
COMMERCIAL_ENV=${1:-$DEPLOY_ROOT/.protected-commercial.env}
EXPECTED_COMMERCIAL_ENV="$DEPLOY_ROOT/.protected-commercial.env"
PROTECTED_ENV="$DEPLOY_ROOT/accountpulse.env"
CURRENT_MANIFEST="$DEPLOY_ROOT/current-images.env"

if [[ "$COMMERCIAL_ENV" != "$EXPECTED_COMMERCIAL_ENV" ]]; then
  echo "The credential overlay must use the protected deployment path." >&2
  exit 64
fi

for command in docker grep install mktemp openssl sort tr; do
  command -v "$command" >/dev/null || {
    echo "Required command is unavailable: $command" >&2
    exit 69
  }
done
[[ -f "$COMMERCIAL_ENV" ]] || {
  echo "Missing protected commercial credential overlay." >&2
  exit 66
}

umask 077
declare -A configuration=()
declare -A wanted=()
temporary_files=()

cleanup() {
  rm -f "${temporary_files[@]}" "$COMMERCIAL_ENV"
}
trap cleanup EXIT

for name in \
  ACCOUNT_PULSE_ASTERISK_IMAGE \
  ACCOUNT_PULSE_LEGAL_ENTITY \
  ACCOUNT_PULSE_SUPPORT_EMAIL \
  ACCOUNT_PULSE_VOICE_GATEWAY_IMAGE \
  ASTERISK_ARI_PASSWORD \
  ASTERISK_ARI_USERNAME \
  ASTERISK_EXTERNAL_ADDRESS \
  AWS_REGION \
  COGNITO_CLIENT_ID \
  COGNITO_DOMAIN \
  COGNITO_ISSUER \
  COGNITO_REDIRECT_URI \
  COGNITO_USER_POOL_ID \
  DATABASE_HOST \
  DATABASE_NAME \
  DATABASE_PASSWORD \
  DATABASE_PORT \
  DATABASE_URL \
  DATABASE_USER \
  LIVE_SEND_ACK \
  NODE_ENV \
  PUBLIC_BASE_URL \
  RETELL_SIGNATURE_FAILURE_ALARM_COUNT \
  RETELL_WEBHOOK_LAG_ALARM_SECONDS \
  SEND_MODE \
  SESSION_SECRET_BASE64 \
  SINCH_API_CREDENTIALS \
  SINCH_CALLBACK_PUBLIC_KEYS_JSON \
  SINCH_WEBHOOK_TOKEN \
  SMS_NUMBER_QUARANTINE_DAYS \
  VOICE_GATEWAY_ACCEPT_CALLS \
  VOICE_GATEWAY_SIGNING_SECRET \
  VOICE_GATEWAY_URL \
  VOICE_OFFICE_NUMBER_E164 \
  VOICE_OFFICE_QUEUE_EXTENSION \
  VOICE_QUEUE_AGE_ALARM_SECONDS \
  VOICE_RTP_BIND_IP \
  VOICE_SIP_BIND_IP \
  VOIPCLOUD_API_KEY \
  VOIPCLOUD_API_USER_NUMBER \
  VOIPCLOUD_SIP_DOMAIN \
  VOIPCLOUD_SIP_PASSWORD \
  VOIPCLOUD_SIP_SERVER \
  VOIPCLOUD_SIP_USER_NUMBER \
  WEBHOOK_ORGANISATION_ID \
  XERO_API_CREDENTIALS \
  XERO_OAUTH_CLIENT_ID \
  XERO_OAUTH_CLIENT_SECRET \
  XERO_OAUTH_REDIRECT_URI \
  XERO_TOKEN_ACTIVE_KEY_ID \
  XERO_TOKEN_ENCRYPTION_KEYS_JSON \
  XERO_WEBHOOK_KEY \
  STRIPE_PORTAL_CONFIGURATION_ID \
  STRIPE_SECRET_KEY \
  STRIPE_SOLO_PRICE_ID \
  STRIPE_WEBHOOK_SECRET; do
  wanted["$name"]=true
done

capture_container_environment() {
  local container=$1
  local snapshot
  snapshot=$(mktemp "$DEPLOY_ROOT/.${container}.environment.XXXXXX")
  temporary_files+=("$snapshot")
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" > "$snapshot"
  while IFS= read -r line; do
    [[ "$line" == *=* ]] || continue
    local name=${line%%=*}
    local value=${line#*=}
    [[ ${wanted[$name]+present} ]] || continue
    configuration["$name"]=$value
  done < "$snapshot"
  rm -f "$snapshot"
}

# Read the live containers instead of a template so customer-live, Sinch,
# Cognito, database, voice and operational settings are preserved exactly.
capture_container_environment bc5000-postgres
capture_container_environment bc5000-worker
capture_container_environment bc5000-web

# A failed release can leave the protected file newer than the still-running
# containers. Preserve generated Xero keys from that file so retries never
# invalidate refresh tokens or change webhook authentication unexpectedly.
if [[ -f "$PROTECTED_ENV" ]]; then
  for name in XERO_TOKEN_ENCRYPTION_KEYS_JSON XERO_WEBHOOK_KEY; do
    line=$(grep -m 1 "^${name}='" "$PROTECTED_ENV" || true)
    [[ -n "$line" && "$line" == *"'" ]] || continue
    value=${line#*=}
    value=${value#\'}
    value=${value%\'}
    value=${value//\\\'/\'}
    configuration["$name"]=$value
  done
fi

declare -A commercial_names=(
  [ACCOUNT_PULSE_LEGAL_ENTITY]=true
  [ACCOUNT_PULSE_SUPPORT_EMAIL]=true
  [SMS_NUMBER_QUARANTINE_DAYS]=true
  [XERO_OAUTH_CLIENT_ID]=true
  [XERO_OAUTH_CLIENT_SECRET]=true
  [STRIPE_SECRET_KEY]=true
  [STRIPE_WEBHOOK_SECRET]=true
  [STRIPE_SOLO_PRICE_ID]=true
  [STRIPE_PORTAL_CONFIGURATION_ID]=true
)
declare -A commercial_seen=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  [[ "$line" == *=* ]] || {
    echo "The protected commercial credential overlay is invalid." >&2
    exit 65
  }
  name=${line%%=*}
  value=${line#*=}
  [[ ${commercial_names[$name]+present} ]] || {
    echo "Unexpected protected credential name: $name" >&2
    exit 65
  }
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    echo "Protected credential $name is empty or invalid." >&2
    exit 65
  }
  configuration["$name"]=$value
  commercial_seen["$name"]=true
done < "$COMMERCIAL_ENV"

for name in "${!commercial_names[@]}"; do
  [[ ${commercial_seen[$name]+present} ]] || {
    echo "Protected credential $name is missing." >&2
    exit 65
  }
done

configuration[PUBLIC_BASE_URL]='https://ap.motts.com.au'
configuration[COGNITO_REDIRECT_URI]='https://ap.motts.com.au/auth/callback'
configuration[XERO_OAUTH_REDIRECT_URI]='https://ap.motts.com.au/xero/callback'
configuration[XERO_TOKEN_ACTIVE_KEY_ID]='primary'

if [[ -z ${configuration[XERO_TOKEN_ENCRYPTION_KEYS_JSON]:-} ]]; then
  token_key=$(openssl rand -base64 32 | tr -d '\r\n')
  configuration[XERO_TOKEN_ENCRYPTION_KEYS_JSON]="{\"primary\":\"$token_key\"}"
fi
if [[ -z ${configuration[XERO_WEBHOOK_KEY]:-} ]]; then
  configuration[XERO_WEBHOOK_KEY]=$(openssl rand -base64 32 | tr -d '\r\n')
fi

required=(
  ACCOUNT_PULSE_LEGAL_ENTITY ACCOUNT_PULSE_SUPPORT_EMAIL AWS_REGION
  COGNITO_CLIENT_ID COGNITO_DOMAIN COGNITO_ISSUER COGNITO_REDIRECT_URI
  COGNITO_USER_POOL_ID DATABASE_NAME DATABASE_PASSWORD DATABASE_URL
  DATABASE_USER NODE_ENV PUBLIC_BASE_URL SEND_MODE SESSION_SECRET_BASE64
  SINCH_API_CREDENTIALS SINCH_CALLBACK_PUBLIC_KEYS_JSON SINCH_WEBHOOK_TOKEN
  SMS_NUMBER_QUARANTINE_DAYS VOICE_GATEWAY_SIGNING_SECRET
  XERO_OAUTH_CLIENT_ID XERO_OAUTH_CLIENT_SECRET XERO_OAUTH_REDIRECT_URI
  XERO_TOKEN_ACTIVE_KEY_ID XERO_TOKEN_ENCRYPTION_KEYS_JSON XERO_WEBHOOK_KEY
  STRIPE_PORTAL_CONFIGURATION_ID STRIPE_SECRET_KEY STRIPE_SOLO_PRICE_ID
  STRIPE_WEBHOOK_SECRET
)
for name in "${required[@]}"; do
  [[ -n ${configuration[$name]:-} ]] || {
    echo "The live environment is missing required setting $name; refusing to alter production." >&2
    exit 65
  }
done

write_environment_entry() {
  local name=$1
  local value=${configuration[$name]}
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    echo "Setting $name contains an unsupported line break." >&2
    exit 65
  }
  value=${value//\'/\\\'}
  printf "%s='%s'\n" "$name" "$value"
}

candidate=$(mktemp "$DEPLOY_ROOT/.accountpulse.env.XXXXXX")
temporary_files+=("$candidate")

while IFS= read -r name; do
  write_environment_entry "$name" >> "$candidate"
done < <(printf '%s\n' "${!configuration[@]}" | sort)

install -m 0600 "$candidate" "$PROTECTED_ENV"

if [[ ! -f "$CURRENT_MANIFEST" ]]; then
  web_image=$(docker inspect --format '{{.Config.Image}}' bc5000-web)
  worker_image=$(docker inspect --format '{{.Config.Image}}' bc5000-worker)
  [[ -n "$web_image" && -n "$worker_image" ]] || {
    echo "Could not identify the currently running images." >&2
    exit 65
  }
  manifest_candidate=$(mktemp "$DEPLOY_ROOT/.current-images.env.XXXXXX")
  temporary_files+=("$manifest_candidate")
  printf 'ACCOUNT_PULSE_WEB_IMAGE=%s\n' "$web_image" > "$manifest_candidate"
  printf 'ACCOUNT_PULSE_WORKER_IMAGE=%s\n' "$worker_image" >> "$manifest_candidate"
  install -m 0600 "$manifest_candidate" "$CURRENT_MANIFEST"
  rm -f "$manifest_candidate"
fi

echo "Protected AccountPulse production environment is installed; live sending settings were preserved."
