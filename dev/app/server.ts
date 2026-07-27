/**
 * bun-profiler demo server.
 *
 * Runs the profiler against the local Pyroscope, exposes a set of workloads
 * with deliberately distinct flamegraph shapes, and serves a control panel at
 * "/" so you can drive them from a browser.
 */

import { BunPyroscope } from "../../src/index.ts";
import { recordRequest, renderMetrics } from "./metrics.ts";
import { renderPanel } from "./panel.ts";
import { echo, WORKLOADS } from "./workloads/index.ts";

const PYROSCOPE_URL = process.env.PYROSCOPE_URL ?? "http://pyroscope:4040";
const APP_NAME = process.env.SERVICE_NAME ?? "bun-profiler-demo";
const PORT = Number(process.env.PORT ?? 3000);
const PUSH_INTERVAL_MS = Number(process.env.PUSH_INTERVAL_MS ?? 5_000);

// Published ports differ per checkout (Conductor gives each workspace its own
// range), so compose passes the host-side URLs in rather than the panel
// guessing them.
const PANEL_LINKS = {
  grafana: process.env.PUBLIC_GRAFANA_URL ?? "http://localhost:3003",
  pyroscope: process.env.PUBLIC_PYROSCOPE_URL ?? "http://localhost:4042",
  prometheus: process.env.PUBLIC_PROMETHEUS_URL ?? "http://localhost:9091",
};

const profiler = new BunPyroscope({
  pyroscopeUrl: PYROSCOPE_URL,
  appName: APP_NAME,
  pushIntervalMs: PUSH_INTERVAL_MS,
  debug: true,
  wallTime: { enabled: true },
  labels: { demo: "true" },
});

await profiler.start();
console.log(`[demo] profiler → ${PYROSCOPE_URL} as "${APP_NAME}" every ${PUSH_INTERVAL_MS}ms`);

/** Wrap a handler with timing + Prometheus accounting. */
async function handle(
  route: string,
  fn: () => Promise<unknown> | unknown
): Promise<Response> {
  const started = performance.now();
  let status = 200;
  try {
    const result = await fn();
    return Response.json({ route, ms: Math.round(performance.now() - started), result });
  } catch (err) {
    status = 500;
    return Response.json({ route, error: String(err) }, { status });
  } finally {
    recordRequest(route, status, performance.now() - started);
  }
}

const routes: Record<string, (req: Request) => Promise<Response> | Response> = {
  "/": () =>
    new Response(renderPanel(APP_NAME, PYROSCOPE_URL, PANEL_LINKS), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),

  "/metrics": () =>
    new Response(renderMetrics(), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    }),

  // Reports the profiler's own delivery state, not just "the process is up".
  // A profiler that has stopped pushing is otherwise indistinguishable from an
  // idle one, which is exactly how the gzip bug hid for so long.
  "/health": () => {
    const profiling = profiler.stats();

    // Deliberately not "nothing pushed recently": an idle process produces no
    // samples, so silence is normal and would flap the container healthcheck.
    // What is never normal is the loop being dead, or every push failing.
    //
    // Note this cannot catch a server that accepts a push and stores nothing
    // (the gzip case answered HTTP 200), which is why that is handled by
    // defaulting compress off rather than by monitoring.
    const degraded =
      !profiling.running || (profiling.pushedWindows === 0 && profiling.failedWindows > 0);

    return Response.json(
      { status: degraded ? "degraded" : "ok", app: APP_NAME, profiling },
      { status: degraded ? 503 : 200 }
    );
  },

  "/api/io/echo": (req) => handle("/api/io/echo", () => echo(new URL(req.url))),
};

// Workloads that call back into this server must use the in-container address.
// req.url carries the *client's* view of the host (e.g. localhost:3002, the
// published port), which is not reachable from inside the container.
const SELF_URL = `http://127.0.0.1:${PORT}`;

for (const workload of WORKLOADS) {
  routes[workload.path] = (req) => {
    const url = new URL(req.url);
    return handle(workload.path, () => workload.run(url, SELF_URL));
  };
}

const server = Bun.serve({ port: PORT, routes });

console.log(`[demo] listening on http://localhost:${server.port}`);
console.log(`[demo] ${WORKLOADS.length} workloads registered`);
