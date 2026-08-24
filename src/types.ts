/** Chrome DevTools Protocol profile types returned by node:inspector. */
export interface CdpCallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CdpNode {
  id: number;
  callFrame: CdpCallFrame;
  hitCount?: number;
  children?: number[];
}

export interface CdpProfile {
  nodes: CdpNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface HeapProfileNode {
  callFrame: CdpCallFrame;
  selfSize: number;
  id: number;
  children: HeapProfileNode[];
}

export interface SamplingHeapProfile {
  head: HeapProfileNode;
}

export type ProfileType = "cpu" | "wall" | "alloc_space";

/**
 * An immutable completed profiling window delivered to exporters.
 *
 * The wrapper and labels are frozen. The CDP payload is treated as readonly but
 * is not recursively frozen because doing that on every window would itself add
 * measurable profiler overhead.
 */
export interface ProfileWindow {
  readonly type: ProfileType;
  readonly appName: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly from: number;
  readonly until: number;
  readonly sampleRate: number;
  readonly sampleIntervalUs: number;
  readonly folded: string;
  readonly profile: CdpProfile | SamplingHeapProfile;
}

/** A destination that receives completed windows. Calls are serialized per exporter. */
export interface ProfileExporter {
  /** Stable identifier used in stats and Prometheus labels. */
  readonly name: string;
  export(window: ProfileWindow, signal?: AbortSignal): Promise<void>;
  shutdown?(): Promise<void>;
}

export type PyroscopeFormat = "folded" | "pprof";

export interface PyroscopeExporterOptions {
  url: string;
  authToken?: string;
  basicAuth?: { username: string; password: string };
  tenantId?: string;
  headers?: Record<string, string>;
  /** pprof is currently CPU-only; wall and allocation windows remain folded. */
  format?: PyroscopeFormat;
  /** Gzip folded bodies. Off by default because legacy /ingest may silently discard them. */
  compress?: boolean;
  /** Abort one HTTP attempt after this duration. Default: 10000. */
  timeoutMs?: number;
  name?: string;
}

export interface PprofFileExporterOptions {
  directory: string;
  /** File format. pprof files are gzip-compressed protobuf. */
  format?: "pprof" | "cpuprofile" | "speedscope";
  name?: string;
}

export interface BunPyroscopeOptions {
  /** Existing shorthand destination. Required unless exporters are supplied. */
  pyroscopeUrl?: string;
  appName?: string;
  sampleIntervalUs?: number;
  pushIntervalMs?: number;
  labels?: Record<string, string>;
  authToken?: string;
  basicAuth?: { username: string; password: string };
  tenantId?: string;
  /** Additional request headers for the shorthand Pyroscope destination. */
  headers?: Record<string, string>;
  maxRetries?: number;
  maxPendingWindows?: number;
  shutdownTimeoutMs?: number;
  /** Per-attempt deadline for the shorthand Pyroscope exporter. Default: 10000. */
  exportTimeoutMs?: number;
  debug?: boolean;
  compress?: boolean;
  /** Encoding used by the shorthand Pyroscope destination. Default: folded. */
  pyroscopeFormat?: PyroscopeFormat;
  /** Explicit destinations. A pyroscopeUrl, when also present, is added first. */
  exporters?: readonly ProfileExporter[];
  heap?: { enabled: boolean; samplingIntervalBytes?: number };
  wallTime?: { enabled: boolean };
  sourceMaps?: { enabled: boolean; cacheSize?: number };
  adaptiveSampling?: {
    enabled: boolean;
    busyIntervalUs?: number;
    idleIntervalUs?: number;
    /** Fraction of expected samples that selects the busy interval. Default: 0.25. */
    busyThreshold?: number;
  };
}

export interface ExporterStats {
  exportedProfiles: number;
  failedProfiles: number;
  retries: number;
  droppedProfiles: number;
  queueDepth: number;
  inFlight: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastExportDurationMs: number | null;
  exportedBytes: number;
}

export interface ProfilerMemoryStats {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  /** Bun/JSC values are present only when bun:jsc.heapStats is available. */
  jscHeapSizeBytes?: number;
  jscHeapCapacityBytes?: number;
  jscExtraMemorySizeBytes?: number;
}

export interface ProfilerStats {
  running: boolean;
  /** Backwards-compatible aggregate exporter success count. */
  pushedWindows: number;
  /** Backwards-compatible aggregate final failure count. */
  failedWindows: number;
  emptyWindows: number;
  lastPushAt: number | null;
  lastError: string | null;
  streams: string[];
  capturedWindows: number;
  capturedSamples: number;
  captureFailures: number;
  lastCaptureGapMs: number | null;
  maxCaptureGapMs: number;
  lastConversionDurationMs: number | null;
  currentSampleIntervalUs: number;
  samplingIntervalChanges: number;
  exporters: Record<string, ExporterStats>;
  memory: ProfilerMemoryStats;
}

export interface ResolvedConfig {
  pyroscopeUrl: string | undefined;
  appName: string;
  sampleIntervalUs: number;
  pushIntervalMs: number;
  labels: Record<string, string>;
  authToken: string | undefined;
  basicAuth: { username: string; password: string } | undefined;
  tenantId: string | undefined;
  headers: Record<string, string>;
  maxRetries: number;
  maxPendingWindows: number;
  shutdownTimeoutMs: number;
  exportTimeoutMs: number;
  debug: boolean;
  compress: boolean;
  pyroscopeFormat: PyroscopeFormat;
  exporters: readonly ProfileExporter[];
  heap: { enabled: boolean; samplingIntervalBytes: number };
  wallTime: { enabled: boolean };
  sourceMaps: { enabled: boolean; cacheSize: number };
  adaptiveSampling: {
    enabled: boolean;
    busyIntervalUs: number;
    idleIntervalUs: number;
    busyThreshold: number;
  };
}

export interface PprofEncodeOptions {
  sampleIntervalUs?: number;
  /** UNIX time in nanoseconds. Defaults to the current time. */
  timeNanos?: string | number;
  /** Profile duration in nanoseconds. Defaults to the CDP duration. */
  durationNanos?: string | number;
}
