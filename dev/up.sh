#!/usr/bin/env bash
# Bring up the demo stack, then wait until it is actually serving.
#
# Usage: dev/up.sh [--no-build] [--load]
#   --no-build  skip the image build (faster when only source changed)
#   --load      drive 60s of traffic once the stack is up

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=./_env.sh
source ./_env.sh

BUILD_ARG="--build"
RUN_LOAD=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD_ARG="" ;;
    --load) RUN_LOAD=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

echo "Starting ${COMPOSE_PROJECT_NAME:-bun-profiler-dev} on ports ${APP_PORT}/${GRAFANA_PORT}/${PYROSCOPE_PORT}/${PROMETHEUS_PORT} …"

# shellcheck disable=SC2086 # BUILD_ARG is intentionally word-split (may be empty)
docker compose up $BUILD_ARG -d

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

EOF

if [[ "$RUN_LOAD" == 1 ]]; then
  echo "Generating traffic so the flamegraphs have something in them…"
  ./loadgen.sh 60 "$APP_URL"
else
  echo "  Generate traffic:  bun run dev:load"
  echo
fi
