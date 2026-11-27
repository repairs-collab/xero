#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
export CASE=healthy
export STARTED_FILE="$fixture/restarted"
export REPAIR_REQUEST='10000000-0000-4000-8000-000000000001'
export SHA=0123456789abcdef0123456789abcdef01234567
export CONTAINER_ID=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export IMAGE_ID="sha256:$CONTAINER_ID"
export ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT="$fixture/deployment"
mkdir -p "$fixture/bin" "$ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT/releases/$SHA"
touch "$ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT/.release.lock"
manifest="ACCOUNT_PULSE_WORKER_IMAGE=accountpulse-worker:$SHA"
printf '%s\n' "$manifest" > "$ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT/current-images.env"
printf '%s\n' "$manifest" > "$ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT/releases/$SHA/images.env"
printf '{\n  "releaseSha": "%s",\n  "hostname": "fixture.example"\n}\n' "$SHA" \
  > "$ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT/releases/$SHA/release-metadata.json"

cat > "$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  exec)
    [[ "$2" == -i && "$3" == bc5000-postgres ]]
    statement=$(cat)
    if [[ "$statement" == *'RETURNING request.id'* ]]; then
      printf '%s\n' "$REPAIR_REQUEST"
    elif [[ "$statement" == *'WORKER_REPAIR_RESTART_ATTEMPTED'* ]]; then
      [[ "$statement" == *"start_after <= now() + interval '2 minutes'"* ]]
      [[ "$statement" == *'reminders.calculate'* ]]
      if [[ "$CASE" == revoked ]]; then
        printf '%s\n' OWNER_REVOKED
      elif [[ "$CASE" == old_calculation ]]; then
        printf '%s\n' SEND_BACKLOG_REVIEW_REQUIRED
      else
        printf '%s\n' CLEAR
      fi
    elif [[ "$statement" == *"RETURNING 'RECORDED'"* ]]; then
      if [[ "$CASE" == post_restart_crash ]]; then
        [[ " $* " == *' status=FAILED '* ]]
      fi
      [[ "$CASE" == expired_completion ]] || printf '%s\n' RECORDED
    else
      exit 77
    fi
    ;;
  image) [[ "$2" == inspect && "${*: -1}" == "accountpulse-worker:$SHA" ]] && printf '%s\n' "$IMAGE_ID" ;;
  container)
    [[ "$2" == inspect && "${*: -1}" == bc5000-worker ]]
    case "$CASE" in
      wrong_container) project=untrusted ;;
      *) project=bc5000 ;;
    esac
    expected_healthcheck='["CMD","node","/app/worker-healthcheck.mjs"]'
    [[ "$CASE" != old_image ]] || expected_healthcheck=none
    command='["node","/app/worker.mjs"]'
    [[ "$CASE" != overridden_command ]] || command='["sh","-c","other-command"]'
    case "$CASE" in
      healthy|expired_completion) health=healthy ;;
      *) health=unhealthy ;;
    esac
    started=2026-11-27T03:00:00Z
    restarting=false
    restarts=0
    if [[ -e "$STARTED_FILE" ]]; then
      started=2026-11-27T03:15:00Z
      health=healthy
      if [[ "$CASE" == post_restart_crash ]]; then
        restarting=true
        restarts=1
      fi
    fi
    printf '%s|%s|accountpulse-worker:%s|%s|worker|true|%s|%s|%s|%s|%s|%s|%s\n' \
      "$CONTAINER_ID" "$IMAGE_ID" "$SHA" "$project" "$restarting" "$restarts" "$started" "$health" "$expected_healthcheck" \
      '["node","/app/container-entrypoint.mjs"]' "$command"
    ;;
  logs)
    [[ "${*: -1}" == bc5000-worker ]]
    [[ "$CASE" != missing_dependency ]] || printf 'Error: Cannot find module stripe\n'
    ;;
  restart)
    [[ "$CASE" == safe_restart || "$CASE" == post_restart_crash ]]
    [[ "${*: -1}" == "$CONTAINER_ID" && ! -e "$STARTED_FILE" ]]
    touch "$STARTED_FILE"
    ;;
  *) exit 77 ;;
esac
MOCK
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH"

test_result() {
  CASE=$1 bash "$SCRIPT_DIR/run-worker-repair.sh" | grep -Fx "WORKER_REPAIR_$2"
  [[ ! -e "$STARTED_FILE" ]]
}

test_result healthy ALREADY_HEALTHY
test_result old_image CORRECTED_RELEASE_REQUIRED
test_result wrong_container CORRECTED_RELEASE_REQUIRED
test_result overridden_command CORRECTED_RELEASE_REQUIRED
test_result missing_dependency CORRECTED_RELEASE_REQUIRED
test_result revoked OWNER_REVOKED
test_result old_calculation SEND_BACKLOG_REVIEW_REQUIRED

if CASE=expired_completion bash "$SCRIPT_DIR/run-worker-repair.sh" > "$fixture/expired" 2>&1; then
  echo 'Missing completion receipt incorrectly returned success.' >&2
  exit 1
fi
grep -Fx WORKER_REPAIR_RESULT_WRITE_FAILED "$fixture/expired"

(
  flock -n 8
  [[ -z $(CASE=safe_restart bash "$SCRIPT_DIR/run-worker-repair.sh") ]]
  [[ ! -e "$STARTED_FILE" ]]
) 8<"$ACCOUNT_PULSE_REPAIR_DEPLOY_ROOT/.release.lock"

CASE=safe_restart bash "$SCRIPT_DIR/run-worker-repair.sh" | grep -Fx WORKER_REPAIR_RESTARTED_HEALTHY
[[ -e "$STARTED_FILE" ]]
rm -- "$STARTED_FILE"
CASE=post_restart_crash bash "$SCRIPT_DIR/run-worker-repair.sh" | grep -Fx WORKER_REPAIR_CORRECTED_RELEASE_REQUIRED
[[ -e "$STARTED_FILE" ]]
