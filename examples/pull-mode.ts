import { createPprofHandler } from "bun-profiler";

// Pull mode owns the sampler, so do not start continuous profiling in this process.
const pprof = createPprofHandler({ defaultDurationSeconds: 10, maxDurationSeconds: 60 });

Bun.serve({
  routes: {
    "/debug/pprof/profile": pprof,
  },
});
