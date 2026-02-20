import type { CdpProfile, HeapProfileNode, SamplingHeapProfile } from "./types.js";

/**
 * Frames that should be excluded from folded stacks.
 * - "(root)" is always the tree root — not a real frame.
 * - "(idle)" indicates the event loop had nothing to do.
 * - node:inspector frames are the profiler's own overhead.
 */
function shouldSkipFrame(functionName: string, url: string): boolean {
  if (functionName === "(root)" || functionName === "(idle)") return true;
  if (url === "node:inspector") return true;
  return false;
}

/**
 * Whether this node marks the root of the tree (walk should stop here).
 */
function isRoot(functionName: string): boolean {
  return functionName === "(root)";
}

/**
 * Format a CDP call frame as a human-readable label for flamegraphs.
 *
 * Format:
 *   "funcName (shortUrl:line)"  — when url and lineNumber are available
 *   "funcName (shortUrl)"       — when url but no valid lineNumber
 *   "funcName"                  — when no url
 *   "(anonymous) ..."           — when functionName is empty
 *
 * URL shortening: strip "file://" prefix, keep last 2 path segments.
 * This avoids /home/user/project/src/... noise in flamegraph labels.
 */
function frameLabel(callFrame: { functionName: string; url: string; lineNumber: number }): string {
  const name = callFrame.functionName.trim() || "(anonymous)";

  if (!callFrame.url) return name;

  let shortUrl = callFrame.url;
  if (shortUrl.startsWith("file://")) {
    shortUrl = shortUrl.slice(7);
    const parts = shortUrl.split("/");
    shortUrl = parts.slice(-2).join("/");
  }

  if (callFrame.lineNumber >= 0) {
    return `${name} (${shortUrl}:${callFrame.lineNumber})`;
  }
  return `${name} (${shortUrl})`;
}

/**
 * Convert a CDP CPU profile to Pyroscope's folded/collapsed stack format.
 *
 * The CDP profile encodes call stacks as a tree where each CdpNode has
 * an optional `children` array of child node IDs. `profile.samples` is
 * a flat array of leaf node IDs — one per sample.
 *
 * Algorithm:
 *   1. Build nodeMap: id → CdpNode                          O(n)
 *   2. Build parentMap: childId → parentId                  O(n)
 *      (iterate nodes; for each children[i], set parentMap[child] = node.id)
 *   3. For each leaf nodeId in samples[]:
 *      a. Walk leaf → root via parentMap
 *      b. Collect frame labels, skipping noise frames
 *      c. Stop walk at (root) frame
 *      d. Reverse → root-to-leaf order, join with ";"
 *      e. Count occurrences in a Map
 *   4. Serialize as "stack count\n" lines
 *
 * Output example:
 *   "outer (handler.ts:10);inner (handler.ts:5) 42\ncacheSatisfyAndReturn 8"
 *
 * @returns Folded stack string, or "" if the profile has no usable samples.
 */
export function convertToFolded(profile: CdpProfile): string {
  const { nodes, samples } = profile;

  if (!samples || samples.length === 0) return "";

  // Step 1: id → node
  const nodeMap = new Map<number, (typeof nodes)[number]>();
  for (const node of nodes) nodeMap.set(node.id, node);

  // Step 2: child → parent (inverse of the children[] edges)
  const parentMap = new Map<number, number>();
  for (const node of nodes) {
    if (node.children) {
      for (const childId of node.children) {
        parentMap.set(childId, node.id);
      }
    }
  }

  // Steps 3-4
  const stackCounts = new Map<string, number>();
  const MAX_DEPTH = 512; // safety cap against malformed profiles

  for (const leafId of samples) {
    const frames: string[] = [];
    let currentId: number | undefined = leafId;
    let depth = 0;

    while (currentId !== undefined && depth < MAX_DEPTH) {
      const node = nodeMap.get(currentId);
      if (!node) break;

      const { functionName, url } = node.callFrame;

      // Stop collecting when we reach the tree root
      if (isRoot(functionName)) break;

      if (!shouldSkipFrame(functionName, url)) {
        frames.push(frameLabel(node.callFrame));
      }

      currentId = parentMap.get(currentId);
      depth++;
    }

    // frames is [leaf, ..., nearRoot] — reverse to [root, ..., leaf]
    frames.reverse();

    if (frames.length === 0) continue; // pure idle / engine-only sample

    const stackStr = frames.join(";");
    stackCounts.set(stackStr, (stackCounts.get(stackStr) ?? 0) + 1);
  }

  return Array.from(stackCounts.entries())
    .map(([stack, count]) => `${stack} ${count}`)
    .join("\n");
}

/**
 * Convert a V8 sampling heap profile to Pyroscope's folded/collapsed stack format.
 *
 * The heap profile is a tree where each node holds `selfSize` bytes allocated
 * directly in that frame. We walk root→leaf, collecting non-skipped frame labels,
 * and emit a line for each node with selfSize > 0.
 *
 * No reversal needed — tree traversal already goes root→leaf order.
 *
 * @returns Folded stack string, or "" if the profile has no allocations.
 */
export function convertHeapToFolded(profile: SamplingHeapProfile): string {
  const lines: string[] = [];

  function walk(node: HeapProfileNode, frames: string[]): void {
    const { functionName, url } = node.callFrame;

    const nextFrames =
      isRoot(functionName) || shouldSkipFrame(functionName, url)
        ? frames
        : [...frames, frameLabel(node.callFrame)];

    if (node.selfSize > 0 && nextFrames.length > 0) {
      lines.push(`${nextFrames.join(";")} ${node.selfSize}`);
    }

    for (const child of node.children) {
      walk(child, nextFrames);
    }
  }

  walk(profile.head, []);

  return lines.join("\n");
}

/**
 * Calculate the sample rate in Hz from a CDP profile.
 * Pyroscope uses this to correctly calculate CPU time from sample counts.
 */
export function calculateSampleRate(profile: CdpProfile): number {
  if (!profile.samples || profile.samples.length === 0) return 100;
  const durationUs = profile.endTime - profile.startTime;
  if (durationUs <= 0) return 100;
  return Math.round((profile.samples.length / durationUs) * 1_000_000);
}
