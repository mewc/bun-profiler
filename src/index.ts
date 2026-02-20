export { BunPyroscope } from "./profiler.js";
export type {
  BunPyroscopeOptions,
  CdpCallFrame,
  CdpNode,
  CdpProfile,
  HeapProfileNode,
  SamplingHeapProfile,
} from "./types.js";

import { BunPyroscope } from "./profiler.js";
import type { BunPyroscopeOptions } from "./types.js";

/**
 * Convenience: create and start a profiler in one call.
 * Returns the BunPyroscope instance so the caller can stop() it later.
 *
 * @example
 * import { startProfiling } from "bun-pyroscope";
 * startProfiling({ pyroscopeUrl: "http://localhost:4040" });
 */
export function startProfiling(options: BunPyroscopeOptions): BunPyroscope {
  const profiler = new BunPyroscope(options);
  profiler.start().catch((err: unknown) => {
    console.error("[bun-pyroscope] Failed to start profiling:", err);
  });
  return profiler;
}
