#!/usr/bin/env bash
# Drive mixed traffic at the demo server so the flamegraphs have something
# interesting in them.
#
# Usage: dev/loadgen.sh [duration_seconds] [base_url]
#
# The endpoint mix is weighted so no single workload swamps the flamegraph:
# the checkout pipeline is the most frequent (it's the most instructive), the
# heavy CPU workloads are rarer.

set -uo pipefail

DURATION=${1:-60}
BASE=${2:-http://localhost:3002}
CONCURRENCY=${CONCURRENCY:-4}

# Repeated entries = higher weight.
ENDPOINTS=(
  /api/checkout
  /api/checkout
  /api/checkout
  /api/checkout
  /api/io/waterfall
  /api/io/waterfall
  /api/io/parallel
  /api/io/slow-query
  /api/io/upstream
  /api/cpu/fib
  /api/cpu/sort
  /api/cpu/json
  /api/cpu/regex
  /api/cpu/hash
)

if ! curl -fsS "$BASE/health" >/dev/null 2>&1; then
  echo "error: demo server is not responding at $BASE" >&2
  echo "       start it with:  bun run dev" >&2
  exit 1
fi

echo "Driving $BASE for ${DURATION}s (concurrency $CONCURRENCY)…"

END=$((SECONDS + DURATION))
COUNT=0

while [ $SECONDS -lt $END ]; do
  endpoint=${ENDPOINTS[$((RANDOM % ${#ENDPOINTS[@]}))]}
  curl -fsS "$BASE$endpoint" >/dev/null 2>&1 &
  COUNT=$((COUNT + 1))
  if (( COUNT % CONCURRENCY == 0 )); then
    wait
  fi
done
wait

echo "Done — $COUNT requests in ${DURATION}s"
echo
echo "  Pyroscope   http://localhost:4042"
echo "  Grafana     http://localhost:3003/d/bun-profiler-demo"
echo
echo "In Pyroscope, compare these two streams:"
echo "  bun-profiler-demo.cpu{}    — where CPU time goes"
echo "  bun-profiler-demo.wall{}   — where wall-clock time goes (includes I/O waits)"
