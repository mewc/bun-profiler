import type { Session } from "node:inspector/promises";
import { optionsFromEnv, resolveConfig } from "./config.js";
import {
  calculateSampleRate,
  convertHeapToFolded,
  convertToFolded,
  convertToFoldedWallTime,
} from "./converter.js";
import { ProfilerConcurrencyError, ProfilerConfigError } from "./errors.js";
import { ExporterRunner } from "./exporter-runner.js";
import { pyroscopeExporter } from "./exporters.js";
import { SourceMapResolver } from "./source-maps.js";
import type {
  BunPyroscopeOptions,
  CdpProfile,
  ProfilerMemoryStats,
  ProfilerStats,
  ProfileWindow,
  ResolvedConfig,
  SamplingHeapProfile,
} from "./types.js";

const ACTIVE_PROFILER = Symbol.for("bun-profiler.active-profiler");
const registry = globalThis as typeof globalThis & { [ACTIVE_PROFILER]?: BunPyroscope };

interface CapturedWindow {
  profile: CdpProfile;
  heapProfile?: SamplingHeapProfile;
  from: number;
  until: number;
  labels: Readonly<Record<string, string>>;
  sampleIntervalUs: number;
}

export class BunPyroscope {
  private readonly config: ResolvedConfig;
  private readonly runners: ExporterRunner[];
  private session: Session | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private profileActive = false;
  private windowStart = 0;
  private windowLabels: Readonly<Record<string, string>> = Object.freeze({});
  private activeCycle: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private tagActive = false;
  private signalHandlers: { sigterm: () => void; sigint: () => void } | null = null;
  private capturedWindows = 0;
  private capturedSamples = 0;
  private captureFailures = 0;
  private emptyWindows = 0;
  private lastCaptureGapMs: number | null = null;
  private maxCaptureGapMs = 0;
  private lastConversionDurationMs: number | null = null;
  private currentSampleIntervalUs: number;
  private samplingIntervalChanges = 0;
  private jscHeapStats: (() => Record<string, number>) | null = null;
  private readonly sourceMapResolver: SourceMapResolver | null;

  constructor(options: BunPyroscopeOptions) {
    this.config = resolveConfig(options);
    this.currentSampleIntervalUs = this.config.sampleIntervalUs;
    this.sourceMapResolver = this.config.sourceMaps.enabled
      ? new SourceMapResolver(this.config.sourceMaps.cacheSize)
      : null;
    const exporters = [...this.config.exporters];
    if (this.config.pyroscopeUrl) {
      exporters.unshift(
        pyroscopeExporter({
          url: this.config.pyroscopeUrl,
          authToken: this.config.authToken,
          basicAuth: this.config.basicAuth,
          tenantId: this.config.tenantId,
          headers: this.config.headers,
          compress: this.config.compress,
          format: this.config.pyroscopeFormat,
          timeoutMs: this.config.exportTimeoutMs,
        })
      );
    }
    const names = new Set<string>();
    for (const exporter of exporters) {
      if (!exporter.name.trim()) throw new ProfilerConfigError("exporter name must not be empty");
      if (names.has(exporter.name)) {
        throw new ProfilerConfigError(`duplicate exporter name ${JSON.stringify(exporter.name)}`);
      }
      names.add(exporter.name);
    }
    this.runners = exporters.map(
      (exporter) =>
        new ExporterRunner(exporter, {
          maxPending: this.config.maxPendingWindows,
          maxRetries: this.config.maxRetries,
          debug: (message) => this.log("debug", message),
        })
    );
  }

  static fromEnv(overrides: Partial<BunPyroscopeOptions> = {}): BunPyroscope {
    return new BunPyroscope(optionsFromEnv(overrides));
  }

  async start(): Promise<void> {
    await this.stopPromise;
    if (this.running) {
      this.log("warn", "start() called but profiler is already running");
      return;
    }
    if (registry[ACTIVE_PROFILER] && registry[ACTIVE_PROFILER] !== this) {
      throw new ProfilerConcurrencyError(
        "another profiler is already active in this isolate; Bun currently supports only one inspector CPU sampler per process"
      );
    }
    registry[ACTIVE_PROFILER] = this;

    try {
      const mod = await import("node:inspector/promises");
      if (!mod.Session) throw new Error("Session export missing");
      this.session = new mod.Session();
      this.session.connect();
      await this.session.post("Profiler.enable");
      await this.session.post("Profiler.setSamplingInterval", {
        interval: this.currentSampleIntervalUs,
      });
    } catch (error) {
      this.cleanupFailedStart();
      if (String(error).includes("Profiler")) {
        throw new Error(`[bun-profiler] Failed to initialize profiler session: ${error}`);
      }
      throw new Error(
        "[bun-profiler] node:inspector/promises is not available in this runtime. " +
          "CPU profiling requires Node.js or a Bun version with inspector support."
      );
    }

    if (this.config.heap.enabled) {
      try {
        await this.session.post("HeapProfiler.enable");
        await this.session.post("HeapProfiler.startSampling", {
          samplingInterval: this.config.heap.samplingIntervalBytes,
        });
      } catch (error) {
        this.log("warn", `HeapProfiler init failed (heap profiling disabled): ${error}`);
        this.config.heap.enabled = false;
      }
    }

    await this.detectJscHeapStats();
    this.running = true;
    this.installSignalHandlers();
    try {
      await this.beginWindow();
      this.scheduleNextWindow();
    } catch (error) {
      this.running = false;
      this.removeSignalHandlers();
      this.cleanupFailedStart();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (!this.running && !this.profileActive) return;
    this.running = false;
    this.clearTimer();
    await this.activeCycle?.catch(() => undefined);

    if (this.profileActive) {
      await this.captureWindow(false).catch((error) => {
        this.log("warn", `Final capture failed: ${error}`);
      });
    }

    await this.drainExporters();
    this.removeSignalHandlers();
    if (this.session) {
      if (this.config.heap.enabled) {
        await this.session.post("HeapProfiler.disable").catch(() => undefined);
      }
      try {
        this.session.disconnect();
      } catch {
        // Already disconnected.
      }
      this.session = null;
    }
    if (registry[ACTIVE_PROFILER] === this) delete registry[ACTIVE_PROFILER];
  }

  private cleanupFailedStart(): void {
    try {
      this.session?.disconnect();
    } catch {
      // Ignore cleanup failures.
    }
    this.session = null;
    this.profileActive = false;
    if (registry[ACTIVE_PROFILER] === this) delete registry[ACTIVE_PROFILER];
  }

  private async beginWindow(): Promise<void> {
    if (!this.session || !this.running) return;
    this.windowStart = Math.floor(Date.now() / 1_000);
    this.windowLabels = Object.freeze({ ...this.config.labels });
    await this.session.post("Profiler.start");
    this.profileActive = true;
  }

  private scheduleNextWindow(): void {
    if (!this.running || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const cycle = this.captureWindow(true).catch((error) => {
        this.log("error", `Capture cycle failed: ${error}`);
        if (this.running && !this.profileActive) {
          void this.beginWindow()
            .then(() => this.scheduleNextWindow())
            .catch((startError) => this.log("error", `Failed to recover profiler: ${startError}`));
        }
      });
      this.activeCycle = cycle;
      void cycle.finally(() => {
        if (this.activeCycle === cycle) this.activeCycle = null;
        // Conversion is deliberately after restart, but a conversion failure
        // must not silently kill future rotations while sampling continues.
        if (this.running && this.profileActive) this.scheduleNextWindow();
      });
    }, this.config.pushIntervalMs);
    // Profiling must not keep a short-lived CLI/script alive by itself. The
    // preload entry point uses beforeExit to flush the final partial window.
    this.pushTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
  }

  /** Stop, immediately restart, and only then convert/export the completed profile. */
  private async captureWindow(restart: boolean): Promise<void> {
    if (!this.session || !this.profileActive) return;
    const session = this.session;
    const from = this.windowStart;
    const labels = this.windowLabels;
    const sampleIntervalUs = this.currentSampleIntervalUs;
    const until = Math.max(Math.floor(Date.now() / 1_000), from + 1);
    const gapStarted = performance.now();
    let profile: CdpProfile;
    try {
      const result = (await session.post("Profiler.stop")) as { profile: CdpProfile };
      profile = result.profile;
      this.profileActive = false;
    } catch (error) {
      this.captureFailures++;
      throw error;
    }

    // This ordering is the core blind-spot fix. No conversion or network work
    // happens until a new sampling window is active.
    if (restart && this.running) {
      await this.adjustSamplingInterval(profile, session);
      await this.beginWindow();
      const gapMs = performance.now() - gapStarted;
      this.lastCaptureGapMs = gapMs;
      this.maxCaptureGapMs = Math.max(this.maxCaptureGapMs, gapMs);
    }

    let heapProfile: SamplingHeapProfile | undefined;
    if (this.config.heap.enabled) {
      try {
        const heapResult = (await session.post("HeapProfiler.stopSampling")) as {
          profile: SamplingHeapProfile;
        };
        heapProfile = heapResult.profile;
        if (this.running || restart) {
          await session.post("HeapProfiler.startSampling", {
            samplingInterval: this.config.heap.samplingIntervalBytes,
          });
        }
      } catch (error) {
        this.log("warn", `Heap profile rotation failed: ${error}`);
      }
    }

    await this.processCaptured({ profile, heapProfile, from, until, labels, sampleIntervalUs });
    if (restart && this.running) this.scheduleNextWindow();
  }

  private async processCaptured(captured: CapturedWindow): Promise<void> {
    const conversionStarted = performance.now();
    const profile = this.sourceMapResolver
      ? await this.sourceMapResolver.resolveProfile(captured.profile)
      : captured.profile;
    this.capturedWindows++;
    this.capturedSamples += profile.samples?.length ?? 0;

    const cpuFolded = convertToFolded(profile);
    if (cpuFolded) {
      this.enqueueWindow(
        this.makeWindow("cpu", cpuFolded, calculateSampleRate(profile), profile, captured)
      );
    } else {
      this.emptyWindows++;
    }

    if (this.config.wallTime.enabled) {
      const wallFolded = convertToFoldedWallTime(profile, captured.sampleIntervalUs);
      if (wallFolded) {
        this.enqueueWindow(this.makeWindow("wall", wallFolded, 1_000_000, profile, captured));
      }
    }

    if (captured.heapProfile) {
      const heapFolded = convertHeapToFolded(captured.heapProfile);
      if (heapFolded) {
        this.enqueueWindow(
          this.makeWindow("alloc_space", heapFolded, 1, captured.heapProfile, captured)
        );
      }
    }
    this.lastConversionDurationMs = performance.now() - conversionStarted;
  }

  private makeWindow(
    type: ProfileWindow["type"],
    folded: string,
    sampleRate: number,
    profile: ProfileWindow["profile"],
    captured: CapturedWindow
  ): ProfileWindow {
    return Object.freeze({
      type,
      appName: this.config.appName,
      labels: captured.labels,
      from: captured.from,
      until: captured.until,
      sampleRate,
      sampleIntervalUs: captured.sampleIntervalUs,
      folded,
      profile,
    });
  }

  private enqueueWindow(window: ProfileWindow): void {
    for (const runner of this.runners) runner.enqueue(window);
  }

  private async drainExporters(): Promise<void> {
    const finish = async () => {
      await Promise.all(this.runners.map((runner) => runner.waitForIdle()));
      await Promise.allSettled(this.runners.map((runner) => runner.shutdown()));
    };
    const draining = finish();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      draining.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), this.config.shutdownTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed) {
      for (const runner of this.runners) runner.abortAndDrop();
      // An exporter is allowed to ignore AbortSignal. Do not await it after the
      // configured deadline or process shutdown could hang forever.
      void draining.catch(() => undefined);
    }
  }

  stats(): ProfilerStats {
    const exporterStats = Object.fromEntries(
      this.runners.map((runner) => [runner.exporter.name, runner.stats()])
    );
    const all = Object.values(exporterStats);
    const pushedWindows = all.reduce((sum, item) => sum + item.exportedProfiles, 0);
    const failedWindows = all.reduce((sum, item) => sum + item.failedProfiles, 0);
    const lastPushAt = all.reduce<number | null>(
      (latest, item) =>
        item.lastSuccessAt !== null && (latest === null || item.lastSuccessAt > latest)
          ? item.lastSuccessAt
          : latest,
      null
    );
    const lastError = [...all].reverse().find((item) => item.lastError !== null)?.lastError ?? null;
    const streams = ["cpu"];
    if (this.config.wallTime.enabled) streams.push("wall");
    if (this.config.heap.enabled) streams.push("alloc_space");
    return {
      running: this.running,
      pushedWindows,
      failedWindows,
      emptyWindows: this.emptyWindows,
      lastPushAt,
      lastError,
      streams,
      capturedWindows: this.capturedWindows,
      capturedSamples: this.capturedSamples,
      captureFailures: this.captureFailures,
      lastCaptureGapMs: this.lastCaptureGapMs,
      maxCaptureGapMs: this.maxCaptureGapMs,
      lastConversionDurationMs: this.lastConversionDurationMs,
      currentSampleIntervalUs: this.currentSampleIntervalUs,
      samplingIntervalChanges: this.samplingIntervalChanges,
      exporters: exporterStats,
      memory: this.memoryStats(),
    };
  }

  private async adjustSamplingInterval(profile: CdpProfile, session: Session): Promise<void> {
    if (!this.config.adaptiveSampling.enabled) return;
    const durationUs = Math.max(1, profile.endTime - profile.startTime);
    const expectedSamples = durationUs / this.currentSampleIntervalUs;
    const utilization = (profile.samples?.length ?? 0) / Math.max(1, expectedSamples);
    const next =
      utilization >= this.config.adaptiveSampling.busyThreshold
        ? this.config.adaptiveSampling.busyIntervalUs
        : this.config.adaptiveSampling.idleIntervalUs;
    if (next === this.currentSampleIntervalUs) return;
    await session.post("Profiler.setSamplingInterval", { interval: next });
    this.currentSampleIntervalUs = next;
    this.samplingIntervalChanges++;
  }

  async tag<T>(extraLabels: Record<string, string>, fn: () => T | Promise<T>): Promise<Awaited<T>> {
    if (!this.running || !this.session) return (await fn()) as Awaited<T>;
    if (this.tagActive) {
      throw new ProfilerConcurrencyError(
        "overlapping tag() calls cannot be attributed safely on a process-wide sampler"
      );
    }
    this.tagActive = true;
    this.clearTimer();
    await this.activeCycle?.catch(() => undefined);
    const savedLabels = this.config.labels;
    this.config.labels = { ...savedLabels, ...extraLabels };
    try {
      // captureWindow snapshots the old window labels, then beginWindow reads
      // the newly installed tag labels before conversion starts.
      await this.captureWindow(true);
      return (await fn()) as Awaited<T>;
    } finally {
      this.clearTimer();
      this.config.labels = savedLabels;
      try {
        await this.captureWindow(true);
      } catch (error) {
        this.log("error", `Tagged window capture failed: ${error}`);
      }
      this.tagActive = false;
      if (this.running && !this.profileActive) {
        await this.beginWindow();
      }
      this.scheduleNextWindow();
    }
  }

  private memoryStats(): ProfilerMemoryStats {
    const memory = process.memoryUsage();
    const result: ProfilerMemoryStats = {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    };
    try {
      const jsc = this.jscHeapStats?.();
      if (jsc) {
        if (typeof jsc.heapSize === "number") result.jscHeapSizeBytes = jsc.heapSize;
        if (typeof jsc.heapCapacity === "number") result.jscHeapCapacityBytes = jsc.heapCapacity;
        if (typeof jsc.extraMemorySize === "number")
          result.jscExtraMemorySizeBytes = jsc.extraMemorySize;
      }
    } catch {
      // Memory metrics must never affect profiling.
    }
    return result;
  }

  private async detectJscHeapStats(): Promise<void> {
    if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return;
    try {
      const specifier = "bun:jsc";
      const mod = (await import(specifier)) as { heapStats?: () => Record<string, number> };
      if (mod.heapStats) this.jscHeapStats = mod.heapStats;
    } catch {
      // Node and older Bun versions do not provide this module.
    }
  }

  private installSignalHandlers(): void {
    if (this.signalHandlers) return;
    const shutdown = async (signal: NodeJS.Signals) => {
      this.log("debug", `Received ${signal}, flushing final profile...`);
      await this.stop().catch((error) => this.log("error", `Error during shutdown: ${error}`));
      process.kill(process.pid, signal);
    };
    const sigterm = () => void shutdown("SIGTERM");
    const sigint = () => void shutdown("SIGINT");
    this.signalHandlers = { sigterm, sigint };
    process.on("SIGTERM", sigterm);
    process.on("SIGINT", sigint);
  }

  private removeSignalHandlers(): void {
    if (!this.signalHandlers) return;
    process.removeListener("SIGTERM", this.signalHandlers.sigterm);
    process.removeListener("SIGINT", this.signalHandlers.sigint);
    this.signalHandlers = null;
  }

  private log(level: "debug" | "warn" | "error", message: string): void {
    if (level === "debug" && !this.config.debug) return;
    const formatted = `[bun-profiler] [${level.toUpperCase()}] ${message}`;
    if (level === "error") console.error(formatted);
    else if (level === "warn") console.warn(formatted);
    else console.log(formatted);
  }
}
