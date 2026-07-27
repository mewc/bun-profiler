# Local demo environment

A full observability stack plus a demo Bun server, so you can watch `bun-profiler`
work against a real Pyroscope and Grafana.

The app container bind-mounts the repo, so `bun --hot` picks up edits to both the
demo and `src/` instantly.

> Requires `oven/bun:1.3`+ in the container — `node:inspector` support on Linux
> landed in Bun 1.3.

## Quick start

```bash
bun run dev        # build & start everything (detached)
bun run dev:load   # drive ~60s of mixed traffic
```

Then open <http://localhost:3003/d/bun-profiler-demo> and compare the two
flamegraphs.

| Command               | What it does                                     |
| --------------------- | ------------------------------------------------ |
| `bun run dev`         | Build and start all services                     |
| `bun run dev:load`    | Drive mixed traffic (`dev/loadgen.sh [seconds]`) |
| `bun run dev:logs`    | Tail app logs (profiler pushes are logged)       |
| `bun run dev:restart` | Restart just the app                             |
| `bun run dev:reset`   | Wipe all profile data and rebuild from scratch   |
| `bun run dev:down`    | Stop everything and delete volumes               |

## Services

| Service    | URL                                         | Notes                           |
| ---------- | ------------------------------------------- | ------------------------------- |
| Demo panel | <http://localhost:3002>                     | Run any workload from a browser |
| Grafana    | <http://localhost:3003/d/bun-profiler-demo> | Provisioned dashboard, no login |
| Pyroscope  | <http://localhost:4042>                     | Raw profile storage & UI        |
| Prometheus | <http://localhost:9091>                     | Scrapes the app's `/metrics`    |

## The workloads

Every workload is registered in `dev/app/workloads/index.ts`; the HTTP routes and
the HTML panel are both generated from that one list.

**CPU-bound** — visible in both flamegraphs, each with a distinct shape:

| Route            | Shape                                 |
| ---------------- | ------------------------------------- |
| `/api/cpu/fib`   | Tall narrow tower (deep recursion)    |
| `/api/cpu/sort`  | Shallow and wide (one hot comparator) |
| `/api/cpu/json`  | Two fat siblings (stringify / parse)  |
| `/api/cpu/regex` | Regex engine frames dominate          |
| `/api/cpu/hash`  | Native crypto frames dominate         |

**I/O-bound** — absent from `cpu`, and the reason `wall` exists:

| Route                | Behaviour                                |
| -------------------- | ---------------------------------------- |
| `/api/io/slow-query` | One 250ms wait                           |
| `/api/io/waterfall`  | Four serial queries (~400ms)             |
| `/api/io/parallel`   | The same four via `Promise.all` (~130ms) |
| `/api/io/upstream`   | A real `fetch()` round trip              |

**Mixed** — `/api/checkout` is the most instructive one. A single request costs
~60ms of CPU but ~250ms of wall time, so the two flamegraphs disagree about what
the problem is. The CPU profile blames `applyDiscounts`; the wall profile shows
most of the request was spent parked on I/O.

## What you should see

In `bun-profiler-demo.cpu` there is no idle time at all — every frame is real
compute. In `bun-profiler-demo.wall`, `(idle)` is typically the single largest
block once the I/O workloads have run.

That `(idle)` frame is synthesised by the converter. JavaScriptCore emits no idle
samples and stops sampling entirely while the process is parked, so an oversized
sample gap is split into one sampling interval of on-CPU time plus an `(idle)`
remainder. See the "Wall-time profiling" section of the root README for why
attributing the whole gap to the sampled stack would be actively misleading.

## Troubleshooting

**Grafana exits with `Datasource provisioning error: data source not found`.**
You have an older Grafana container whose database predates the datasource UIDs.
`bun run dev:reset` clears it.

**`all predefined address pools have been fully subnetted`.** Docker has run out
of network address space, usually from many stopped Compose projects. Reclaim it
with `docker network prune`, which only removes networks no container is using.

**No data in the flamegraphs.** Confirm the app is pushing — `bun run dev:logs`
should show `Pushed N stacks ... HTTP 200` every 5s. Profiles only appear after a
window is flushed, so give it ~10s after generating load.
