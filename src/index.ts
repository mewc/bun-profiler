// The converters are exported so callers can post-process or inspect profiles
// themselves; only convertToFoldedWallTime used to be, which was inconsistent.

export { optionsFromEnv, parseLabels } from "./config.js";
export {
  calculateSampleRate,
  convertHeapToFolded,
  convertToFolded,
  convertToFoldedWallTime,
  IDLE_FRAME,
} from "./converter.js";
export {
  ExporterError,
  ExportQueueError,
  ProfilerConcurrencyError,
  ProfilerConfigError,
} from "./errors.js";
export { callbackExporter, pprofFileExporter, pyroscopeExporter } from "./exporters.js";
export { captureHeapSnapshot } from "./memory.js";
export { renderPrometheusMetrics } from "./metrics.js";
export { decodePprof, encodePprof } from "./pprof.js";
export { BunPyroscope } from "./profiler.js";
export type { PprofPullHandlerOptions } from "./pull.js";
export { createPprofHandler } from "./pull.js";
export { SourceMapResolver } from "./source-maps.js";
export { convertToSpeedscope } from "./speedscope.js";
export type {
  BunPyroscopeOptions,
  CdpCallFrame,
  CdpNode,
  CdpProfile,
  ExporterStats,
  HeapProfileNode,
  PprofEncodeOptions,
  PprofFileExporterOptions,
  ProfileExporter,
  ProfilerStats,
  ProfileType,
  ProfileWindow,
  PyroscopeExporterOptions,
  SamplingHeapProfile,
} from "./types.js";

import { BunPyroscope } from "./profiler.js";
import type { BunPyroscopeOptions } from "./types.js";

/**
 * Convenience: create and start a profiler in one call.
 * Returns the BunPyroscope instance so the caller can stop() it later.
 *
 * @example
 * import { startProfiling } from "bun-profiler";
 * startProfiling({ pyroscopeUrl: "http://localhost:4040" });
 */
export function startProfiling(options: BunPyroscopeOptions): BunPyroscope {
  const profiler = new BunPyroscope(options);
  profiler.start().catch((err: unknown) => {
    console.warn("[bun-profiler] Failed to start profiling:", err);
  });
  return profiler;
}

export function startProfilingFromEnv(overrides: Partial<BunPyroscopeOptions> = {}): BunPyroscope {
  const profiler = BunPyroscope.fromEnv(overrides);
  profiler.start().catch((err: unknown) => {
    console.warn("[bun-profiler] Failed to start profiling:", err);
  });
  return profiler;
}
