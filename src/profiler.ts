import type { Session } from "node:inspector/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  calculateSampleRate,
  convertHeapToFolded,
  convertToFolded,
  convertToFoldedWallTime,
} from "./converter.js";
import { buildDefaultLabels, encodePyroscopeName, resolveAppName } from "./labels.js";
import type {
  BunPyroscopeOptions,
  CdpProfile,
  ResolvedConfig,
  SamplingHeapProfile,
} from "./types.js";

const gzipAsync = promisify(gzip);

/**
 * View a Buffer as a plain Uint8Array — Bun's fetch handles this more reliably
 * than a Buffer subclass. The view shares Buffer's pooled ArrayBuffer, which is
 * fine because byteOffset/byteLength scope it to exactly this buffer's bytes.
 */
function toUint8Array(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * A non-2xx response from the Pyroscope ingest endpoint.
 *
 * Carries the status so retry decisions are made on a typed field rather than
 * by sniffing the message string.
 */
class PushError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = "PushError";
    this.status = status;
  }

  /** 5xx is transient; 429/408 are explicitly retryable. Other 4xx are not. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

/**
 * BunPyroscope manages a continuous CPU profiling loop for Bun processes.
 *
 * Lifecycle:
 *   new BunPyroscope(options) — resolves config, no side effects
 *   await profiler.start()    — connects session, begins push loop
 *   await profiler.stop()     — stops loop, flushes final profile, disconnects
 *
 * Push loop per window:
 *   1. Record windowStart (Unix seconds)
 *   2. Profiler.start
 *   3. Wait pushIntervalMs
 *   4. Profiler.stop → CdpProfile
 *   5. Convert to folded stacks + gzip
 *   6. POST to Pyroscope /ingest (with retry)
 *   7. Goto 1 (if still running)
 *
 * Push failures never stop profiling. After maxRetries, the window is
 * dropped and profiling continues normally.
 */
export class BunPyroscope {
  private readonly config: ResolvedConfig;
  private session: Session | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private windowStart = 0;
  private inFlightPushes = new Set<Promise<void>>();
  /**
   * The flush/restart cycle currently executing in the timer callback.
   * clearTimeout cannot cancel a callback that has already fired, so stop()
   * and tag() await this to avoid issuing a second concurrent Profiler.stop.
   */
  private activeCycle: Promise<void> | null = null;
  /** Kept so stop() can remove them — otherwise every instance leaks two listeners. */
  private signalHandlers: { sigterm: () => void; sigint: () => void } | null = null;

  constructor(options: BunPyroscopeOptions) {
    const appName = resolveAppName(options.appName);
    const defaultLabels = buildDefaultLabels(appName);

    this.config = {
      pyroscopeUrl: options.pyroscopeUrl.replace(/\/$/, ""),
      appName,
      sampleIntervalUs: options.sampleIntervalUs ?? 10_000,
      pushIntervalMs: options.pushIntervalMs ?? 15_000,
      labels: { ...defaultLabels, ...(options.labels ?? {}) },
      authToken: options.authToken,
      basicAuth: options.basicAuth,
      maxRetries: options.maxRetries ?? 2,
      debug: options.debug ?? false,
      // Defaults to false: Pyroscope's /ingest silently discards gzipped
      // folded bodies (HTTP 200, empty profile stored). See BunPyroscopeOptions.
      compress: options.compress ?? false,
      heap: {
        enabled: options.heap?.enabled ?? false,
        samplingIntervalBytes: options.heap?.samplingIntervalBytes ?? 32_768,
      },
      wallTime: {
        enabled: options.wallTime?.enabled ?? false,
      },
    };
  }

  /**
   * Start continuous profiling. No-op if already running.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log("warn", "start() called but profiler is already running");
      return;
    }

    try {
      const mod = await import("node:inspector/promises");
      if (!mod.Session) throw new Error("Session export missing");
      this.session = new mod.Session();
      this.session.connect();
    } catch {
      this.session = null;
      throw new Error(
        "[bun-profiler] node:inspector/promises is not available in this runtime. " +
          "CPU profiling requires Node.js or a Bun version with inspector support."
      );
    }

    try {
      await this.session.post("Profiler.enable");
      await this.session.post("Profiler.setSamplingInterval", {
        interval: this.config.sampleIntervalUs,
      });
    } catch (err) {
      this.session.disconnect();
      this.session = null;
      throw new Error(`[bun-profiler] Failed to initialize profiler session: ${err}`);
    }

    if (this.config.heap.enabled) {
      try {
        await this.session.post("HeapProfiler.enable");
        await this.session.post("HeapProfiler.startSampling", {
          samplingInterval: this.config.heap.samplingIntervalBytes,
        });
      } catch (err) {
        this.log("warn", `HeapProfiler init failed (heap profiling disabled): ${err}`);
        this.config.heap.enabled = false;
      }
    }

    this.running = true;
    this.installSignalHandlers();
    await this.beginWindow();
  }

  /**
   * Stop profiling. Flushes the current window before disconnecting. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }

    // A timer callback that already fired can't be cancelled. Let it finish so
    // we don't issue a second concurrent Profiler.stop, and so the window it is
    // pushing is registered before we snapshot the in-flight set below.
    await this.activeCycle?.catch(() => undefined);

    await this.endWindowAndPush().catch((err) => {
      this.log("warn", `Final flush failed: ${err}`);
    });

    // Pushes registered while awaiting can add more entries, so drain until
    // empty rather than awaiting a single snapshot — otherwise the final
    // window is dropped on the floor, which is the whole point of stop().
    while (this.inFlightPushes.size > 0) {
      await Promise.allSettled([...this.inFlightPushes]);
    }

    this.removeSignalHandlers();

    if (this.session) {
      if (this.config.heap.enabled) {
        try {
          await this.session.post("HeapProfiler.disable");
        } catch {
          // Ignore — already stopping
        }
      }
      try {
        this.session.disconnect();
      } catch {
        // Ignore disconnect errors during shutdown
      }
      this.session = null;
    }
  }

  private async beginWindow(schedule = true): Promise<void> {
    if (!this.session || !this.running) return;

    this.windowStart = Math.floor(Date.now() / 1000);

    try {
      await this.session.post("Profiler.start");
    } catch (err) {
      this.log("error", `Profiler.start failed: ${err}`);
      if (schedule) this.scheduleNextWindow();
      return;
    }

    if (schedule) this.scheduleNextWindow();
  }

  private scheduleNextWindow(): void {
    if (!this.running) return;
    this.pushTimer = setTimeout(() => {
      // Mark the timer as spent — it has fired and can no longer be cleared.
      this.pushTimer = null;

      // This promise deliberately never rejects. Any escaping error would
      // leave the profiler stopped with no window ever scheduled again, and
      // would surface only as an unhandled rejection.
      const cycle = (async () => {
        try {
          await this.endWindowAndPush();
        } catch (err) {
          // e.g. converting a malformed profile.
          this.log("error", `Push cycle failed: ${err}`);
        }

        if (!this.running) return;

        try {
          await this.beginWindow();
        } catch (err) {
          this.log("error", `Failed to restart profiling window: ${err}`);
        }
      })();

      this.activeCycle = cycle;
      void cycle.then(() => {
        if (this.activeCycle === cycle) this.activeCycle = null;
      });
    }, this.config.pushIntervalMs);
  }

  private async endWindowAndPush(): Promise<void> {
    if (!this.session) return;

    const windowEnd = Math.floor(Date.now() / 1000);

    let profile: CdpProfile;
    try {
      const result = (await this.session.post("Profiler.stop")) as { profile: CdpProfile };
      profile = result.profile;
    } catch (err) {
      this.log("error", `Profiler.stop failed: ${err}`);
      return;
    }

    // Capture windowStart locally so async catch handlers log the correct value
    // (this.windowStart may be updated by beginWindow() before the push completes)
    const windowStart = this.windowStart;

    const folded = convertToFolded(profile);
    if (!folded) {
      this.log("debug", `Empty profile for window [${windowStart}-${windowEnd}], skipping`);
    } else {
      const sampleRate = calculateSampleRate(profile);
      // Push is non-blocking so the profiling loop can start the next window immediately,
      // but we track the promise so stop() can await delivery before disconnecting.
      this.trackPush(
        this.pushWithRetry(folded, windowStart, windowEnd, sampleRate).catch((err) => {
          this.log("error", `All retries exhausted for [${windowStart}-${windowEnd}]: ${err}`);
        })
      );
    }

    if (this.config.wallTime.enabled) {
      const wallFolded = convertToFoldedWallTime(profile, this.config.sampleIntervalUs);
      if (!wallFolded) {
        this.log(
          "debug",
          `Empty wall-time profile for window [${windowStart}-${windowEnd}], skipping`
        );
      } else {
        this.trackPush(
          this.pushWithRetry(wallFolded, windowStart, windowEnd, 1_000_000, "wall").catch((err) => {
            this.log("error", `Wall-time push failed for [${windowStart}-${windowEnd}]: ${err}`);
          })
        );
      }
    }

    if (this.config.heap.enabled) {
      this.trackPush(
        this.flushHeapWindow(windowStart, windowEnd).catch((err) => {
          this.log("error", `Heap flush failed for [${windowStart}-${windowEnd}]: ${err}`);
        })
      );
    }
  }

  private trackPush(p: Promise<void>): void {
    this.inFlightPushes.add(p);
    p.finally(() => this.inFlightPushes.delete(p));
  }

  private async flushHeapWindow(windowStart: number, windowEnd: number): Promise<void> {
    if (!this.session) return;

    let heapProfile: SamplingHeapProfile;
    try {
      const result = (await this.session.post("HeapProfiler.stopSampling")) as {
        profile: SamplingHeapProfile;
      };
      heapProfile = result.profile;
    } catch (err) {
      this.log("warn", `HeapProfiler.stopSampling failed: ${err}`);
      return;
    }

    try {
      await this.session.post("HeapProfiler.startSampling", {
        samplingInterval: this.config.heap.samplingIntervalBytes,
      });
    } catch (err) {
      this.log("warn", `HeapProfiler.startSampling (restart) failed: ${err}`);
    }

    const folded = convertHeapToFolded(heapProfile);
    if (!folded) {
      this.log("debug", `Empty heap profile for window [${windowStart}-${windowEnd}], skipping`);
      return;
    }

    await this.pushWithRetry(folded, windowStart, windowEnd, 1, "alloc_space").catch((err) => {
      this.log("error", `Heap push failed for [${windowStart}-${windowEnd}]: ${err}`);
    });
  }

  private buildIngestUrl(from: number, until: number, sampleRate: number, type = "cpu"): string {
    const name = encodePyroscopeName(this.config.appName, this.config.labels, type);
    const params = new URLSearchParams({
      name,
      from: String(from),
      until: String(until),
      sampleRate: String(sampleRate),
      spyName: "nodespy",
      format: "folded",
    });
    return `${this.config.pyroscopeUrl}/ingest?${params.toString()}`;
  }

  private buildAuthHeader(): string | undefined {
    if (this.config.authToken) return `Bearer ${this.config.authToken}`;
    if (this.config.basicAuth) {
      const { username, password } = this.config.basicAuth;
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      return `Basic ${encoded}`;
    }
    return undefined;
  }

  private async pushWithRetry(
    folded: string,
    from: number,
    until: number,
    sampleRate: number,
    type = "cpu"
  ): Promise<void> {
    const url = this.buildIngestUrl(from, until, sampleRate, type);
    const authHeader = this.buildAuthHeader();

    let body: Uint8Array | string;
    const headers: Record<string, string> = {
      "Content-Type": "text/plain",
    };

    if (this.config.compress) {
      const gzipped = await gzipAsync(Buffer.from(folded, "utf8"));
      // Use Uint8Array instead of Buffer for reliable binary handling in Bun's fetch
      body = toUint8Array(gzipped);
      headers["Content-Encoding"] = "gzip";
      // Content-Length is deliberately not set — it's a forbidden request
      // header, so fetch derives it from the body. Setting it risks a
      // duplicate/conflicting header that strict proxies answer with a 400.
    } else {
      body = folded;
    }

    if (authHeader) headers.Authorization = authHeader;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        this.log("debug", `Retry ${attempt}/${this.config.maxRetries} after ${delayMs}ms`);
        await sleep(delayMs);
      }

      try {
        const response = await fetch(url, { method: "POST", headers, body });

        if (response.ok) {
          // Drain the body so the connection can be reused rather than held
          // open — this runs thousands of times over a process's lifetime.
          await response.arrayBuffer().catch(() => undefined);
          const lines = folded.split("\n").length;
          this.log("debug", `Pushed ${lines} stacks [${from}-${until}] HTTP ${response.status}`);
          return;
        }

        const text = await response.text().catch(() => "(unreadable)");
        const err = new PushError(response.status, text);

        // Most 4xx are client errors that retrying won't fix, but 429 (ingest
        // rate limit — Grafana Cloud returns this) and 408 are explicitly
        // retryable. Treating them as fatal drops every window for the whole
        // duration of a rate limit.
        if (!err.retryable) throw err;

        lastError = err;
        this.log("warn", `Push failed (attempt ${attempt + 1}): ${err.message}`);
      } catch (fetchErr) {
        // Non-retryable HTTP status — propagate rather than burning retries.
        if (fetchErr instanceof PushError && !fetchErr.retryable) throw fetchErr;
        lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
        this.log("warn", `Push error (attempt ${attempt + 1}): ${lastError.message}`);
      }
    }

    if (lastError) throw lastError;
  }

  /**
   * Run `fn` with extra labels applied to the profile window.
   *
   * Splits the current profiling window at entry and exit so the tagged code
   * gets its own labeled profile stream in Pyroscope.
   *
   * Note: concurrent `tag()` calls on the same profiler instance are not safe.
   * For concurrent workloads, create separate BunPyroscope instances.
   */
  async tag<T>(extraLabels: Record<string, string>, fn: () => T | Promise<T>): Promise<Awaited<T>> {
    if (!this.running || !this.session) return (await fn()) as Awaited<T>;

    // 1. Cancel scheduled push
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }

    // 2. Flush current window with existing labels
    await this.endWindowAndPush();

    // 3. Override labels
    const savedLabels = this.config.labels;
    this.config.labels = { ...savedLabels, ...extraLabels };

    // 4. Start tagged window without auto-scheduling
    await this.beginWindow(false);

    try {
      return (await fn()) as Awaited<T>;
    } finally {
      // 5. Cancel any timer that fired during fn(), and let an already-running
      //    cycle finish so it can't interleave with the flush below.
      if (this.pushTimer !== null) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
      }
      await this.activeCycle?.catch(() => undefined);

      // 6. Flush the tagged window. If this throws, the labels must still be
      //    restored — otherwise every later window is misattributed to this
      //    tag and profiling never resumes.
      try {
        await this.endWindowAndPush();
      } catch (err) {
        this.log("error", `Tagged window flush failed: ${err}`);
      }

      // 7. Restore labels + resume normal profiling
      this.config.labels = savedLabels;
      if (this.running) await this.beginWindow();
    }
  }

  /**
   * Install SIGTERM/SIGINT handlers to flush the final profile on shutdown.
   * After flush, re-emits the signal so the process exits normally.
   */
  private installSignalHandlers(): void {
    if (this.signalHandlers) return;

    const shutdown = async (signal: NodeJS.Signals) => {
      this.log("debug", `Received ${signal}, flushing final profile...`);
      // stop() removes the handlers, so the re-raise below doesn't re-enter.
      await this.stop().catch((err) => {
        this.log("error", `Error during ${signal} shutdown: ${err}`);
      });
      process.kill(process.pid, signal);
    };

    const sigtermHandler = () => void shutdown("SIGTERM");
    const sigintHandler = () => void shutdown("SIGINT");

    this.signalHandlers = { sigterm: sigtermHandler, sigint: sigintHandler };

    process.on("SIGTERM", sigtermHandler);
    process.on("SIGINT", sigintHandler);
  }

  /**
   * Detach the shutdown handlers.
   *
   * Without this, every start()/stop() pair leaks two process listeners —
   * enough instances triggers MaxListenersExceededWarning and makes each stale
   * handler re-raise the signal on shutdown.
   */
  private removeSignalHandlers(): void {
    if (!this.signalHandlers) return;
    process.removeListener("SIGTERM", this.signalHandlers.sigterm);
    process.removeListener("SIGINT", this.signalHandlers.sigint);
    this.signalHandlers = null;
  }

  private log(level: "debug" | "warn" | "error", msg: string): void {
    if (level === "debug" && !this.config.debug) return;
    const formatted = `[bun-profiler] [${level.toUpperCase()}] ${msg}`;
    if (level === "error") console.error(formatted);
    else if (level === "warn") console.warn(formatted);
    else console.log(formatted);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
