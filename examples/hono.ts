import { Hono } from "hono";
import { BunPyroscope, renderPrometheusMetrics } from "bun-profiler";

const app = new Hono();
const profiler = BunPyroscope.fromEnv();
await profiler.start();
app.get("/health", (context) => context.json(profiler.stats()));
app.get("/metrics", (context) => context.text(renderPrometheusMetrics(profiler)));

export default app;
