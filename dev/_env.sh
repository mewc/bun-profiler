# Shared port + Compose project resolution. Source this, don't execute it.
#
# Standalone, you get the fixed defaults. Inside a Conductor workspace,
# CONDUCTOR_PORT provides a private block of 10 ports and
# CONDUCTOR_WORKSPACE_NAME makes the Compose project unique — without both,
# parallel workspaces would fight over the same host ports and, because Compose
# names the project after the directory ("dev"), over the same containers.

if [[ -n "${CONDUCTOR_PORT:-}" ]]; then
  : "${APP_PORT:=$((CONDUCTOR_PORT))}"
  : "${GRAFANA_PORT:=$((CONDUCTOR_PORT + 1))}"
  : "${PYROSCOPE_PORT:=$((CONDUCTOR_PORT + 2))}"
  : "${PROMETHEUS_PORT:=$((CONDUCTOR_PORT + 3))}"
else
  : "${APP_PORT:=3002}"
  : "${GRAFANA_PORT:=3003}"
  : "${PYROSCOPE_PORT:=4042}"
  : "${PROMETHEUS_PORT:=9091}"
fi
export APP_PORT GRAFANA_PORT PYROSCOPE_PORT PROMETHEUS_PORT

if [[ -z "${COMPOSE_PROJECT_NAME:-}" && -n "${CONDUCTOR_WORKSPACE_NAME:-}" ]]; then
  _slug=$(printf '%s' "$CONDUCTOR_WORKSPACE_NAME" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9_-' '-' \
    | sed 's/-\{1,\}$//')
  export COMPOSE_PROJECT_NAME="bun-profiler-${_slug}"
  unset _slug
fi

export APP_URL="http://localhost:${APP_PORT}"
