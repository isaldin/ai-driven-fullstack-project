#!/usr/bin/env bash
# Local CI verification harness: run .github/workflows/ci.yml on a self-hosted
# Gitea + act_runner (GitHub-Actions-compatible). Reusable — Gitea data and the
# runner registration persist in named volumes, so only the first `up` does setup.
#
#   ci-local.sh up      # start Gitea + runner, create repo, register runner (idempotent)
#   ci-local.sh run     # push a snapshot of the working tree -> triggers the workflow, waits
#   ci-local.sh status  # last run's per-job results
#   ci-local.sh logs    # full runner logs
#   ci-local.sh down    # stop containers (keeps volumes -> fast next time)
#   ci-local.sh reset   # stop + wipe volumes and cached token (full clean slate)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
COMPOSE=(docker compose -f "$DIR/docker-compose.yml")

WEB="http://localhost:3010"
OWNER="ci"
PASS="ci-local-password"
REPO="template"
TOKEN_FILE="$DIR/.token"

log() { printf '\033[36m[ci-local]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[ci-local] %s\033[0m\n' "$*" >&2; exit 1; }

wait_gitea() {
  log "waiting for Gitea..."
  for _ in $(seq 1 60); do
    if curl -fsS "$WEB/api/healthz" >/dev/null 2>&1; then log "Gitea is up"; return 0; fi
    sleep 2
  done
  die "Gitea did not become healthy in time"
}

ensure_admin() {
  # `user create` is a no-op error if the admin already exists — swallow it.
  "${COMPOSE[@]}" exec -T -u git gitea gitea admin user create \
    --admin --username "$OWNER" --password "$PASS" --email "ci@local" \
    --must-change-password=false >/dev/null 2>&1 || true
}

get_token() {
  if [ -f "$TOKEN_FILE" ]; then cat "$TOKEN_FILE"; return; fi
  local tok
  tok="$("${COMPOSE[@]}" exec -T -u git gitea gitea admin user generate-access-token \
    --username "$OWNER" --scopes all --raw 2>/dev/null | tr -d '\r\n')"
  [ -n "$tok" ] || die "failed to mint a Gitea access token"
  printf '%s' "$tok" > "$TOKEN_FILE"
  printf '%s' "$tok"
}

api() { # api METHOD PATH [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" -H "Authorization: token $TOKEN" \
      -H 'Content-Type: application/json' "$WEB/api/v1$path" -d "$body"
  else
    curl -fsS -X "$method" -H "Authorization: token $TOKEN" "$WEB/api/v1$path"
  fi
}

ensure_repo() {
  if api GET "/repos/$OWNER/$REPO" >/dev/null 2>&1; then return; fi
  log "creating repo $OWNER/$REPO"
  api POST "/user/repos" "{\"name\":\"$REPO\",\"private\":false,\"auto_init\":false}" >/dev/null
}

set_var() { # set_var NAME VALUE  (container-runner requirements for the workflow)
  local name="$1" val="$2"
  api POST "/repos/$OWNER/$REPO/actions/variables/$name" "{\"value\":\"$val\"}" >/dev/null 2>&1 \
    || api PUT "/repos/$OWNER/$REPO/actions/variables/$name" "{\"value\":\"$val\"}" >/dev/null 2>&1 \
    || log "warn: could not set variable $name (continuing)"
}

ensure_runner() {
  if "${COMPOSE[@]}" exec -T runner test -f /data/.runner >/dev/null 2>&1; then
    log "runner already registered"
    "${COMPOSE[@]}" up -d runner >/dev/null
    return
  fi
  log "registering runner"
  local rtok
  rtok="$("${COMPOSE[@]}" exec -T -u git gitea gitea actions generate-runner-token 2>/dev/null | tr -d '\r\n')"
  [ -n "$rtok" ] || die "failed to generate a runner registration token"
  GITEA_RUNNER_REGISTRATION_TOKEN="$rtok" "${COMPOSE[@]}" up -d runner >/dev/null
  for _ in $(seq 1 30); do
    "${COMPOSE[@]}" exec -T runner test -f /data/.runner >/dev/null 2>&1 && { log "runner registered"; return; }
    sleep 2
  done
  die "runner did not register in time"
}

cmd_up() {
  "${COMPOSE[@]}" up -d gitea
  wait_gitea
  ensure_admin
  TOKEN="$(get_token)"
  ensure_repo
  # The workflow runs on a container-based runner, so: Postgres services are reached
  # by name (not localhost), and Chromium must drop its sandbox (jobs run as root).
  set_var E2E_DB_HOST postgres
  set_var PW_CHROMIUM_NO_SANDBOX 1
  ensure_runner
  log "ready — trigger a run with: $0 run"
}

snapshot_and_push() {
  TOKEN="$(get_token)"
  log "snapshotting working tree (tracked + untracked, respecting .gitignore)"
  local tmp_dir snap tree idx
  # Build the snapshot in a throwaway index so the real staging area is untouched.
  # The index path must NOT pre-exist (an empty file is an invalid index), so use a
  # fresh dir and a not-yet-created path inside it.
  tmp_dir="$(mktemp -d -t ci-local.XXXXXX)"
  idx="$tmp_dir/index"
  ( cd "$REPO_ROOT" && GIT_INDEX_FILE="$idx" git add -A && \
    tree="$(GIT_INDEX_FILE="$idx" git write-tree)" && \
    GIT_INDEX_FILE="$idx" git commit-tree "$tree" -m "ci-local snapshot" > "$tmp_dir/snap" )
  snap="$(cat "$tmp_dir/snap")"
  rm -rf "$tmp_dir"
  [ -n "$snap" ] || die "failed to build snapshot commit"
  log "pushing snapshot $snap -> $OWNER/$REPO main"
  ( cd "$REPO_ROOT" && git push -f "http://$OWNER:$TOKEN@localhost:3010/$OWNER/$REPO.git" \
    "$snap:refs/heads/main" 2>&1 | sed 's/^/  /' )
}

# act_runner streams job logs to Gitea (not to its own stdout), so read status from
# Gitea's DB. Actions status enum: 1=success 2=failure 3=cancelled 5=waiting 6=running.
gitea_sql() { "${COMPOSE[@]}" exec -T gitea sqlite3 /data/gitea/gitea.db "$1" 2>/dev/null | tr -d '\r'; }

preflight() {
  # The workflow's Postgres service publishes host port 5432 (as on GitHub-hosted
  # runners). On this shared daemon that clashes with a local Postgres — fail clearly.
  if lsof -nP -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1; then
    die "host port 5432 is in use (local Postgres?). The workflow's Postgres service needs it — free it first (e.g. 'pnpm docker:down' or 'docker stop app-postgres-1'), then re-run."
  fi
}

dump_run_logs() { # dump_run_logs RUN_ID — tail each job's log from disk
  local run_id="$1" rows
  rows="$(gitea_sql "SELECT t.status, t.log_filename FROM action_task t JOIN action_run_job j ON t.job_id=j.id WHERE j.run_id=$run_id;")"
  while IFS='|' read -r st lf; do
    [ -z "$lf" ] && continue
    log "---- job log ($lf, status=$st) ----"
    "${COMPOSE[@]}" exec -T gitea sh -c "tail -40 /data/gitea/actions_log/$lf 2>/dev/null" | sed 's/^/  /'
  done <<< "$rows"
}

wait_for_run() { # wait_for_run BEFORE_MAX_RUN_ID
  local before="$1" deadline=$(( $(date +%s) + 1800 )) run_id status
  log "waiting for the workflow run to finish (up to 30m; first run pulls the runner image)..."
  while :; do
    run_id="$(gitea_sql "SELECT id FROM action_run WHERE id > $before ORDER BY id DESC LIMIT 1;")"
    if [ -n "$run_id" ]; then
      status="$(gitea_sql "SELECT status FROM action_run WHERE id=$run_id;")"
      case "$status" in
        1) log "✅ run #$run_id: all jobs succeeded"; return 0 ;;
        2|3) log "❌ run #$run_id: status=$status"; dump_run_logs "$run_id"; return 1 ;;
      esac
    fi
    [ "$(date +%s)" -gt "$deadline" ] && { log "timed out waiting for the run"; return 2; }
    sleep 8
  done
}

cmd_run() {
  preflight
  local before_id; before_id="$(gitea_sql "SELECT COALESCE(MAX(id),0) FROM action_run;")"
  snapshot_and_push
  wait_for_run "${before_id:-0}" || die "CI did not pass (see job logs above; web UI: $WEB/$OWNER/$REPO/actions)"
  log "CI passed ✅"
}

cmd_status() {
  gitea_sql "SELECT j.name, j.status FROM action_run_job j WHERE j.run_id=(SELECT MAX(id) FROM action_run);" \
    | awk -F'|' '{s=($2==1?"✅ success":($2==2?"❌ failure":($2==6?"running":($2==5?"waiting":"status="$2)))); print s" — "$1}'
}
cmd_logs() { "${COMPOSE[@]}" logs --no-color runner 2>&1; }
cmd_down() { "${COMPOSE[@]}" down; }
cmd_reset() { "${COMPOSE[@]}" down -v; rm -f "$TOKEN_FILE"; log "wiped volumes + token"; }

case "${1:-}" in
  up) cmd_up ;;
  run) cmd_run ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  *) die "usage: $0 {up|run|status|logs|down|reset}" ;;
esac
