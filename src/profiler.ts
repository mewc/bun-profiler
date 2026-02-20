import { Session } from "node:inspector/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { calculateSampleRate, convertHeapToFolded, convertToFolded } from "./converter.js";
import { buildDefaultLabels, encodePyroscopeName, resolveAppName } from "./labels.js";
import type {
  BunPyroscopeOptions,
  CdpProfile,
  ResolvedConfig,
  SamplingHeapProfile,
} from "./types.js";

const gzipAsync = promisify(gzip);

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
  private signalHandlersInstalled = false;

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
      heap: {
        enabled: options.heap?.enabled ?? false,
        samplingIntervalBytes: options.heap?.samplingIntervalBytes ?? 32_768,
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

    this.session = new Session();
    this.session.connect();

    try {
      await this.session.post("Profiler.enable");
      await this.session.post("Profiler.setSamplingInterval", {
        interval: this.config.sampleIntervalUs,
      });
    } catch (err) {
      this.session.disconnect();
      this.session = null;
      throw new Error(`[bun-pyroscope] Failed to initialize profiler session: ${err}`);
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

    await this.endWindowAndPush().catch((err) => {
      this.log("warn", `Final flush failed: ${err}`);
    });

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
    this.pushTimer = setTimeout(async () => {
      await this.endWindowAndPush();
      if (this.running) await this.beginWindow();
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

    const folded = convertToFolded(profile);
    if (!folded) {
      this.log("debug", `Empty profile for window [${this.windowStart}-${windowEnd}], skipping`);
    } else {
      const sampleRate = calculateSampleRate(profile);
      // Fire-and-forget push — never block the profiling loop
      this.pushWithRetry(folded, this.windowStart, windowEnd, sampleRate).catch((err) => {
        this.log("error", `All retries exhausted for [${this.windowStart}-${windowEnd}]: ${err}`);
      });
    }

    if (this.config.heap.enabled) {
      this.flushHeapWindow(this.windowStart, windowEnd).catch((err) => {
        this.log("error", `Heap flush failed for [${this.windowStart}-${windowEnd}]: ${err}`);
      });
    }
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

    this.pushWithRetry(folded, windowStart, windowEnd, 1, "alloc_space").catch((err) => {
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
    const body = await gzipAsync(Buffer.from(folded, "utf8"));

    const headers: Record<string, string> = {
      "Content-Type": "text/plain",
      "Content-Encoding": "gzip",
      "Content-Length": String(body.length),
    };
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
          const lines = folded.split("\n").length;
          this.log("debug", `Pushed ${lines} stacks [${from}-${until}] HTTP ${response.status}`);
          return;
        }

        const text = await response.text().catch(() => "(unreadable)");
        const err = new Error(`HTTP ${response.status}: ${text}`);

        // 4xx = client error, retrying won't help
        if (response.status >= 400 && response.status < 500) throw err;

        lastError = err;
        this.log("warn", `Push failed (attempt ${attempt + 1}): ${err.message}`);
      } catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.message.startsWith("HTTP 4")) throw fetchErr;
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
      // 5. Cancel any timer that fired during fn()
      if (this.pushTimer !== null) {
        clearTimeout(this.pushTimer);
        this.pushTimer = null;
      }

      // 6. Flush tagged window
      await this.endWindowAndPush();

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
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    const shutdown = async (signal: NodeJS.Signals) => {
      this.log("debug", `Received ${signal}, flushing final profile...`);
      process.removeListener("SIGTERM", sigtermHandler);
      process.removeListener("SIGINT", sigintHandler);
      await this.stop().catch((err) => {
        this.log("error", `Error during ${signal} shutdown: ${err}`);
      });
      process.kill(process.pid, signal);
    };

    const sigtermHandler = () => void shutdown("SIGTERM");
    const sigintHandler = () => void shutdown("SIGINT");

    process.on("SIGTERM", sigtermHandler);
    process.on("SIGINT", sigintHandler);
  }

  private log(level: "debug" | "warn" | "error", msg: string): void {
    if (level === "debug" && !this.config.debug) return;
    console.error(`[bun-pyroscope] [${level.toUpperCase()}] ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
