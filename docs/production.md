# Production guide

## Runtime support

| Runtime | CPU push/pull | Wall profile | Allocation profile | Heap snapshot |
| --- | --- | --- | --- | --- |
| Bun 1.3.7+ | Supported | Supported, with synthesized idle gaps | Capability-detected; unavailable while Bun rejects `HeapProfiler.enable` | Supported on demand |
| Node.js 22 | Regression smoke | Supported | Supported through V8 `HeapProfiler` | Bun-only helper unavailable |

One inspector CPU profiler may run per Bun process. This includes workers: choose either the main isolate or one worker preload. `tag()` regions must not overlap. Pull and continuous push mode are mutually exclusive.

## Failure behavior

Each exporter has a sequential queue and destinations drain concurrently. The default queue holds two waiting profiles. When it is full, the oldest waiting profile is dropped; capture never waits for network I/O. The shorthand Pyroscope exporter aborts an HTTP attempt after `exportTimeoutMs` (10 seconds by default). Timeouts, 408, 429, 5xx, and transport failures are retryable. Other 4xx responses fail immediately.

Retries use exponential backoff with equal jitter to avoid a fleet retrying in lockstep. The built-in Pyroscope and experimental OTLP exporters honor both HTTP `Retry-After` forms. Server-provided delays receive only positive jitter, so a retry never occurs before the requested time. Delays are capped at five minutes so an untrusted response cannot park a destination indefinitely; `shutdownTimeoutMs` can still abort a pending delay during process termination.

Watch these signals:

- `bun_profiler_running` and `bun_profiler_capture_failures_total` for capture-loop health.
- `bun_profiler_capture_gap_seconds` for the unavoidable inspector restart gap.
- Per-exporter queue, retry, failure, drop, duration, and last-success metrics for delivery health.
- `lastError` in `stats()` for operator-facing detail; errors are not placed in Prometheus labels.

`stop()` flushes the active window and drains destinations up to `shutdownTimeoutMs`. At the deadline, pending and in-flight windows are counted as dropped and shutdown returns even if an exporter ignores `AbortSignal`.

## Kubernetes environment example

```yaml
env:
  - name: PYROSCOPE_SERVER_ADDRESS
    value: http://alloy.monitoring.svc:9999
  - name: PYROSCOPE_APPLICATION_NAME
    value: orders
  - name: PYROSCOPE_LABELS
    value: environment=production,team=payments
  - name: PYROSCOPE_UPLOAD_INTERVAL
    value: 15s
  - name: BUN_PROFILER_MAX_PENDING_WINDOWS
    value: "2"
  - name: BUN_PROFILER_SHUTDOWN_TIMEOUT
    value: 10s
  - name: BUN_PROFILER_EXPORT_TIMEOUT
    value: 10s
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
  - name: K8S_NAMESPACE
    valueFrom:
      fieldRef:
        fieldPath: metadata.namespace
```

Start with `bun --preload bun-profiler/preload src/server.ts` or call `startProfilingFromEnv()` at bootstrap. Allow at least `shutdownTimeoutMs` in the pod termination grace period.

The tested Alloy receiver/fan-out configuration is [`examples/alloy/config.alloy`](../examples/alloy/config.alloy). It accepts the library's Pyroscope HTTP transport and forwards to two independently configured destinations.

## Exporter extension contract

A custom exporter supplies a stable unique `name`, an async `export(window, signal)` method, and optionally `shutdown()`. Calls are serialized for that exporter. Different exporters run concurrently. Treat the frozen `ProfileWindow` wrapper and labels as readonly; the raw CDP payload is shared and must not be mutated.

Honor `AbortSignal` so shutdown can cancel I/O. Throw `ExporterError` with `retryable: false` for permanent failures. Ordinary errors are treated as retryable. A custom HTTP exporter can set `retryAfterMs` on `ExporterError`; the queue treats it as a minimum delay and adds positive jitter. Never retain an unbounded number of windows outside the library queue.

## Migration and encoding policy

Existing `new BunPyroscope({ pyroscopeUrl, ... })` and `startProfiling()` calls remain valid. The shorthand URL creates the default Pyroscope exporter. Supplying `exporters` adds explicit destinations; supplying both sends to both.

Folded ingestion remains the default throughout 0.x. Set `pyroscopeFormat: "pprof"` or configure a pprof Pyroscope exporter explicitly to opt in. A future 1.0 will only switch the default after real-backend parity testing shows no profile loss.

OTLP Profiles remains under `bun-profiler/experimental`. Its Alpha dictionary schema and `/v1development/profiles` endpoint may change without normal compatibility guarantees.

## Performance procedure

Run `bun run bench` on the same machine and Bun release used in production. It compares unprofiled, CPU, CPU+wall, pprof encoding, and a selected-worker configuration, reporting elapsed time, relative overhead, capture gap, and RSS. Results are informational until enough cross-platform data exists for a reliable hard gate.
