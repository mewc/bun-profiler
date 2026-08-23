#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureHeapSnapshot } from "./memory.js";

function usage(): never {
  console.error(`Usage:
  bun-profiler run [--out DIR] [--format pprof|cpuprofile|speedscope] -- script.ts [args...]
  bun-profiler heap-snapshot [output.heapsnapshot]`);
  process.exit(2);
}

async function run(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "heap-snapshot") {
    const output = await captureHeapSnapshot(args[0]);
    console.log(output);
    return;
  }
  if (command !== "run") usage();

  let outputDirectory: string | undefined;
  let format: string | undefined;
  let separator = args.indexOf("--");
  if (separator < 0) separator = args.findIndex((arg) => !arg.startsWith("--"));
  const flags = separator < 0 ? args : args.slice(0, separator);
  const target = separator < 0 ? [] : args.slice(separator + (args[separator] === "--" ? 1 : 0));
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--out") outputDirectory = flags[++i];
    else if (flags[i] === "--format") format = flags[++i];
    else usage();
  }
  if (target.length === 0) usage();
  if (!process.env.PYROSCOPE_SERVER_ADDRESS && !outputDirectory) {
    throw new Error("set PYROSCOPE_SERVER_ADDRESS or pass --out DIR");
  }

  const preload = fileURLToPath(new URL("./preload.js", import.meta.url));
  const child = spawn(process.execPath, ["--preload", preload, ...target], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(outputDirectory ? { BUN_PROFILER_OUTPUT_DIR: outputDirectory } : {}),
      ...(format ? { BUN_PROFILER_OUTPUT_FORMAT: format } : {}),
    },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
}

await run().catch((error) => {
  console.error(`[bun-profiler] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
