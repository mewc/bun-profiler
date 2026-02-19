# bun-pyroscope

Continuous CPU profiling for [Bun](https://bun.sh) via [Pyroscope](https://pyroscope.io) / [Grafana](https://grafana.com/oss/pyroscope/) — zero native dependencies.

## Why this exists

Every other Node.js profiler package (`@pyroscope/nodejs`, `@datadog/pprof`, etc.) **segfaults or silently fails** on Bun because they call V8-specific native APIs that don't exist in JavaScriptCore (JSC). This package uses Bun's built-in `node:inspector` Profiler API directly, converts CDP profiles to Pyroscope's folded-stack format, and pushes them to your Pyroscope server.

## Requirements

- Bun ≥ 1.3.7
- A running Pyroscope instance (self-hosted or Grafana Cloud)

## Install

```sh
bun add bun-pyroscope
```

## Usage

```ts
import { startProfiling } from "bun-pyroscope";

// Fire-and-forget — call at app startup
startProfiling({
  pyroscopeUrl: "http://localhost:4040",
  appName: "my-service",
});
```

For manual start/stop control:

```ts
import { BunPyroscope } from "bun-pyroscope";

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
| `debug` | `boolean` | `false` | Log debug info to stderr |

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

## Local development

```sh
# Start Pyroscope
docker run -p 4040:4040 grafana/pyroscope

# Run checks (typecheck + lint + tests)
bun l

# Build
bun run build
```

## How it works

1. Connects to Bun's embedded JavaScriptCore inspector via `node:inspector/promises`
2. Every `pushIntervalMs`: stops the profiler, converts the CDP profile to [folded stacks](https://www.brendangregg.com/FlameGraphs/cpuflamegraphs.html), gzip-compresses it, and POSTs to `POST /ingest`
3. Immediately restarts profiling — no gap in coverage
4. On SIGTERM/SIGINT: flushes the current window before exiting

## Graceful shutdown

Signal handlers are installed automatically. On SIGTERM or SIGINT, the profiler flushes the current window and disconnects before re-emitting the signal so your process exits normally.

## Publishing to npm

```sh
# Bump version in package.json, then:
git tag v0.1.0
git push origin v0.1.0
# GitHub Actions will run CI and publish automatically
```

Or manually: `npm publish --access public`

## Release

```sh
bun run release:patch   # 0.1.0 → 0.1.1  (bug fixes)
bun run release:minor   # 0.1.0 → 0.2.0  (new features)
bun run release:major   # 0.1.0 → 1.0.0  (breaking changes)
```

Bumps `package.json`, commits, tags, pushes — GitHub Actions publishes to npm automatically via OIDC.

## License

MIT

---

Built by [mewc](https://x.com/the_mewc) · [ChartCastr](https://chartcastr.com)
