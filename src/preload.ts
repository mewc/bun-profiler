import { pprofFileExporter } from "./exporters.js";
import { BunPyroscope } from "./profiler.js";
import type { BunPyroscopeOptions } from "./types.js";

const PRELOAD_INSTANCE = Symbol.for("bun-profiler.preload-instance");
const state = globalThis as typeof globalThis & { [PRELOAD_INSTANCE]?: BunPyroscope };

if (!state[PRELOAD_INSTANCE]) {
  const overrides: Partial<BunPyroscopeOptions> = {};
  const outputDirectory = process.env.BUN_PROFILER_OUTPUT_DIR;
  if (outputDirectory) {
    const requested = process.env.BUN_PROFILER_OUTPUT_FORMAT ?? "pprof";
    if (requested !== "pprof" && requested !== "cpuprofile" && requested !== "speedscope") {
      throw new Error("BUN_PROFILER_OUTPUT_FORMAT must be pprof, cpuprofile, or speedscope");
    }
    overrides.exporters = [pprofFileExporter({ directory: outputDirectory, format: requested })];
  }
  const profiler = BunPyroscope.fromEnv(overrides);
  state[PRELOAD_INSTANCE] = profiler;
  let stopping = false;
  const flushBeforeExit = () => {
    if (stopping) return;
    stopping = true;
    process.removeListener("beforeExit", flushBeforeExit);
    void profiler.stop().catch((error) => {
      console.error("[bun-profiler] preload shutdown failed:", error);
      process.exitCode = 1;
    });
  };
  process.on("beforeExit", flushBeforeExit);
  profiler.start().catch((error) => {
    console.error("[bun-profiler] preload failed:", error);
    process.exitCode = 1;
  });
}

export default state[PRELOAD_INSTANCE];
