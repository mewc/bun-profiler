# Shared port + Compose project resolution. Source this, don't execute it.
#
# Standalone, you get the fixed defaults. Inside a Conductor workspace,
# CONDUCTOR_PORT provides a private block of 10 ports and the workspace gets its
# own Compose project — without both, parallel workspaces would fight over the
# same host ports and, because Compose names the project after the directory
# ("dev"), over the same containers.

if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  : "${APP_PORT:=$((CONDUCTOR_PORT))}"
  : "${GRAFANA_PORT:=$((CONDUCTOR_PORT + 1))}"
  : "${PYROSCOPE_PORT:=$((CONDUCTOR_PORT + 2))}"
  : "${PROMETHEUS_PORT:=$((CONDUCTOR_PORT + 3))}"
  : "${ALLOY_PORT:=$((CONDUCTOR_PORT + 4))}"
  : "${FAULT_PORT:=$((CONDUCTOR_PORT + 5))}"
  : "${OTLP_PORT:=$((CONDUCTOR_PORT + 6))}"
  : "${WORKER_PORT:=$((CONDUCTOR_PORT + 7))}"
else
  : "${APP_PORT:=3002}"
  : "${GRAFANA_PORT:=3003}"
  : "${PYROSCOPE_PORT:=4042}"
  : "${PROMETHEUS_PORT:=9091}"
  : "${ALLOY_PORT:=12346}"
  : "${FAULT_PORT:=4043}"
  : "${OTLP_PORT:=4318}"
  : "${WORKER_PORT:=3004}"
fi
export APP_PORT GRAFANA_PORT PYROSCOPE_PORT PROMETHEUS_PORT ALLOY_PORT FAULT_PORT OTLP_PORT WORKER_PORT

# Identify the project by the workspace DIRECTORY, not CONDUCTOR_WORKSPACE_NAME.
# Conductor renames a workspace to follow its branch, but leaves the worktree
# directory alone. Keying on the name meant a rename silently produced a second
# project competing for the same CONDUCTOR_PORT block as the stack already
# running — which fails with "port is already allocated" and strands the old
# containers under a name nothing refers to any more.
if [[ -z "${COMPOSE_PROJECT_NAME:-}" ]]; then
  _ws_dir="${CONDUCTOR_WORKSPACE_PATH:-}"
  if [[ -z "$_ws_dir" ]]; then
    # dev/ lives one level below the workspace root.
    _ws_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  fi
  _slug=$(basename "$_ws_dir" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9_-' '-' \
    | sed 's/-\{1,\}$//')
  if [[ -n "$_slug" && -n "${CONDUCTOR_PORT:-}" ]]; then
    export COMPOSE_PROJECT_NAME="bun-profiler-${_slug}"
  fi
  unset _ws_dir _slug
fi

# Every stack this repo starts shares this prefix, which lets dev/up.sh tell its
# own strays apart from unrelated containers when a port is taken.
export COMPOSE_PROJECT_PREFIX="bun-profiler-"
export APP_URL="http://localhost:${APP_PORT}"
