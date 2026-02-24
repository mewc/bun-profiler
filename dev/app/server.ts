import { BunPyroscope } from "../../src/index";

const profiler = new BunPyroscope({
  pyroscopeUrl: "http://pyroscope:4040",
  appName: "bun-profiler-example",
  pushIntervalMs: 5_000,
  debug: true,
  compress: false,
  wallTime: { enabled: true },
});

await profiler.start();
console.log("[dev] Profiler started, pushing every 5s to http://pyroscope:4040");

function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": new Response(
      `<!DOCTYPE html>
<html>
<head><title>bun-profiler dev</title></head>
<body>
  <h1>bun-profiler dev server</h1>
  <ul>
    <li><a href="/cpu">/cpu</a> &mdash; generate CPU load (fibonacci)</li>
    <li><a href="/health">/health</a> &mdash; healthcheck</li>
  </ul>
  <h2>Dashboards</h2>
  <ul>
    <li><a href="http://localhost:4042">Pyroscope</a> (port 4042)</li>
    <li><a href="http://localhost:3003">Grafana</a> (port 3003)</li>
    <li><a href="http://localhost:9091">Prometheus</a> (port 9091)</li>
  </ul>
</body>
</html>`,
      { headers: { "Content-Type": "text/html" } },
    ),

    "/cpu": () => {
      const start = performance.now();
      let result = 0;
      for (let i = 0; i < 10; i++) {
        result += fib(35);
      }
      const elapsed = (performance.now() - start).toFixed(1);
      return new Response(`fib(35) x10 = ${result} (${elapsed}ms)\n`);
    },

    "/health": () => Response.json({ status: "ok" }),
  },
});

console.log(`[dev] Bun server listening on http://localhost:${server.port}`);
