# Local Dev Environment

Docker Compose stack for developing bun-profiler against a real observability backend.

## Quick Start

```bash
# From repo root:
bun run dev          # Start all services
bun run dev:logs     # Tail app logs
bun run dev:restart  # Restart app (picks up source changes via tsx --watch)
bun run dev:down     # Stop everything
```

## Services

| Service    | URL                      | Description                          |
| ---------- | ------------------------ | ------------------------------------ |
| App        | http://localhost:3002    | Example Bun server using bun-profiler |
| Pyroscope  | http://localhost:4042    | Profile storage & UI                 |
| Grafana    | http://localhost:3003    | Dashboards (anonymous admin, no login) |
| Prometheus | http://localhost:9091    | Metrics (scrapes app)                |

## Generating Profiling Data

Hit the CPU endpoint to create meaningful flamegraphs:

```bash
# Single request
curl http://localhost:3002/cpu

# Sustained load (30s)
dev/loadgen.sh
```

Then open Pyroscope (http://localhost:4042) or Grafana Explore (http://localhost:3003/explore) and look for `bun-profiler-example`.

## Architecture Notes

- The app container uses **Node.js + tsx** (not Bun) because `node:inspector` is not yet implemented in Bun on Linux. The profiler itself is runtime-agnostic.
- Source code is bind-mounted, so `tsx --watch` auto-reloads when you edit `src/`.
- Compression is disabled (`compress: false`) for simpler local debugging.
- Push interval is 5s for fast feedback.
