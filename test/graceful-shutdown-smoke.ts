import { spawn } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "bun-profiler-signal-"));
const child = spawn(
  process.execPath,
  [
    "--preload",
    new URL("../dist/preload.js", import.meta.url).pathname,
    new URL("./fixtures/signal-target.ts", import.meta.url).pathname,
  ],
  {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      BUN_PROFILER_OUTPUT_DIR: directory,
      BUN_PROFILER_OUTPUT_FORMAT: "pprof",
      PYROSCOPE_APPLICATION_NAME: "signal-shutdown-smoke",
      PYROSCOPE_UPLOAD_INTERVAL: "60s",
    },
  }
);
await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.stdout?.once("data", () => resolve());
});
await new Promise((resolve) => setTimeout(resolve, 150));
child.kill("SIGTERM");
await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", () => resolve());
});
const files = (await readdir(directory)).filter((name) => name.endsWith(".pb.gz"));
if (files.length === 0) throw new Error("SIGTERM shutdown did not flush a pprof artifact");
console.log(JSON.stringify({ gracefulShutdownProfiles: files.length }));
