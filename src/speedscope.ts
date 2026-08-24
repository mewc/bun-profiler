import type { CdpProfile } from "./types.js";

export function convertToSpeedscope(profile: CdpProfile, name = "bun-profiler"): object {
  const nodeMap = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentMap = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parentMap.set(child, node.id);
  }
  const frames: Array<{ name: string; file?: string; line?: number; col?: number }> = [];
  const frameIndex = new Map<number, number>();
  const samples: number[][] = [];
  const weights: number[] = [];

  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const stack: number[] = [];
    let current: number | undefined = profile.samples[i];
    let depth = 0;
    while (current !== undefined && depth++ < 512) {
      const node = nodeMap.get(current);
      if (!node || node.callFrame.functionName === "(root)") break;
      if (node.callFrame.url !== "node:inspector") {
        let index = frameIndex.get(node.id);
        if (index === undefined) {
          index = frames.length;
          frameIndex.set(node.id, index);
          frames.push({
            name: node.callFrame.functionName.trim() || "(anonymous)",
            ...(node.callFrame.url ? { file: node.callFrame.url } : {}),
            ...(node.callFrame.lineNumber >= 0 ? { line: node.callFrame.lineNumber + 1 } : {}),
            ...(node.callFrame.columnNumber >= 0 ? { col: node.callFrame.columnNumber + 1 } : {}),
          });
        }
        stack.push(index);
      }
      current = parentMap.get(current);
    }
    if (stack.length > 0) {
      samples.push(stack.reverse());
      weights.push(Math.max(0, profile.timeDeltas?.[i] ?? 0));
    }
  }

  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    name,
    activeProfileIndex: 0,
    shared: { frames },
    profiles: [
      {
        type: "sampled",
        name,
        unit: "microseconds",
        startValue: 0,
        endValue: weights.reduce((sum, value) => sum + value, 0),
        samples,
        weights,
      },
    ],
  };
}
