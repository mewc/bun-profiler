import { Elysia } from "elysia";
import { BunPyroscope, renderPrometheusMetrics } from "bun-profiler";

const profiler = BunPyroscope.fromEnv();
await profiler.start();
new Elysia()
  .get("/health", () => profiler.stats())
  .get("/metrics", () => renderPrometheusMetrics(profiler))
  .listen(3000);
