import { parentPort } from "node:worker_threads";
import { callbackExporter } from "../src/exporters.ts";
import { BunPyroscope } from "../src/profiler.ts";
import { runFibonacci } from "./app/workloads/cpu.ts";

const rounds = Number(process.env.BENCH_ROUNDS ?? 8);
const profiler = new BunPyroscope({
  appName: "bun-profiler-benchmark-worker",
  exporters: [callbackExporter("discard", () => undefined)],
  pushIntervalMs: 25,
});
await profiler.start();
const started = performance.now();
for (let i = 0; i < rounds; i++) runFibonacci(31, 8);
await profiler.stop();
const stats = profiler.stats();
parentPort?.postMessage({
  elapsedMs: performance.now() - started,
  gapMs: stats.lastCaptureGapMs ?? 0,
  rssBytes: stats.memory.rssBytes,
});
