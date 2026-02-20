import { describe, expect, it } from "bun:test";
import { calculateSampleRate, convertHeapToFolded, convertToFolded } from "../src/converter";
import type { CdpProfile, HeapProfileNode, SamplingHeapProfile } from "../src/types";

/** Build a minimal CdpProfile from a flat node description. */
function makeProfile(
  nodes: Array<{
    id: number;
    name: string;
    url?: string;
    line?: number;
    children?: number[];
  }>,
  samples: number[],
  startTime = 0,
  endTime = 1_000_000
): CdpProfile {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      callFrame: {
        functionName: n.name,
        scriptId: "1",
        url: n.url ?? "",
        lineNumber: n.line ?? -1,
        columnNumber: -1,
      },
      children: n.children,
    })),
    startTime,
    endTime,
    samples,
    timeDeltas: samples.map(() =>
      samples.length > 0 ? Math.floor((endTime - startTime) / samples.length) : 0
    ),
  };
}

describe("convertToFolded", () => {
  it("returns empty string for empty samples", () => {
    const profile = makeProfile([{ id: 1, name: "(root)" }], []);
    expect(convertToFolded(profile)).toBe("");
  });

  it("returns empty string when samples array is missing", () => {
    const profile = makeProfile([{ id: 1, name: "(root)" }], []);
    // @ts-expect-error — testing runtime guard
    profile.samples = undefined;
    expect(convertToFolded(profile)).toBe("");
  });

  it("handles a single-frame stack with repeated samples", () => {
    // Tree: (root) -> myFunc
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "myFunc" },
      ],
      [2, 2, 2]
    );
    expect(convertToFolded(profile)).toBe("myFunc 3");
  });

  it("handles a deep multi-frame stack", () => {
    // (root) -> parent -> child -> grandchild
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "parent", url: "file:///app/src/handler.ts", line: 10, children: [3] },
        { id: 3, name: "child", url: "file:///app/src/handler.ts", line: 5, children: [4] },
        { id: 4, name: "grandchild", url: "file:///app/src/handler.ts", line: 2 },
      ],
      [4, 4]
    );
    const result = convertToFolded(profile);
    expect(result).toContain("parent");
    expect(result).toContain("child");
    expect(result).toContain("grandchild");
    expect(result).toContain(" 2");
    // Root should not appear
    expect(result).not.toContain("(root)");
  });

  it("skips node:inspector frames but continues walking", () => {
    // (root) -> performMicrotask -> [node:inspector noise] -> userFunc
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "performMicrotask", children: [3] },
        { id: 3, name: "internal", url: "node:inspector", line: 51, children: [4] },
        { id: 4, name: "userFunc", url: "file:///app/src/server.ts", line: 42 },
      ],
      [4, 4, 4]
    );
    const result = convertToFolded(profile);
    expect(result).not.toContain("node:inspector");
    expect(result).toContain("performMicrotask");
    expect(result).toContain("userFunc");
    expect(result).toContain(" 3");
  });

  it("drops (idle) samples entirely", () => {
    // (root) -> (idle) — should produce no output for those samples
    // (root) -> userCode — should appear
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2, 3] },
        { id: 2, name: "(idle)" },
        { id: 3, name: "userCode" },
      ],
      [2, 3, 3]
    );
    const result = convertToFolded(profile);
    expect(result).toBe("userCode 2");
  });

  it("formats anonymous frames as (anonymous)", () => {
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "", url: "file:///app/src/handler.ts", line: 5 },
      ],
      [2]
    );
    const result = convertToFolded(profile);
    expect(result).toContain("(anonymous)");
    expect(result).toContain(" 1");
  });

  it("formats frame with no url as bare function name", () => {
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "cacheSatisfyAndReturn" },
      ],
      [2]
    );
    expect(convertToFolded(profile)).toBe("cacheSatisfyAndReturn 1");
  });

  it("strips file:// prefix and uses last 2 path segments in label", () => {
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        {
          id: 2,
          name: "myFunc",
          url: "file:///home/user/my-project/src/deep/handler.ts",
          line: 10,
        },
      ],
      [2]
    );
    const result = convertToFolded(profile);
    // Should use "deep/handler.ts" not the full path
    expect(result).toContain("deep/handler.ts");
    expect(result).not.toContain("/home/user/my-project");
  });

  it("aggregates identical stacks into a single count", () => {
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "heavyWork", children: [3] },
        { id: 3, name: "doSomething" },
      ],
      [3, 3, 3, 3, 3]
    );
    expect(convertToFolded(profile)).toBe("heavyWork;doSomething 5");
  });

  it("handles branching tree with different counts per branch", () => {
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "parent", children: [3, 4] },
        { id: 3, name: "childA" },
        { id: 4, name: "childB" },
      ],
      [3, 4, 3, 3, 4]
    );
    const result = convertToFolded(profile);
    const lines = result.split("\n");
    expect(lines).toContain("parent;childA 3");
    expect(lines).toContain("parent;childB 2");
    expect(lines).toHaveLength(2);
  });

  it("correctly reverses frame order (root at front, leaf at end)", () => {
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "A", children: [3] },
        { id: 3, name: "B", children: [4] },
        { id: 4, name: "C" },
      ],
      [4]
    );
    expect(convertToFolded(profile)).toBe("A;B;C 1");
  });

  it("handles node not found in nodeMap gracefully", () => {
    // Sample references a node that doesn't exist in nodes[] — should not crash
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "knownFunc" },
      ],
      [99] // node 99 doesn't exist
    );
    // Should produce empty output (no crash)
    expect(convertToFolded(profile)).toBe("");
  });
});

/** Build a minimal HeapProfileNode. */
function makeHeapNode(
  id: number,
  name: string,
  selfSize: number,
  children: HeapProfileNode[] = [],
  url = "",
  line = -1
): HeapProfileNode {
  return {
    id,
    selfSize,
    callFrame: {
      functionName: name,
      scriptId: "1",
      url,
      lineNumber: line,
      columnNumber: -1,
    },
    children,
  };
}

function makeHeapProfile(head: HeapProfileNode): SamplingHeapProfile {
  return { head };
}

describe("convertHeapToFolded", () => {
  it("returns empty string when no node has selfSize > 0", () => {
    const profile = makeHeapProfile(
      makeHeapNode(1, "(root)", 0, [makeHeapNode(2, "parent", 0, [makeHeapNode(3, "leaf", 0)])])
    );
    expect(convertHeapToFolded(profile)).toBe("");
  });

  it("returns single line for a leaf with selfSize", () => {
    const profile = makeHeapProfile(
      makeHeapNode(1, "(root)", 0, [makeHeapNode(2, "parent", 0, [makeHeapNode(3, "leaf", 512)])])
    );
    expect(convertHeapToFolded(profile)).toBe("parent;leaf 512");
  });

  it("skips (root) and (idle) frames", () => {
    const profile = makeHeapProfile(
      makeHeapNode(1, "(root)", 0, [makeHeapNode(2, "(idle)", 1024)])
    );
    // (idle) selfSize is > 0 but shouldSkipFrame drops it, so nextFrames stays []
    expect(convertHeapToFolded(profile)).toBe("");
  });

  it("skips node:inspector frames but continues into children", () => {
    const leaf = makeHeapNode(4, "userAlloc", 256);
    const inspector = makeHeapNode(3, "internal", 0, [leaf], "node:inspector");
    const root = makeHeapNode(1, "(root)", 0, [makeHeapNode(2, "parent", 0, [inspector])]);
    const profile = makeHeapProfile(root);
    const result = convertHeapToFolded(profile);
    expect(result).not.toContain("node:inspector");
    expect(result).not.toContain("internal");
    expect(result).toContain("parent");
    expect(result).toContain("userAlloc");
  });

  it("attributes selfSize on an intermediate (non-leaf) node correctly", () => {
    const child = makeHeapNode(3, "child", 128);
    const middle = makeHeapNode(2, "middle", 64, [child]);
    const profile = makeHeapProfile(makeHeapNode(1, "(root)", 0, [middle]));
    const result = convertHeapToFolded(profile);
    const lines = result.split("\n");
    expect(lines).toContain("middle 64");
    expect(lines).toContain("middle;child 128");
  });

  it("emits separate lines for multiple branches", () => {
    const branchA = makeHeapNode(3, "allocA", 100);
    const branchB = makeHeapNode(4, "allocB", 200);
    const profile = makeHeapProfile(
      makeHeapNode(1, "(root)", 0, [makeHeapNode(2, "parent", 0, [branchA, branchB])])
    );
    const result = convertHeapToFolded(profile);
    const lines = result.split("\n");
    expect(lines).toContain("parent;allocA 100");
    expect(lines).toContain("parent;allocB 200");
    expect(lines).toHaveLength(2);
  });

  it("handles deeply nested tree", () => {
    const deep = makeHeapNode(5, "deep", 999);
    const c = makeHeapNode(4, "c", 0, [deep]);
    const b = makeHeapNode(3, "b", 0, [c]);
    const a = makeHeapNode(2, "a", 0, [b]);
    const profile = makeHeapProfile(makeHeapNode(1, "(root)", 0, [a]));
    expect(convertHeapToFolded(profile)).toBe("a;b;c;deep 999");
  });
});

describe("calculateSampleRate", () => {
  it("returns 100 for empty samples", () => {
    const profile = makeProfile([{ id: 1, name: "(root)" }], []);
    expect(calculateSampleRate(profile)).toBe(100);
  });

  it("returns 100 when samples is undefined", () => {
    const profile = makeProfile([{ id: 1, name: "(root)" }], []);
    // @ts-expect-error — testing runtime guard
    profile.samples = undefined;
    expect(calculateSampleRate(profile)).toBe(100);
  });

  it("returns 100 for zero duration", () => {
    const profile = makeProfile([{ id: 1, name: "(root)" }], [1, 2, 3], 1000, 1000);
    expect(calculateSampleRate(profile)).toBe(100);
  });

  it("calculates 100Hz for 100 samples over 1 second", () => {
    const samples = Array.from({ length: 100 }, () => 1);
    const profile = makeProfile([{ id: 1, name: "(root)" }], samples, 0, 1_000_000);
    expect(calculateSampleRate(profile)).toBe(100);
  });

  it("calculates 100Hz for 1500 samples over 15 seconds", () => {
    const samples = Array.from({ length: 1500 }, () => 1);
    const profile = makeProfile([{ id: 1, name: "(root)" }], samples, 0, 15_000_000);
    expect(calculateSampleRate(profile)).toBe(100);
  });

  it("calculates 1000Hz for 1000 samples over 1 second", () => {
    const samples = Array.from({ length: 1000 }, () => 1);
    const profile = makeProfile([{ id: 1, name: "(root)" }], samples, 0, 1_000_000);
    expect(calculateSampleRate(profile)).toBe(1000);
  });
});
