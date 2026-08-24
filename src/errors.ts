export class ProfilerConfigError extends Error {
  constructor(message: string) {
    super(`[bun-profiler] Invalid configuration: ${message}`);
    this.name = "ProfilerConfigError";
  }
}

export class ProfilerConcurrencyError extends Error {
  constructor(message: string) {
    super(`[bun-profiler] ${message}`);
    this.name = "ProfilerConcurrencyError";
  }
}

export class ExporterError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { retryable?: boolean; status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "ExporterError";
    this.retryable = options.retryable ?? true;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ExportQueueError extends Error {
  constructor(message: string) {
    super(`[bun-profiler] ${message}`);
    this.name = "ExportQueueError";
  }
}
