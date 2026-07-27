#!/usr/bin/env bash
# Tear down this workspace's demo stack, including its volumes.
#
# Resolves the same Compose project name as dev/up.sh, so it only ever stops
# the containers belonging to this workspace.

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=./_env.sh
source ./_env.sh

echo "Stopping ${COMPOSE_PROJECT_NAME:-bun-profiler-dev} …"
docker compose down -v "$@"
