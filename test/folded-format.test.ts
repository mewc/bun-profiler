import { describe, expect, it } from "bun:test";
import { convertHeapToFolded, convertToFolded, convertToFoldedWallTime } from "../src/converter";
import type { CdpProfile, HeapProfileNode, SamplingHeapProfile } from "../src/types";

// ---------------------------------------------------------------------------
// Folded-format invariant — the `strconv.Atoi` failure class.
//
// A folded line is "<stack> <count>": frames joined by ";", a single space, then
// a base-10 integer count. Pyroscope's /ingest splits each line on the LAST space
// and runs strconv.Atoi on the tail. A tail that isn't a non-empty run of digits
// (a float, text, or an empty string from a trailing space) is rejected with
// `HTTP 422 strconv.Atoi: … invalid syntax`, and a raw newline inside a frame
// label splits one record into two — producing exactly such a fragment.
//
// This suite guards that every line the converters emit is Atoi-safe, including
// for adversarial frame labels (spaces, unicode, control characters, empty
// names). Interior spaces are fine — Pyroscope splits on the *last* space.
// ---------------------------------------------------------------------------

function assertValidFolded(folded: string): void {
  if (folded === "") return; // an empty profile is valid — nothing gets pushed
  for (const line of folded.split("\n")) {
    expect(line).not.toBe(""); // no blank records
    // Per-line: no control characters. The record separator "\n" is already gone
    // (we split on it), so this catches \r/\t/etc. that would corrupt a record.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — these are the record-corrupting bytes.
    expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(line.endsWith(" ")).toBe(false); // trailing space → empty count → 422

    const lastSpace = line.lastIndexOf(" ");
    expect(lastSpace).toBeGreaterThan(0); // must have both a stack and a count

    const stack = line.slice(0, lastSpace);
    const count = line.slice(lastSpace + 1);
    expect(stack.length).toBeGreaterThan(0);
    expect(count).toMatch(/^\d+$/); // integer only — no float / text / empty
    expect(Number(count)).toBeGreaterThan(0);
  }
}

function makeProfile(
  nodes: Array<{ id: number; name: string; url?: string; line?: number; children?: number[] }>,
  samples: number[],
  startTime = 0,
  endTime = 1_000_000,
  timeDeltas?: number[]
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
    timeDeltas:
      timeDeltas ?? samples.map(() => (samples.length ? Math.floor(endTime / samples.length) : 0)),
  };
}

// A stack of frames whose labels are deliberately hostile to the folded format.
const NASTY_NODES = [
  { id: 1, name: "(root)", children: [2] },
  // getter/setter/async names contain interior spaces (real V8/JSC output)
  { id: 2, name: "get value", url: "file:///app/src/widget.ts", line: 12, children: [3] },
  // empty function name → "(anonymous)"
  { id: 3, name: "", url: "file:///app/src/anon.ts", line: 3, children: [4] },
  // unicode
  { id: 4, name: "计算总和 (café)", url: "file:///app/src/µ.ts", line: 7, children: [5] },
  // embedded newline / carriage-return / tab in BOTH name and url — the record-splitters
  { id: 5, name: "bad\nname\twith\rbreaks", url: "file:///a/b\nc.ts", line: 9, children: [6] },
  // no url at all (native frame) whose name has a trailing control char
  { id: 6, name: "nativeReduce\n" },
];

describe("folded-format invariant (Atoi-safe output)", () => {
  it("convertToFolded: normal deep stack", () => {
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "parent", url: "file:///app/src/handler.ts", line: 10, children: [3] },
        { id: 3, name: "child", url: "file:///app/src/handler.ts", line: 5 },
      ],
      [3, 3, 2]
    );
    assertValidFolded(convertToFolded(profile));
  });

  it("convertToFolded: adversarial frame labels stay Atoi-safe", () => {
    const profile = makeProfile(NASTY_NODES, [6, 6, 5, 4, 2]);
    const folded = convertToFolded(profile);
    // assertValidFolded checks every record is Atoi-safe and control-char-free.
    assertValidFolded(folded);
    // the "bad\nname\twith\rbreaks" frame is flattened, not split into records
    expect(folded).toContain("bad name with breaks");
    // interior spaces from "get value" are preserved (only the count is split off)
    expect(folded).toContain("get value");
  });

  it("convertToFoldedWallTime: adversarial frame labels stay Atoi-safe", () => {
    const profile = makeProfile(
      NASTY_NODES,
      [6, 6, 5, 4, 2],
      0,
      1_000_000,
      [0, 5000, 400_000, 3000, 7000]
    );
    assertValidFolded(convertToFoldedWallTime(profile, 10_000));
  });

  it("convertHeapToFolded: adversarial frame labels stay Atoi-safe", () => {
    const leaf = (name: string, url: string, selfSize: number): HeapProfileNode => ({
      id: Math.floor(selfSize),
      callFrame: { functionName: name, scriptId: "1", url, lineNumber: 1, columnNumber: 0 },
      selfSize,
      children: [],
    });
    const heap: SamplingHeapProfile = {
      head: {
        id: 0,
        callFrame: {
          functionName: "(root)",
          scriptId: "1",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        selfSize: 0,
        children: [
          leaf("alloc\nHeavy", "file:///a/alloc.ts", 2048),
          leaf("get buffer", "file:///a/µ.ts", 512),
        ],
      },
    };
    assertValidFolded(convertHeapToFolded(heap));
  });

  it("interior spaces do not corrupt the count (last-space split)", () => {
    // A frame whose label is nothing but spaces after sanitization still must not
    // yield a line whose tail parses as a non-integer.
    const profile = makeProfile(
      [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "a b c d e", url: "file:///x/y z.ts", line: 1 },
      ],
      [2, 2]
    );
    const folded = convertToFolded(profile);
    assertValidFolded(folded);
    expect(folded).toBe("a b c d e (x/y z.ts:1) 2");
  });

  it("empty profiles produce a pushable empty string, not a bad line", () => {
    const empty = makeProfile([{ id: 1, name: "(root)" }], []);
    expect(convertToFolded(empty)).toBe("");
    expect(convertToFoldedWallTime(empty)).toBe("");
    assertValidFolded(convertToFolded(empty));
  });
});
