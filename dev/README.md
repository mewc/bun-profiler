# Local Dev Environment

Bun example app + Docker Compose infra for developing bun-profiler against a real observability stack.

The Bun app runs **natively on your machine** (where `node:inspector` works) while Pyroscope, Grafana, and Prometheus run in Docker.

## Quick Start

```bash
# From repo root — starts infra + Bun dev server with hot-reload:
bun run dev

# Or start separately:
bun run dev:infra        # Start Docker infra only
bun --hot dev/app/server.ts  # Start Bun app separately

# Tear down:
bun run dev:down
```

## Services

| Service    | URL                      | Description                            |
| ---------- | ------------------------ | -------------------------------------- |
| App        | http://localhost:3002     | Bun server using bun-profiler (native) |
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

Then open Pyroscope or Grafana Explore and look for `bun-profiler-example`.

## Why native Bun (not Docker)?

`node:inspector` (which this library needs for CPU profiling) is only implemented in Bun on macOS. It's [not yet available on Linux](https://github.com/oven-sh/bun/issues/2445), so the app must run natively. Editing `src/` hot-reloads instantly via `bun --hot`.
