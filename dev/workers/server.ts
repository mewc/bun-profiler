const workerUrl = new URL("./worker.ts", import.meta.url).href;
// Bun's inspector CPU sampler is process-wide today: two worker-local inspector
// sessions race over the same Profiler domain. Profile one selected worker and
// leave other workers uninstrumented until Bun provides isolate-scoped sessions.
const profiledWorker = new Worker(`${workerUrl}?kind=fibonacci`, {
  preload: ["./src/preload.ts"],
});
const unprofiledWorker = new Worker(`${workerUrl}?kind=hash`);
const workers = [profiledWorker, unprofiledWorker];

for (const worker of workers) worker.postMessage("start");

const port = Number(process.env.WORKER_PORT ?? 3004);
Bun.serve({
  port,
  routes: {
    "/": () =>
      Response.json({
        workers: workers.length,
        profiledWorkers: 1,
        streams: "the selected worker stream is labeled by worker_id",
        limitation: "Bun currently exposes one process-wide inspector CPU profiler",
      }),
  },
});
console.log(`[worker-demo] one selected worker profiled on http://localhost:${port}`);
