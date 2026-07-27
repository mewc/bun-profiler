#!/usr/bin/env bash
# Run an arbitrary `docker compose` command against this workspace's stack,
# with the ports and project name resolved the same way dev/up.sh resolves them.
#
# Usage: dev/compose.sh logs -f app
#        dev/compose.sh restart app
#        dev/compose.sh ps

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=./_env.sh
source ./_env.sh

exec docker compose "$@"
