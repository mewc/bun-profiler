#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source dev/_env.sh

dev/up.sh
export PYROSCOPE_SERVER_ADDRESS="http://localhost:${PYROSCOPE_PORT}"
export PYROSCOPE_APPLICATION_NAME="bun-profiler-workers"
export PYROSCOPE_UPLOAD_INTERVAL="5s"
export BUN_PROFILER_WALL_TIME_ENABLED="true"
export WORKER_PORT
exec bun dev/workers/server.ts
