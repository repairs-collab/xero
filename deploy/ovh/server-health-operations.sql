-- Run in quiet, unaligned mode so the collector receives only the two counts.
BEGIN TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '4s';

WITH monitored_workspaces AS MATERIALIZED (
  SELECT id, edition, last_successful_sync_at, last_successful_xero_connection_id
  FROM public.organisations
  WHERE platform_status = 'ACTIVE'
    AND send_mode = 'live'
    AND rollout_scope = 'CUSTOMER'
    AND live_send_acknowledged
    AND operational_state IN ('READY', 'RECONCILED')
    AND NOT maintenance_mode
    AND created_at <= now() - interval '25 minutes'
),
recent_calculations AS (
  -- The recurring schedule uses this fixed singleton key. Manual runs use
  -- distinct keys and cannot hide an outage of the scheduler.
  SELECT DISTINCT singleton_key
  FROM pgboss.job
  WHERE name = 'reminders.calculate'
    AND state = 'completed'
    AND created_on >= now() - interval '25 minutes'
    AND completed_on >= now() - interval '25 minutes'
),
xero_connections_to_monitor AS (
  SELECT workspace.id,
    CASE
      WHEN oauth.status = 'CONNECTED'
        AND oauth.connected_at <= now() - interval '90 minutes'
        THEN workspace.last_successful_xero_connection_id IS DISTINCT FROM oauth.id
          OR workspace.last_successful_sync_at IS NULL
          OR workspace.last_successful_sync_at < now() - interval '90 minutes'
      WHEN (oauth.status IS NULL OR oauth.status = 'DISCONNECTED')
        AND workspace.edition = 'INTERNAL_LEGACY'
        AND legacy.enabled
        AND COALESCE(legacy.connected_at, legacy.updated_at)
          <= now() - interval '90 minutes'
        THEN workspace.last_successful_xero_connection_id IS NOT NULL
          OR workspace.last_successful_sync_at IS NULL
          OR workspace.last_successful_sync_at < now() - interval '90 minutes'
      ELSE false
    END AS stale
  FROM monitored_workspaces AS workspace
  LEFT JOIN public.xero_connections AS oauth ON oauth.organisation_id = workspace.id
  LEFT JOIN public.provider_connections AS legacy
    ON legacy.organisation_id = workspace.id AND legacy.provider = 'XERO'
)
SELECT count(*) FILTER (WHERE calculation.singleton_key IS NULL)
    || ' ' || count(*) FILTER (WHERE xero.stale)
FROM xero_connections_to_monitor AS xero
LEFT JOIN recent_calculations AS calculation
  ON calculation.singleton_key = 'reminders.calculate:' || xero.id::text;

COMMIT;
