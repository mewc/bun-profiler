import { createServer } from "node:http";
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

const HTML = `<!DOCTYPE html>
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
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
  } else if (url.pathname === "/cpu") {
    const start = performance.now();
    let result = 0;
    for (let i = 0; i < 10; i++) {
      result += fib(35);
    }
    const elapsed = (performance.now() - start).toFixed(1);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`fib(35) x10 = ${result} (${elapsed}ms)\n`);
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404);
    res.end("Not Found\n");
  }
});

server.listen(3000, () => {
  console.log("[dev] HTTP server listening on http://localhost:3000");
});
