#!/usr/bin/env bash
# Generate sustained CPU load against the dev server for ~30 seconds.
# Usage: dev/loadgen.sh [duration_seconds] [url]

DURATION=${1:-30}
URL=${2:-http://localhost:3002/cpu}

echo "Hitting $URL for ${DURATION}s..."
END=$((SECONDS + DURATION))
COUNT=0

while [ $SECONDS -lt $END ]; do
  curl -s "$URL" > /dev/null &
  COUNT=$((COUNT + 1))
  # Limit concurrency — wait every 4 requests
  if (( COUNT % 4 == 0 )); then
    wait
  fi
done
wait

echo "Done — sent $COUNT requests in ${DURATION}s"
echo "Check profiles at http://localhost:4042 or http://localhost:3003/explore"
