/**
 * CDP (Chrome DevTools Protocol) types — the format returned by
 * node:inspector's Profiler.stop() on Bun (JavaScriptCore).
 */

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
  /** IDs of child nodes in the call tree */
  children?: number[];
}

/**
 * Full CDP CPU profile as returned by Profiler.stop().
 * startTime and endTime are in microseconds since an arbitrary epoch.
 * samples[i] is the leaf node ID for sample i.
 * timeDeltas[i] is microseconds elapsed since the previous sample.
 */
export interface CdpProfile {
  nodes: CdpNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/**
 * A node in a V8 sampling heap profile tree.
 */
export interface HeapProfileNode {
  callFrame: CdpCallFrame;
  selfSize: number;
  id: number;
  children: HeapProfileNode[];
}

/**
 * Sampling heap profile as returned by HeapProfiler.stopSampling().
 */
export interface SamplingHeapProfile {
  head: HeapProfileNode;
}

/**
 * Constructor options for BunPyroscope.
 */
export interface BunPyroscopeOptions {
  /**
   * Full URL of the Pyroscope server, e.g. "http://localhost:4040"
   */
  pyroscopeUrl: string;

  /**
   * Application name for the profile stream.
   * Falls back to SERVICE_NAME env var, then npm_package_name env var, then "bun-app".
   */
  appName?: string;

  /**
   * How often the profiler samples the call stack, in microseconds.
   * Passed directly to Profiler.setSamplingInterval.
   * Default: 10000 (10ms).
   */
  sampleIntervalUs?: number;

  /**
   * How often to stop, flush, and restart the profiler, in milliseconds.
   * Default: 15000 (15 seconds).
   */
  pushIntervalMs?: number;

  /**
   * Extra labels merged with (and overriding) auto-detected defaults.
   */
  labels?: Record<string, string>;

  /**
   * Bearer token for Pyroscope authentication.
   * Produces header: Authorization: Bearer <token>
   */
  authToken?: string;

  /**
   * Basic auth credentials.
   * Produces header: Authorization: Basic base64(username:password)
   */
  basicAuth?: {
    username: string;
    password: string;
  };

  /**
   * Number of times to retry a failed push before dropping the window.
   * Profiling continues regardless of push failures.
   * Default: 2
   */
  maxRetries?: number;

  /**
   * Whether to log debug information to stderr.
   * Default: false
   */
  debug?: boolean;

  /**
   * Heap allocation sampling options (opt-in).
   */
  heap?: {
    enabled: boolean;
    /** Bytes between samples. Default: 32768 (32 KB, V8 default). */
    samplingIntervalBytes?: number;
  };

  /**
   * Wall-time profiling options (opt-in).
   *
   * When enabled, pushes an additional "wall" profile stream alongside CPU.
   * Wall-time profiles weight stacks by elapsed wall-clock microseconds
   * (via CDP timeDeltas) rather than sample count, and keep "(idle)" frames
   * visible so I/O wait time appears in flamegraphs.
   *
   * This is the highest-value profiling mode for I/O-heavy servers that spend
   * most time waiting on external APIs, databases, or network calls.
   */
  wallTime?: {
    enabled: boolean;
  };
}

/** Internal fully-resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  pyroscopeUrl: string;
  appName: string;
  sampleIntervalUs: number;
  pushIntervalMs: number;
  labels: Record<string, string>;
  authToken: string | undefined;
  basicAuth: { username: string; password: string } | undefined;
  maxRetries: number;
  debug: boolean;
  heap: { enabled: boolean; samplingIntervalBytes: number };
  wallTime: { enabled: boolean };
}
