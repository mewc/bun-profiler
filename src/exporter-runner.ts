import { ExporterError } from "./errors.js";
import { retryDelayMs } from "./retry.js";
import type { ExporterStats, ProfileExporter, ProfileWindow } from "./types.js";

interface QueueEntry {
  window: ProfileWindow;
}

export class ExporterRunner {
  readonly exporter: ProfileExporter;
  private readonly maxPending: number;
  private readonly maxRetries: number;
  private readonly debug: (message: string) => void;
  private readonly random: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly queue: QueueEntry[] = [];
  private active: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private stopping = false;
  private idleWaiters: Array<() => void> = [];
  private exportedProfiles = 0;
  private failedProfiles = 0;
  private retries = 0;
  private droppedProfiles = 0;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private lastExportDurationMs: number | null = null;
  private exportedBytes = 0;

  constructor(
    exporter: ProfileExporter,
    options: {
      maxPending: number;
      maxRetries: number;
      debug: (message: string) => void;
      random?: () => number;
      wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    }
  ) {
    this.exporter = exporter;
    this.maxPending = options.maxPending;
    this.maxRetries = options.maxRetries;
    this.debug = options.debug;
    this.random = options.random ?? Math.random;
    this.wait = options.wait ?? sleep;
  }

  enqueue(window: ProfileWindow): void {
    if (this.stopping) {
      this.droppedProfiles++;
      this.lastError = "exporter is shutting down; profile dropped";
      return;
    }
    if (this.queue.length >= this.maxPending) {
      this.queue.shift();
      this.droppedProfiles++;
      this.lastError = "export queue full; dropped oldest profile";
    }
    this.queue.push({ window });
    this.startDrain();
  }

  private startDrain(): void {
    if (this.active) return;
    this.active = this.drain().finally(() => {
      this.active = null;
      if (this.queue.length > 0) this.startDrain();
      else this.resolveIdle();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopping && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) continue;
      let finalError: Error | null = null;
      const started = performance.now();
      this.activeController = new AbortController();
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) {
          this.retries++;
          const retryAfterMs =
            finalError instanceof ExporterError ? finalError.retryAfterMs : undefined;
          const delayMs = retryDelayMs(attempt, retryAfterMs, this.random);
          this.debug(`${this.exporter.name}: retry ${attempt}/${this.maxRetries} in ${delayMs}ms`);
          try {
            await this.wait(delayMs, this.activeController.signal);
          } catch (error) {
            finalError = error instanceof Error ? error : new Error(String(error));
            break;
          }
        }
        try {
          await this.exporter.export(entry.window, this.activeController.signal);
          this.exportedProfiles++;
          this.lastSuccessAt = Date.now();
          this.lastError = null;
          this.lastExportDurationMs = performance.now() - started;
          this.exportedBytes += new TextEncoder().encode(entry.window.folded).byteLength;
          finalError = null;
          break;
        } catch (error) {
          finalError = error instanceof Error ? error : new Error(String(error));
          const retryable = !(error instanceof ExporterError) || error.retryable;
          if (!retryable) break;
        }
      }
      this.activeController = null;
      if (finalError && !this.stopping) {
        this.failedProfiles++;
        this.lastError = finalError.message;
        this.lastExportDurationMs = performance.now() - started;
      }
    }
  }

  stats(): ExporterStats {
    return {
      exportedProfiles: this.exportedProfiles,
      failedProfiles: this.failedProfiles,
      retries: this.retries,
      droppedProfiles: this.droppedProfiles,
      queueDepth: this.queue.length,
      inFlight: this.active !== null,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      lastExportDurationMs: this.lastExportDurationMs,
      exportedBytes: this.exportedBytes,
    };
  }

  async waitForIdle(): Promise<void> {
    if (!this.active && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  abortAndDrop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.activeController?.abort();
    this.droppedProfiles += this.queue.length + (this.active ? 1 : 0);
    this.queue.length = 0;
    this.lastError = "shutdown timeout; pending profiles dropped";
  }

  async shutdown(): Promise<void> {
    await this.exporter.shutdown?.();
  }

  private resolveIdle(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ExporterError("export aborted", { retryable: false }));
      },
      { once: true }
    );
  });
}
