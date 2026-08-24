#!/usr/bin/env bash
# Bring up the demo stack, then wait until it is actually serving.
#
# Usage: dev/up.sh [--no-build] [--load] [--alloy] [--faults] [--otlp]
#   --no-build  skip the image build (faster when only source changed)
#   --load      drive 60s of traffic once the stack is up

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=./_env.sh
source ./_env.sh

BUILD_ARG="--build"
RUN_LOAD=0
COMPOSE_PROFILE=""
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD_ARG="" ;;
    --load) RUN_LOAD=1 ;;
    --alloy) COMPOSE_PROFILE="alloy"; export PYROSCOPE_TARGET_URL="http://alloy:9999" ;;
    --faults) COMPOSE_PROFILE="faults"; export PYROSCOPE_TARGET_URL="http://fault-receiver:4040" ;;
    --otlp) COMPOSE_PROFILE="otlp"; export OTLP_PROFILES_URL="http://otel-collector:4318" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

OURS="${COMPOSE_PROJECT_NAME:-bun-profiler-dev}"

# Which Compose project, if any, currently publishes a given host port.
project_holding_port() {
  local port=$1 cid proj
  for cid in $(docker ps -q --filter "publish=${port}" 2>/dev/null); do
    proj=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null || true)
    if [[ -n "$proj" ]]; then
      printf '%s\n' "$proj"
    else
      printf '%s\n' "container:$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's|^/||')"
    fi
  done
}

# Free our port block if one of *our own* stale stacks is sitting on it.
#
# This happens after a workspace rename: the project name is derived from the
# workspace directory, but an older stack may still be running under a previous
# name while holding the same CONDUCTOR_PORT block. Compose can't see it (the
# name no longer matches), so `up` fails with a bare "port is already allocated".
# Since the port block is assigned to exactly one workspace, any bun-profiler-*
# project holding it is definitively ours and safe to retire.
preflight_ports() {
  local conflicts=() proj port
  for port in "$APP_PORT" "$GRAFANA_PORT" "$PYROSCOPE_PORT" "$PROMETHEUS_PORT" "$ALLOY_PORT" "$FAULT_PORT" "$OTLP_PORT" "$WORKER_PORT"; do
    while read -r proj; do
      [[ -z "$proj" || "$proj" == "$OURS" ]] && continue
      conflicts+=("$proj")
    done < <(project_holding_port "$port")
  done

  [[ ${#conflicts[@]} -eq 0 ]] && return 0

  local unique
  unique=$(printf '%s\n' "${conflicts[@]}" | sort -u)

  local blocked=0
  while read -r proj; do
    [[ -z "$proj" ]] && continue
    if [[ "$proj" == "${COMPOSE_PROJECT_PREFIX}"* ]]; then
      echo "Port block ${APP_PORT}-${WORKER_PORT} is held by a stale stack of ours ('${proj}') — retiring it."
      docker compose -p "$proj" down -v --remove-orphans >/dev/null 2>&1 || true
    else
      echo "error: '${proj}' is already using a port in ${APP_PORT}-${WORKER_PORT} and is not ours." >&2
      blocked=1
    fi
  done <<< "$unique"

  if [[ "$blocked" == 1 ]]; then
    echo "       Stop it, or pin different ports:" >&2
    echo "       APP_PORT=... GRAFANA_PORT=... PYROSCOPE_PORT=... PROMETHEUS_PORT=... dev/up.sh" >&2
    exit 1
  fi
}

preflight_ports

echo "Starting ${OURS} on ports ${APP_PORT}/${GRAFANA_PORT}/${PYROSCOPE_PORT}/${PROMETHEUS_PORT} …"

# shellcheck disable=SC2086 # BUILD_ARG is intentionally word-split (may be empty)
if [[ -n "$COMPOSE_PROFILE" ]]; then
  docker compose --profile "$COMPOSE_PROFILE" up $BUILD_ARG -d --remove-orphans
else
  docker compose up $BUILD_ARG -d --remove-orphans
fi

# Wait for the app rather than declaring success the moment Compose returns —
# the container still has to boot and connect to Pyroscope.
printf 'Waiting for the demo app on %s ' "$APP_URL"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "$APP_URL/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'

if [[ "$ready" != 1 ]]; then
  echo "The app did not come up within 60s. Recent logs:" >&2
  docker compose logs --tail 30 app >&2
  exit 1
fi

cat <<EOF

  Demo panel:  ${APP_URL}
  Grafana:     http://localhost:${GRAFANA_PORT}/d/bun-profiler-demo
  Pyroscope:   http://localhost:${PYROSCOPE_PORT}
  Prometheus:  http://localhost:${PROMETHEUS_PORT}
  Alloy debug: http://localhost:${ALLOY_PORT} (when --alloy is active)
  OTLP/HTTP:   http://localhost:${OTLP_PORT} (when --otlp is active)

EOF

if [[ "$RUN_LOAD" == 1 ]]; then
  echo "Generating traffic so the flamegraphs have something in them…"
  ./loadgen.sh 60 "$APP_URL"
else
  echo "  Generate traffic:  bun run dev:load"
  echo
fi
