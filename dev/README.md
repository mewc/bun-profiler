# Local demo environment

A full observability stack plus a demo Bun server, so you can watch `bun-profiler`
work against a real Pyroscope and Grafana.

The app container bind-mounts the repo, so `bun --hot` picks up edits to both the
demo and `src/` instantly.

> Requires `oven/bun:1.3`+ in the container — `node:inspector` support on Linux
> landed in Bun 1.3.

## Quick start

```bash
bun run dev:demo   # start everything, then drive 60s of traffic
```

`dev/up.sh` waits until the app is actually serving and then prints the URLs it
published — don't hardcode them, see [Ports](#ports) below.

| Command               | What it does                                       |
| --------------------- | -------------------------------------------------- |
| `bun run dev`         | Build and start all services, wait until healthy    |
| `bun run dev:demo`    | Same, then generate traffic so nothing is empty     |
| `bun run dev:load`    | Drive mixed traffic (`dev/loadgen.sh [seconds]`)    |
| `bun run dev:logs`    | Tail app logs (profiler pushes are logged)          |
| `bun run dev:restart` | Restart just the app                                |
| `bun run dev:reset`   | Wipe all profile data and rebuild from scratch      |
| `bun run dev:down`    | Stop this workspace's stack and delete its volumes  |
| `bun run screenshots` | Regenerate the README images from the running stack |

## The control panel

<http://localhost:3002> (or your workspace's port) lists every workload:

- **Run** on a card runs that one workload.
- **Run all N** next to a group heading runs just that group, in sequence.
- **Run all 10 workloads** runs everything.

Each result shows the elapsed time and a **View this run in Grafana →** link
pointing at the dashboard with the time range set to that run's window (padded,
since profiles are pushed on an interval). That's the quickest way to see a
single request's flamegraph rather than hunting for it in a 15-minute window.

Groups run sequentially on purpose — overlapping workloads interleave in the
flamegraph and stop being separable.

## Services

| Service    | Default URL                                 | Notes                           |
| ---------- | ------------------------------------------- | ------------------------------- |
| Demo panel | <http://localhost:3002>                     | Run any workload from a browser |
| Grafana    | <http://localhost:3003/d/bun-profiler-demo> | Provisioned dashboard, no login |
| Pyroscope  | <http://localhost:4042>                     | Raw profile storage & UI        |
| Prometheus | <http://localhost:9091>                     | Scrapes the app's `/metrics`    |

## Ports

Those defaults apply to a plain checkout. Under Conductor, each workspace gets
its own block of ten ports via `CONDUCTOR_PORT`, and the stack runs under its own
Compose project name (`bun-profiler-<workspace>`):

| Service    | Port                |
| ---------- | ------------------- |
| Demo panel | `CONDUCTOR_PORT`    |
| Grafana    | `CONDUCTOR_PORT`+1  |
| Pyroscope  | `CONDUCTOR_PORT`+2  |
| Prometheus | `CONDUCTOR_PORT`+3  |

Both are needed for parallel workspaces. Without per-workspace ports the second
workspace fails to bind; without a per-workspace project name Compose would name
every stack after the `dev` directory, so `up` in one workspace would recreate
another workspace's containers and `down` would delete them.

`dev/_env.sh` resolves this and is sourced by every script here, so
`dev/up.sh`, `dev/down.sh`, `dev/loadgen.sh` and `dev/compose.sh` always agree on
which stack they are talking to. Override any of `APP_PORT`, `GRAFANA_PORT`,
`PYROSCOPE_PORT`, `PROMETHEUS_PORT` or `COMPOSE_PROJECT_NAME` to pin them
yourself.

Run an arbitrary Compose command against this workspace's stack with
`dev/compose.sh`, e.g. `dev/compose.sh ps`.

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

## Conductor

`.conductor/settings.toml` registers these as run scripts, so the stack is
startable from the Run tab: **dev** (start), **demo** (start + traffic), **load**,
**test**, **check**. `run_mode` is `concurrent` because the port and project-name
isolation above makes it safe for several workspaces to run the stack at once.

Shared settings only take effect once merged to the default branch. To use them
before that, copy the file to `.conductor/settings.local.toml` in the repository
root — that path is read immediately and is gitignored.

## Troubleshooting

**Grafana exits with `Datasource provisioning error: data source not found`.**
You have an older Grafana container whose database predates the datasource UIDs.
`bun run dev:reset` clears it.

**Ports already allocated.** `dev/up.sh` handles the common case itself: if a
`bun-profiler-*` stack is sitting on this workspace's port block, it is by
definition an orphan of ours (the block belongs to exactly one workspace), so the
script retires it and continues. If something unrelated holds the port it stops
and says so rather than killing your container — free the port, or pin your own:

```bash
APP_PORT=4102 GRAFANA_PORT=4103 PYROSCOPE_PORT=4104 PROMETHEUS_PORT=4105 dev/up.sh
```

`dev/down.sh --all` removes every `bun-profiler-*` stack on the machine.

**Renaming a Conductor workspace.** Conductor renames a workspace to follow its
branch but leaves the worktree directory alone, so the project name is derived
from the directory. Deriving it from `CONDUCTOR_WORKSPACE_NAME` meant a rename
produced a *second* project competing for the same port block as the stack
already running, which failed with "port is already allocated" and stranded the
original containers under a name nothing referenced any more.

## Screenshots

`bun run screenshots` drives the running stack with Playwright — it clicks
"Run all", waits for the profiler to push, drives 90s of mixed traffic, waits
until Prometheus actually returns series, and only then captures Grafana. It
fails loudly if a panel renders "No data" or if any result is missing its Grafana
link, so a green run is evidence the demo works end to end rather than a picture
of a hopeful moment.

**`all predefined address pools have been fully subnetted`.** Docker has run out
of network address space, usually from many stopped Compose projects. Reclaim it
with `docker network prune`, which only removes networks no container is using.

**No data in the flamegraphs.** Confirm the app is pushing — `bun run dev:logs`
should show `Pushed N stacks ... HTTP 200` every 5s. Profiles only appear after a
window is flushed, so give it ~10s after generating load.
