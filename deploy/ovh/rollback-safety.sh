#!/usr/bin/env bash

# The caller holds the release lock. Refuse to start older code unless both
# application services are stopped and ambiguous cancellations are paused.
rollback_safeguard() {
  "$@" stop web worker || return 1
  "$@" exec -T postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -f -' <<'SQL' || return 1
WITH affected AS (
  UPDATE subscriptions SET status = 'INCOMPLETE', updated_at = now()
  WHERE status = 'CANCEL_AT_PERIOD_END'
  RETURNING organisation_id
)
UPDATE organisations
SET send_mode = 'dry-run', rollout_scope = 'CONTROLLED',
    live_send_acknowledged = false, updated_at = now()
WHERE id IN (SELECT organisation_id FROM affected);
SQL
}
