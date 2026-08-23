#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ./_env.sh

./up.sh --faults
control="http://localhost:${FAULT_PORT}/control"

for attempt in {1..120}; do
  if curl -fsS "$control" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 120 ]]; then
    echo "Fault receiver did not become ready at $control" >&2
    exit 1
  fi
  sleep 0.25
done

echo "Injecting 500, Retry-After 429, malformed-request 400, delay, then recovery while traffic continues…"
curl -fsS "${control}?status=500&delayMs=0&retryAfter=" >/dev/null
./loadgen.sh 8 "$APP_URL"
curl -fsS "${control}?status=429&retryAfter=2" >/dev/null
./loadgen.sh 8 "$APP_URL"
curl -fsS "${control}?status=400&retryAfter=" >/dev/null
./loadgen.sh 8 "$APP_URL"
curl -fsS "${control}?status=200&delayMs=12000" >/dev/null
./loadgen.sh 8 "$APP_URL"
curl -fsS "${control}?status=200&delayMs=0" >/dev/null
./loadgen.sh 8 "$APP_URL"

echo "Profiler metrics after recovery:"
curl -fsS "$APP_URL/metrics" | grep '^bun_profiler_' | grep -E 'failures|retries|dropped|queue|last_success'
