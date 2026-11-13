#!/usr/bin/env bash

# The caller holds the release lock. Refuse to start older code unless both
# application services are stopped and ambiguous cancellations are paused.
rollback_safeguard() {
  "$@" stop web worker || return 1
  "$@" exec -T postgres sh -c 'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -f -' <<'SQL' || return 1
DO $rollback_compatibility$
DECLARE
  has_forward_reconciliation boolean;
  has_unresolved_legacy boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('public.direct_debit_requests')
      AND attname = 'provider_reconciled_at'
      AND NOT attisdropped
  ) INTO has_forward_reconciliation;

  IF has_forward_reconciliation THEN
    EXECUTE $query$
      SELECT EXISTS (
        SELECT 1
        FROM public.direct_debit_requests
        WHERE status = 'LEGACY_UNBOUND'
          AND provider_reconciled_at IS NULL
      )
    $query$ INTO has_unresolved_legacy;

    IF has_unresolved_legacy THEN
      RAISE EXCEPTION 'Rollback blocked: unresolved legacy direct-debit provider reconciliation exists.'
        USING ERRCODE = 'P0001',
              HINT = 'Keep web and worker stopped. Resolve every provider record in the current release before selecting an older image.';
    END IF;
  END IF;
END
$rollback_compatibility$;

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
