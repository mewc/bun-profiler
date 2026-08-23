import {
  BunPyroscope,
  createPprofHandler,
  renderPrometheusMetrics,
} from "bun-profiler";

// Continuous push mode:
const profiler = BunPyroscope.fromEnv();
await profiler.start();

Bun.serve({
  routes: {
    "/health": () => Response.json(profiler.stats()),
    "/metrics": () =>
      new Response(renderPrometheusMetrics(profiler), {
        headers: { "Content-Type": "text/plain; version=0.0.4" },
      }),
  },
});

// For pull-only mode, do not start BunPyroscope. Instead register:
// const pprof = createPprofHandler();
// Bun.serve({ routes: { "/debug/pprof/profile": pprof } });
void createPprofHandler;
