#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DEPLOY_ROOT=${ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT:-/opt/bc5000}
WORKER=bc5000-worker
HEALTHCHECK='["CMD","node","/app/worker-healthcheck.mjs"]'
INSPECT_FORMAT='{{.Id}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}|{{.State.Restarting}}|{{.RestartCount}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Test}}{{else}}none{{end}}'

# The existing local file is also held by the protected release and rollback.
exec 9<"$DEPLOY_ROOT/.release.lock"
flock -n 9 || exit 0

database() {
  timeout 8s docker exec -i bc5000-postgres sh -c '
    export PGOPTIONS="-c statement_timeout=4000 -c lock_timeout=1000"
    exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
  ' repair-sql "$@" 2>/dev/null
}

claim_request() {
  database <<'SQL'
BEGIN;
DO $$ BEGIN PERFORM pg_advisory_xact_lock(9041780001); END $$;
INSERT INTO public.worker_repair_runner (id, last_seen_at) VALUES (1, now())
  ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at;
WITH expired AS (
  UPDATE public.worker_repair_requests
  SET status = 'EXPIRED', completed_at = now(), result_code =
    CASE WHEN status = 'PENDING' THEN 'EXPIRED_BEFORE_START' ELSE 'EXPIRED_AFTER_CLAIM' END
  WHERE (status = 'PENDING' AND expires_at <= now())
    OR (status = 'RUNNING' AND claim_expires_at <= now())
  RETURNING id, requested_by_user_id, result_code
)
INSERT INTO public.platform_admin_audit_events
  (actor_user_id, event_type, entity_type, entity_id, reason, after_value)
SELECT requested_by_user_id, 'WORKER_REPAIR_FINISHED', 'WORKER_REPAIR', id::text,
  'Protected worker repair request expired', jsonb_build_object('resultCode', result_code)
FROM expired;
WITH revoked AS (
  UPDATE public.worker_repair_requests AS request
  SET status = 'SKIPPED', result_code = 'OWNER_REVOKED', completed_at = now()
  WHERE request.status = 'PENDING' AND NOT EXISTS (
    SELECT FROM public.users AS owner WHERE owner.id = request.requested_by_user_id
      AND owner.platform_role = 'OWNER' AND owner.disabled_at IS NULL
  )
  RETURNING id, requested_by_user_id
)
INSERT INTO public.platform_admin_audit_events
  (actor_user_id, event_type, entity_type, entity_id, reason, after_value)
SELECT requested_by_user_id, 'WORKER_REPAIR_FINISHED', 'WORKER_REPAIR', id::text,
  'Repair request owner no longer has access', jsonb_build_object('resultCode', 'OWNER_REVOKED')
FROM revoked;
UPDATE public.worker_repair_requests AS request
SET status = 'RUNNING', claimed_at = now(), claim_expires_at = now() + interval '2 minutes'
FROM public.users AS owner
WHERE request.status = 'PENDING' AND request.expires_at > now()
  AND owner.id = request.requested_by_user_id AND owner.platform_role = 'OWNER'
  AND owner.disabled_at IS NULL
RETURNING request.id;
COMMIT;
SQL
}

preflight() {
  database -v "request_id=$request_id" <<'SQL'
BEGIN;
WITH safety AS MATERIALIZED (SELECT CASE
  WHEN NOT EXISTS (
    SELECT FROM public.worker_repair_requests AS request
    JOIN public.users AS owner ON owner.id = request.requested_by_user_id
    WHERE request.id = :'request_id' AND request.status = 'RUNNING'
      AND request.claim_expires_at > now()
      AND owner.platform_role = 'OWNER' AND owner.disabled_at IS NULL
  ) THEN 'OWNER_REVOKED'
  WHEN EXISTS (
    SELECT FROM pgboss.job
    WHERE name IN ('reminder.execute', 'operator-reply.execute', 'test-sms.execute', 'voice-call.execute')
      AND (state = 'active'
        OR (state IN ('created', 'retry') AND start_after <= now() + interval '2 minutes'))
  ) OR EXISTS (
    SELECT FROM pgboss.job
    WHERE name IN ('reminders.calculate', 'voice-reminders.calculate', 'voice-reminders.dispatch')
      AND (state = 'active' OR (state IN ('created', 'retry')
        AND start_after <= now() + interval '2 minutes'
        AND (created_on < now() - interval '15 minutes' OR start_after < now() - interval '15 minutes')))
  ) OR EXISTS (
    SELECT FROM public.stage_instances AS stage
    JOIN public.organisations AS org ON org.id = stage.organisation_id
    JOIN public.invoice_chases AS chase ON chase.id = stage.invoice_chase_id
      AND chase.organisation_id = stage.organisation_id
    JOIN public.reminder_sequences AS sequence ON sequence.id = chase.sequence_id
      AND sequence.organisation_id = stage.organisation_id
    JOIN public.reminder_sequence_versions AS version ON version.id = stage.sequence_version_id
      AND version.sequence_id = sequence.id AND version.organisation_id = stage.organisation_id
    WHERE sequence.enabled AND sequence.mode = 'AUTOMATIC' AND version.status = 'ACTIVE'
      AND org.platform_status = 'ACTIVE' AND NOT org.maintenance_mode
      AND stage.channel IN ('SMS', 'XERO_EMAIL') AND stage.status IN ('SCHEDULED', 'QUEUED')
      AND stage.scheduled_at < now() - interval '15 minutes'
  ) OR EXISTS (
    SELECT FROM public.voice_call_requests AS voice
    JOIN public.organisations AS org ON org.id = voice.organisation_id
    WHERE voice.purpose = 'CUSTOMER' AND voice.source <> 'MANUAL'
      AND org.platform_status = 'ACTIVE' AND NOT org.maintenance_mode
      AND (voice.state = 'QUEUED' OR
        (voice.state = 'APPROVED' AND voice.scheduled_at < now() - interval '15 minutes'))
  ) THEN 'SEND_BACKLOG_REVIEW_REQUIRED'
  ELSE 'CLEAR'
END AS result),
recorded AS (
  INSERT INTO public.platform_admin_audit_events
    (actor_user_id, event_type, entity_type, entity_id, reason, before_value)
  SELECT request.requested_by_user_id, 'WORKER_REPAIR_RESTART_ATTEMPTED', 'WORKER_REPAIR',
    request.id::text, 'Protected runner began one verified worker restart',
    jsonb_build_object('health', 'UNHEALTHY')
  FROM public.worker_repair_requests AS request, safety
  WHERE request.id = :'request_id' AND safety.result = 'CLEAR'
  RETURNING id
)
SELECT CASE WHEN result = 'CLEAR' AND (SELECT count(*) FROM recorded) <> 1
  THEN 'SERVICE_UNAVAILABLE' ELSE result END
FROM safety;
COMMIT;
SQL
}

finish() {
  local status=$1 code=$2 receipt
  if ! receipt=$(database -v "request_id=$request_id" -v "status=$status" -v "result_code=$code" \
    -v "before=$before" -v "after=$health" <<'SQL'
WITH finished AS (
  UPDATE public.worker_repair_requests
  SET status = :'status', result_code = :'result_code', before_health = :'before',
      after_health = :'after', completed_at = now()
  WHERE id = :'request_id' AND status = 'RUNNING' AND claim_expires_at > now()
  RETURNING id, requested_by_user_id, before_health, after_health, result_code
)
INSERT INTO public.platform_admin_audit_events
  (actor_user_id, event_type, entity_type, entity_id, reason, before_value, after_value)
SELECT requested_by_user_id, 'WORKER_REPAIR_FINISHED', 'WORKER_REPAIR', id::text,
  'Protected worker repair completed', jsonb_build_object('health', before_health),
  jsonb_build_object('health', after_health, 'resultCode', result_code)
FROM finished
RETURNING 'RECORDED';
SQL
  ) || [[ "$receipt" != RECORDED ]]
  then
    printf '%s\n' 'WORKER_REPAIR_RESULT_WRITE_FAILED' >&2
    exit 1
  fi
  printf 'WORKER_REPAIR_%s\n' "$code"
  exit 0
}

inspect_worker() {
  local details test compose_project compose_service state restarting
  health=UNVERIFIED
  details=$(timeout 5s docker container inspect --format "$INSPECT_FORMAT" "$WORKER" 2>/dev/null) || {
    health=DOWN
    return 1
  }
  [[ "$details" != *$'\n'* ]] || return 1
  IFS='|' read -r worker_id image_id image compose_project compose_service state restarting restarts started_at health_status test <<< "$details"
  [[ "$worker_id" =~ ^[0-9a-f]{64}$ &&
     "$image_id" =~ ^sha256:[0-9a-f]{64}$ &&
     "$image" == "$expected_tag" && "$compose_project" == bc5000 &&
     "$compose_service" == worker && "$test" == "$HEALTHCHECK" &&
     "$image_id" == "$expected_image_id" && "$restarts" =~ ^[0-9]+$ ]] || return 1
  if [[ "$state" != true || "$restarting" != false ]]; then
    health=DOWN
    return 1
  fi
  case "$health_status" in
    healthy) health=HEALTHY ;;
    starting) health=STARTING ;;
    unhealthy) health=UNHEALTHY ;;
    *) return 1 ;;
  esac
}

if ! request_id=$(claim_request); then
  printf '%s\n' 'WORKER_REPAIR_QUEUE_UNAVAILABLE' >&2
  exit 1
fi
[[ -n "$request_id" ]] || exit 0
if [[ ! "$request_id" =~ ^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$ ]]; then
  printf '%s\n' 'WORKER_REPAIR_INVALID_CLAIM' >&2
  exit 1
fi

health=UNVERIFIED
before=UNVERIFIED
manifest=$(grep '^ACCOUNT_PULSE_WORKER_IMAGE=' "$DEPLOY_ROOT/current-images.env") ||
  finish SKIPPED CORRECTED_RELEASE_REQUIRED
[[ "$manifest" =~ ^ACCOUNT_PULSE_WORKER_IMAGE=accountpulse-worker:([0-9a-f]{40})$ ]] ||
  finish SKIPPED CORRECTED_RELEASE_REQUIRED
sha=${BASH_REMATCH[1]}
expected_tag="accountpulse-worker:$sha"
grep -Fxq "  \"releaseSha\": \"$sha\"," "$DEPLOY_ROOT/releases/$sha/release-metadata.json" &&
  grep -Fxq "$manifest" "$DEPLOY_ROOT/releases/$sha/images.env" ||
  finish SKIPPED CORRECTED_RELEASE_REQUIRED
expected_image_id=$(timeout 5s docker image inspect --format '{{.Id}}' "$expected_tag" 2>/dev/null) ||
  finish SKIPPED CORRECTED_RELEASE_REQUIRED
if ! inspect_worker; then
  before=$health
  finish SKIPPED CORRECTED_RELEASE_REQUIRED
fi
before=$health
[[ "$health" != HEALTHY ]] || finish SKIPPED ALREADY_HEALTHY
[[ "$restarts" == 0 ]] || finish SKIPPED CORRECTED_RELEASE_REQUIRED
[[ "$health" != STARTING ]] || finish SKIPPED STARTUP_IN_PROGRESS
[[ "$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$ ]] ||
  finish SKIPPED CORRECTED_RELEASE_REQUIRED
boot_logs=$(timeout 5s docker logs --since "$started_at" --tail 60 "$WORKER" 2>&1) ||
  finish FAILED SERVICE_UNAVAILABLE
if [[ "$boot_logs" =~ Cannot[[:space:]]find[[:space:]](module|package)|ERR_MODULE_NOT_FOUND|SyntaxError:.*has[[:space:]]already[[:space:]]been[[:space:]]declared ]]; then
  finish SKIPPED CORRECTED_RELEASE_REQUIRED
fi
unset boot_logs

if ! safety=$(preflight); then
  finish FAILED SERVICE_UNAVAILABLE
fi
case "$safety" in
  CLEAR) ;;
  OWNER_REVOKED|SEND_BACKLOG_REVIEW_REQUIRED) finish SKIPPED "$safety" ;;
  *) finish FAILED SERVICE_UNAVAILABLE ;;
esac

previous_worker_id=$worker_id
previous_worker_start=$started_at
if ! timeout 25s docker restart --timeout 18 "$previous_worker_id" >/dev/null 2>&1; then
  inspect_worker || true
  finish FAILED RESTART_FAILED
fi

deadline=$((SECONDS + 45))
while (( SECONDS < deadline )); do
  if inspect_worker; then
    if [[ "$worker_id" != "$previous_worker_id" || "$restarts" != 0 ]]; then
      finish SKIPPED CORRECTED_RELEASE_REQUIRED
    fi
    if [[ "$health" == HEALTHY && "$started_at" != "$previous_worker_start" ]]; then
      finish SUCCEEDED RESTARTED_HEALTHY
    fi
  fi
  sleep 2
done
finish FAILED HEALTH_TIMEOUT
