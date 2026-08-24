import { Worker } from "node:worker_threads";
import { callbackExporter } from "../src/exporters.ts";
import { encodePprof } from "../src/pprof.ts";
import { BunPyroscope } from "../src/profiler.ts";
import type { BunPyroscopeOptions, CdpProfile } from "../src/types.ts";
import { runFibonacci } from "./app/workloads/cpu.ts";

const rounds = Number(process.env.BENCH_ROUNDS ?? 8);

function workload(): number {
  return runFibonacci(31, 8);
}

function measure(): number {
  const started = performance.now();
  for (let i = 0; i < rounds; i++) workload();
  return performance.now() - started;
}

async function profiled(
  name: string,
  options: Partial<BunPyroscopeOptions> = {}
): Promise<{ name: string; elapsedMs: number; gapMs: number; rssBytes: number }> {
  const profiler = new BunPyroscope({
    appName: `bun-profiler-benchmark-${name}`,
    exporters: [callbackExporter("discard", () => undefined)],
    pushIntervalMs: 25,
    ...options,
  });
  await profiler.start();
  const started = performance.now();
  for (let i = 0; i < rounds; i++) workload();
  await profiler.stop();
  const stats = profiler.stats();
  return {
    name,
    elapsedMs: performance.now() - started,
    gapMs: stats.lastCaptureGapMs ?? 0,
    rssBytes: stats.memory.rssBytes,
  };
}

measure();
const baseline = measure();
const cases = [
  await profiled("cpu"),
  await profiled("cpu-wall", { wallTime: { enabled: true } }),
  await profiled("pprof", {
    exporters: [
      callbackExporter("pprof-encode", (window) => {
        if (window.type === "cpu") {
          encodePprof(window.profile as CdpProfile, { sampleIntervalUs: window.sampleIntervalUs });
        }
      }),
    ],
  }),
];

const workerResult = await new Promise<{ elapsedMs: number; gapMs: number; rssBytes: number }>(
  (resolve, reject) => {
    const worker = new Worker(new URL("./bench-worker.ts", import.meta.url));
    worker.once("message", resolve);
    worker.once("error", reject);
  }
);
cases.push({ name: "selected-worker", ...workerResult });

console.table(
  [
    { name: "unprofiled", elapsedMs: baseline, gapMs: 0, rssBytes: process.memoryUsage().rss },
    ...cases,
  ].map((result) => ({
    configuration: result.name,
    elapsed_ms: result.elapsedMs.toFixed(2),
    overhead_percent: (((result.elapsedMs - baseline) / baseline) * 100).toFixed(2),
    capture_gap_ms: result.gapMs.toFixed(3),
    rss_mb: (result.rssBytes / 1024 / 1024).toFixed(1),
  }))
);
