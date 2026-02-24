# Local Dev Environment

Full Docker Compose stack for developing bun-profiler against a real observability backend.

All services run in Docker — the Bun app container bind-mounts the repo source so `bun --hot` picks up changes instantly.

> **Requires `oven/bun:1.3`+** in the container (`node:inspector` support on Linux landed in Bun 1.3).

## Quick Start

```bash
# From repo root:
bun run dev          # Build & start all services (detached)
bun run dev:logs     # Tail app logs
bun run dev:restart  # Restart app (picks up source changes)
bun run dev:down     # Stop everything
```

## Services

| Service    | URL                      | Description                            |
| ---------- | ------------------------ | -------------------------------------- |
| App        | http://localhost:3002     | Bun server using bun-profiler          |
| Pyroscope  | http://localhost:4042     | Profile storage & UI                   |
| Grafana    | http://localhost:3003     | Dashboards (anonymous admin, no login) |
| Prometheus | http://localhost:9091     | Metrics (scrapes app)                  |

## Generating Profiling Data

Hit the CPU endpoint to create meaningful flamegraphs:

```bash
# Single request
curl http://localhost:3002/cpu

# Sustained load (30s)
dev/loadgen.sh
```

Then open Pyroscope (http://localhost:4042) or Grafana Explore (http://localhost:3003/explore) and look for `bun-profiler-example`.
