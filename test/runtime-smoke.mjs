import { BunPyroscope, callbackExporter } from "../dist/index.js";

let received = 0;
const profiler = new BunPyroscope({
  appName: "runtime-smoke",
  pushIntervalMs: 60_000,
  maxRetries: 0,
  heap: { enabled: true },
  exporters: [callbackExporter("memory", () => received++)],
});

await profiler.start();
const allocations = [];
let total = 0;
for (let i = 0; i < 2_000_000; i++) {
  total += Math.sqrt(i);
  if (i % 50_000 === 0) allocations.push({ i, value: "x".repeat(1_000) });
}
await profiler.stop();

const stats = profiler.stats();
if (!Number.isFinite(total) || received < 1 || stats.capturedWindows < 1) {
  throw new Error(`runtime smoke failed: ${JSON.stringify(stats)}`);
}
console.log(
  JSON.stringify({
    runtime: process.versions.bun ? `bun-${process.versions.bun}` : process.version,
    received,
  })
);
