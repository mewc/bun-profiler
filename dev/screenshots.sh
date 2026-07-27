#!/usr/bin/env bash
# Regenerate the README screenshots against the running stack.
# Resolves this workspace's ports first, then hands off to the Playwright script.

set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=./_env.sh
source ./_env.sh

# Bun does not run untrusted postinstall scripts, so installing the `playwright`
# package does not fetch a browser. This is idempotent and near-instant once the
# browser is present; without it the script dies with Playwright's
# "Executable doesn't exist" stack trace.
bunx playwright install chromium

exec bun ./screenshots.ts
