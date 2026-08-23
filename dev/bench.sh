#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun dev/bench.ts
