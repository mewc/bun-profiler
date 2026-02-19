/**
 * Smoke test — runs against a live Pyroscope instance.
 * Usage: bun smoke-test.ts [pyroscope-url]
 *
 * Example:
 *   bun smoke-test.ts http://localhost:4040
 */

import { BunPyroscope } from "./src/index";

const pyroscopeUrl = process.argv[2] ?? "http://localhost:4040";

console.log(`Connecting to Pyroscope at ${pyroscopeUrl}`);

const profiler = new BunPyroscope({
  pyroscopeUrl,
  appName: "bun-pyroscope-smoke-test",
  pushIntervalMs: 5_000, // push every 5s so you see results quickly
  debug: true,
});

await profiler.start();
console.log("Profiler started. Generating CPU load for 12 seconds...");

// Generate CPU work so there are meaningful frames in the flamegraph
function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

function heavyWork() {
  let total = 0;
  for (let i = 0; i < 50; i++) {
    total += fib(35);
  }
  return total;
}

// Run two push windows worth of work (5s each = 10s + buffer)
const start = Date.now();
while (Date.now() - start < 12_000) {
  heavyWork();
}

console.log("Work done. Stopping profiler (final flush)...");
await profiler.stop();
console.log(
  `\nDone! Open http://localhost:4040 in your browser and look for "bun-pyroscope-smoke-test"`
);
