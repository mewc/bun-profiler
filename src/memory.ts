/** Capture an on-demand V8-format heap snapshot on Bun. Never called periodically. */
export async function captureHeapSnapshot(
  path = `heap-${Date.now()}.heapsnapshot`
): Promise<string> {
  const runtime = (
    globalThis as {
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
