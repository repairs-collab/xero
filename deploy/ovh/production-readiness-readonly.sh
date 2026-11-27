#!/usr/bin/env bash
set -Eeuo pipefail

config=/etc/accountpulse/server-health-mail.curl
if ! metadata=$(stat --format='%u:%a' -- "$config" 2>/dev/null); then
  printf '%s\n' 'mail_config=missing_or_inaccessible'
elif [[ ! -f "$config" || -L "$config" || "$metadata" != 0:600 ]]; then
  printf '%s\n' 'mail_config=insecure'
else
  printf '%s\n' 'mail_config=root_owned_mode_0600'
fi

if timeout 5s bash -c 'exec 3<>/dev/tcp/ventraip.email/465' >/dev/null 2>&1; then
  printf '%s\n' 'ventraip_smtps_465=reachable'
  if timeout 8s openssl s_client -connect ventraip.email:465 -servername ventraip.email \
    -verify_hostname ventraip.email -verify_return_error -brief </dev/null >/dev/null 2>&1; then
    printf '%s\n' 'ventraip_certificate=verified'
  else
    printf '%s\n' 'ventraip_certificate=unverified'
  fi
else
  printf '%s\n' 'ventraip_smtps_465=unreachable' 'ventraip_certificate=not_checked'
fi

if ! counts=$(timeout 8s docker exec -i bc5000-postgres sh -c '
  exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
' 2>/dev/null <<'SQL'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '4s';
SET LOCAL lock_timeout = '1s';
SELECT concat_ws(' ',
  count(*),
  count(*) FILTER (WHERE send_mode = 'dry-run'),
  count(*) FILTER (WHERE send_mode = 'live' AND rollout_scope = 'CONTROLLED'),
  count(*) FILTER (WHERE send_mode = 'live' AND rollout_scope = 'CUSTOMER'),
  count(*) FILTER (WHERE sinch_shared_account_id IS NOT NULL)
)
FROM public.organisations
WHERE edition = 'SOLO';
COMMIT;
SQL
) || [[ ! "$counts" =~ ^[0-9]+([[:blank:]][0-9]+){4}$ ]]; then
  printf '%s\n' 'solo_workspace_counts=unavailable'
  exit 1
fi

read -r total dry_run controlled_live customer_live shared_linked <<< "$counts"
printf 'solo_total=%s\nsolo_dry_run=%s\nsolo_controlled_live=%s\nsolo_customer_live=%s\nsolo_shared_linked=%s\n' \
  "$total" "$dry_run" "$controlled_live" "$customer_live" "$shared_linked"
