import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "bun-profiler-worker-"));
process.env.BUN_PROFILER_OUTPUT_DIR = directory;
process.env.BUN_PROFILER_OUTPUT_FORMAT = "pprof";
process.env.PYROSCOPE_APPLICATION_NAME = "worker-preload-smoke";
process.env.PYROSCOPE_UPLOAD_INTERVAL = "60s";

const worker = new Worker(new URL("./fixtures/worker-workload.ts", import.meta.url).href, {
  preload: [new URL("../dist/preload.js", import.meta.url).pathname],
});
await new Promise<void>((resolve, reject) => {
  worker.onmessage = () => undefined;
  worker.onerror = (event) => reject(event.error ?? new Error(event.message));
  worker.addEventListener("close", () => resolve(), { once: true });
});
const files = (await readdir(directory)).filter((name) => name.endsWith(".pb.gz"));
if (files.length === 0) throw new Error("worker preload did not flush a pprof artifact");
console.log(JSON.stringify({ workerPreloadProfiles: files.length }));
