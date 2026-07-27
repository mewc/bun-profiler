#!/usr/bin/env bash
# Tear down this workspace's demo stack, including its volumes.
#
# Usage: dev/down.sh [--all] [extra docker compose args]
#   --all  also remove every other bun-profiler-* stack on this machine,
#          e.g. one stranded under a previous workspace name.

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=./_env.sh
source ./_env.sh

REMOVE_ALL=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --all) REMOVE_ALL=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

OURS="${COMPOSE_PROJECT_NAME:-bun-profiler-dev}"

echo "Stopping ${OURS} …"
docker compose down -v --remove-orphans ${ARGS[@]+"${ARGS[@]}"}

if [[ "$REMOVE_ALL" == 1 ]]; then
  # Compose only knows about projects it can name, so find strays by label.
  strays=$(docker ps -aq --filter "label=com.docker.compose.project" 2>/dev/null \
    | xargs -r docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null \
    | sort -u | grep "^${COMPOSE_PROJECT_PREFIX}" | grep -v "^${OURS}$" || true)

  if [[ -n "$strays" ]]; then
    while read -r proj; do
      [[ -z "$proj" ]] && continue
      echo "Removing stray stack '${proj}' …"
      docker compose -p "$proj" down -v --remove-orphans >/dev/null 2>&1 || true
    done <<< "$strays"
  else
    echo "No stray bun-profiler-* stacks."
  fi
fi
