# bun-profiler

Continuous CPU profiling for [Bun](https://bun.sh) via [Pyroscope](https://pyroscope.io) / [Grafana](https://grafana.com/oss/pyroscope/) — zero native dependencies.

![CPU vs wall flamegraphs in Grafana](./docs/images/grafana-dashboard.png)

<p align="center"><em>The bundled demo stack — <code>bun run dev</code>. Same samples, weighted two ways.</em></p>

## Why this exists

Every other Node.js profiler package (`@pyroscope/nodejs`, `@datadog/pprof`, etc.) **segfaults or silently fails** on Bun because they call V8-specific native APIs that don't exist in JavaScriptCore (JSC). This package uses Bun's built-in `node:inspector` Profiler API directly, converts CDP profiles to Pyroscope's folded-stack format, and pushes them to your Pyroscope server.

## Requirements

- Bun ≥ 1.3.7
- A running Pyroscope instance (self-hosted or Grafana Cloud)

## Install

```sh
bun add bun-profiler
```

## Usage

```ts
import { startProfiling } from "bun-profiler";

// Fire-and-forget — call at app startup
startProfiling({
  pyroscopeUrl: "http://localhost:4040",
  appName: "my-service",
});
```

For manual start/stop control:

```ts
import { BunPyroscope } from "bun-profiler";

const profiler = new BunPyroscope({
  pyroscopeUrl: "http://localhost:4040",
  appName: "my-service",
});

await profiler.start();

// Later, e.g. in tests or graceful shutdown:
await profiler.stop(); // flushes final profile before disconnecting
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `pyroscopeUrl` | `string` | **required** | Pyroscope server URL |
| `appName` | `string` | `SERVICE_NAME` env / `npm_package_name` / `"bun-app"` | Application name |
| `sampleIntervalUs` | `number` | `10000` (10ms) | Sampling interval in microseconds |
| `pushIntervalMs` | `number` | `15000` (15s) | How often to flush profiles |
| `labels` | `Record<string, string>` | `{}` | Extra labels (merged with auto-detected) |
| `authToken` | `string` | — | Bearer token for auth |
| `basicAuth` | `{ username, password }` | — | Basic auth credentials |
| `maxRetries` | `number` | `2` | Push retry attempts before dropping window |
| `compress` | `boolean` | `false` | Gzip the request body — see the warning below |
| `debug` | `boolean` | `false` | Log debug info to stderr |
| `wallTime` | `{ enabled: boolean }` | `{ enabled: false }` | Wall-time profiling (opt-in) |
| `heap` | `{ enabled, samplingIntervalBytes? }` | `{ enabled: false }` | Heap allocation profiling (opt-in) |

> **Don't enable `compress` unless you've confirmed your server accepts it.** Grafana Pyroscope's `/ingest` endpoint does not decompress `format=folded` bodies. Verified against `grafana/pyroscope:latest`: a gzipped body is answered with **HTTP 200** and then stored as an empty profile. Nothing errors, nothing retries, and no data ever appears. It defaults to `false` for that reason.

## Wall-time profiling

CPU profiling only captures on-CPU time — what your code does when it's actively executing JavaScript. For I/O-heavy servers that spend most of their time waiting on external APIs, databases, or network calls, CPU profiles miss the full picture.

Wall-time profiling weights stacks by elapsed microseconds rather than sample count, and surfaces time spent parked off-CPU as an explicit `(idle)` frame.

```ts
startProfiling({
  pyroscopeUrl: "http://localhost:4040",
  appName: "my-api-server",
  wallTime: { enabled: true },
});
```

When enabled, an additional `wall` profile stream is pushed alongside `cpu`. In Pyroscope/Grafana, select the `my-api-server.wall{}` stream to see the wall-time flamegraph.

It adds no extra sampling overhead — it reuses the same CDP profile data as CPU profiling.

### What it can and cannot tell you on Bun

**It tells you how much time went off-CPU. It cannot tell you which call was waiting.**

JavaScriptCore emits no `(idle)` samples and stops sampling altogether while the process is parked, so the first sample taken *after* a wait carries a `timeDelta` spanning the entire wait. Nothing in the profile records what the process was waiting on.

This matters, because attributing that whole delta to the sampled stack — the obvious implementation — blames whichever function happened to resume. Measured on Bun 1.3.14, for a request that awaited 300ms and then ran a 60ms handler:

| | Reported |
| --- | --- |
| Naive: charge the full delta to the sampled stack | `renderReceipt` **354ms** — the function that waited never appears |
| What actually happened | `renderReceipt` 60ms, waiting 300ms |
| This package | `renderReceipt` **58ms**, `(idle)` **301ms** |

A delta larger than twice the sampling interval is treated as a gap: the stack is credited with one sampling interval, and the remainder is booked to `(idle)`. So a `(idle)` block that dwarfs everything else is the signal that your service is I/O-bound — you then reach for request tracing to find *which* call, because a JSC sampling profiler fundamentally cannot answer that.

On Node.js/V8, which does emit real `(idle)` samples, those are already attributed correctly and are passed through untouched.

## Tagging a region of code

`tag()` splits the profiling window so a specific block of work gets its own labelled stream — useful for a background job, a migration, or one hot endpoint:

```ts
const profiler = new BunPyroscope({ pyroscopeUrl: "...", appName: "my-service" });
await profiler.start();

await profiler.tag({ job: "nightly-report" }, async () => {
  await generateReport();
});
```

The work inside runs under `my-service.cpu{job=nightly-report}`, so you can isolate it in Pyroscope.

It flushes the current window on entry and exit, so each call costs two extra pushes — use it around meaningful units of work, not per request.

> **Not safe to call concurrently on one instance.** Labels are swapped on shared state, so overlapping `tag()` calls will misattribute each other's samples. For concurrent workloads, use separate `BunPyroscope` instances.

## Heap profiling

Opt-in allocation profiling tracks where memory is being allocated:

```ts
startProfiling({
  pyroscopeUrl: "http://localhost:4040",
  appName: "my-service",
  heap: { enabled: true, samplingIntervalBytes: 32_768 },
});
```

When enabled, an `alloc_space` profile stream is pushed alongside `cpu`.

**Bun limitation:** Bun's JavaScriptCore runtime does not currently implement `HeapProfiler.enable`. When heap profiling is enabled on Bun, the profiler logs a warning and continues with CPU-only profiling. Heap profiling works on Node.js/V8. This will be supported once Bun adds HeapProfiler to their inspector implementation.

## Auto-detected labels

The following labels are added automatically when the corresponding environment variables are set:

| Label | Environment variable(s) |
|---|---|
| `service_name` | `SERVICE_NAME`, `npm_package_name`, or `appName` option |
| `service_version` | `SERVICE_VERSION`, `npm_package_version` |
| `environment` | `NODE_ENV`, `BUN_ENV` |
| `hostname` | `os.hostname()` (always present) |
| `fly_region` | `FLY_REGION` |
| `fly_app_name` | `FLY_APP_NAME` |
| `aws_region` | `AWS_REGION`, `AWS_DEFAULT_REGION` |
| `railway_region` | `RAILWAY_REGION` |
| `railway_service` | `RAILWAY_SERVICE_NAME` |
| `pod_name` | `POD_NAME` |
| `k8s_namespace` | `K8S_NAMESPACE` |

Extra labels passed via the `labels` option override auto-detected values.

## Try it locally

A complete demo stack — Bun app, Pyroscope, Grafana, Prometheus — lives in [`dev/`](./dev).

```sh
bun run dev:demo   # start everything, then drive 60s of traffic
```

It waits until the stack is serving and prints the URLs — by default
<http://localhost:3003/d/bun-profiler-demo>. (Ports are per-workspace under
[Conductor](https://conductor.build), so take them from the output.)

The demo server exposes workloads with deliberately distinct flamegraph shapes — deep recursion, a hot comparator, regex scanning, crypto — alongside I/O-bound ones and a realistic mixed `/api/checkout` pipeline. Drive them from the panel the script links to (<http://localhost:3002> by default):

![Demo control panel](./docs/images/demo-panel.png)

The provisioned dashboard puts the two profiles side by side. Same samples, weighted differently:

![CPU vs wall flamegraphs in Grafana](./docs/images/grafana-dashboard.png)

The CPU profile contains no idle time at all — every frame is real compute, and it points at `applyDiscounts` and the regex scan. The wall profile, over the same window, shows that the largest single block is `(idle)`:

![Wall profile with idle as the top entry](./docs/images/wall-flamegraph.png)

That contrast is the whole argument for wall-time profiling: the CPU flamegraph tells you which loop to optimise, while the wall flamegraph tells you whether optimising it would matter at all.

See [`dev/README.md`](./dev/README.md) for the full workload list and troubleshooting.

## Development

```sh
bun install
bun run l       # typecheck + lint + tests
bun run build
```

## How it works

1. Connects to Bun's embedded JavaScriptCore inspector via `node:inspector/promises`
2. Every `pushIntervalMs`: stops the profiler and converts the CDP profile to [folded stacks](https://www.brendangregg.com/FlameGraphs/cpuflamegraphs.html)
3. Restarts profiling immediately, then gzips and POSTs the window to `/ingest` in the background so the next window isn't blocked on the network
4. On SIGTERM/SIGINT: flushes the current window before exiting

Step 2 does leave a small blind spot: the `Profiler.stop` round trip and the fold pass happen between windows, so work during that gap isn't sampled. It's on the order of milliseconds against a default 15s window, but it isn't zero — profiles are a statistical sample, not an audit log.

## Why not `Bun.jsc.profile()`?

Bun exposes `bun:jsc` with a `profile()` function, but it's **not suitable** for continuous profiling:

- **Wrong output format** — `Bun.jsc.profile()` returns a `SamplingProfile` with pre-formatted text strings (`.functions`, `.bytecodes`, `.stackTraces`), not structured CDP/V8 JSON with `nodes`/`samples`/`timeDeltas`. There's no way to convert this to folded stacks without writing a brittle text parser.
- **No start/stop control** — `Bun.jsc.startSamplingProfiler()` has no corresponding stop function. It's a fire-and-forget debug tool that writes to a directory, not a programmatic API.
- **`node:inspector` already works** — Bun added full `node:inspector` Profiler support in [v1.3.7](https://bun.sh/blog/bun-v1.3.7) (November 2024). This is the same CDP API that Chrome DevTools uses, returning proper `CdpProfile` objects that convert directly to Pyroscope's folded-stack format. That's why the minimum Bun version is 1.3.7.

If you're on Bun < 1.3.7, you'll get a clear error from `start()` explaining the requirement. Upgrade Bun and it works out of the box.

## Graceful shutdown

Signal handlers are installed automatically. On SIGTERM or SIGINT, the profiler flushes the current window and disconnects before re-emitting the signal so your process exits normally.

## Release

```sh
bun run release:patch   # 0.1.0 → 0.1.1  (bug fixes)
bun run release:minor   # 0.1.0 → 0.2.0  (new features)
bun run release:major   # 0.1.0 → 1.0.0  (breaking changes)
```

Bumps `package.json`, commits, tags, and pushes. GitHub Actions publishes to npm automatically via OIDC trusted publishing — no token required.

## License

MIT

---

Built by [mewc](https://x.com/the_mewc) · [ChartCastr](https://chartcastr.com)
