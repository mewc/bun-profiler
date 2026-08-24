/** Capture an on-demand V8-format heap snapshot on Bun. Never called periodically. */
export async function captureHeapSnapshot(
  path = `heap-${Date.now()}.heapsnapshot`
): Promise<string> {
  // Cast through `unknown`: bun-types' ambient `Bun.generateHeapSnapshot` overloads
  // differ across Bun releases (e.g. 1.3.14 vs 1.3.7), so asserting directly on
  // `globalThis` fails typecheck on some supported versions. We runtime-guard the
  // shape below, so the loose local type is safe.
  const runtime = (
    globalThis as unknown as {
      Bun?: {
        generateHeapSnapshot(format: "v8", encoding: "arraybuffer"): ArrayBuffer;
        write(path: string, data: ArrayBuffer): Promise<number>;
      };
    }
  ).Bun;
  if (!runtime?.generateHeapSnapshot || !runtime.write) {
    throw new Error("[bun-profiler] Heap snapshots require Bun.generateHeapSnapshot");
  }
  const snapshot = runtime.generateHeapSnapshot("v8", "arraybuffer");
  await runtime.write(path, snapshot);
  return path;
}
