import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { decodePprof, encodePprof } from "../src/pprof";
import { convertToSpeedscope } from "../src/speedscope";
import type { CdpProfile } from "../src/types";

const PROFILE: CdpProfile = {
  nodes: [
    {
      id: 1,
      callFrame: {
        functionName: "(root)",
        scriptId: "1",
        url: "",
        lineNumber: -1,
        columnNumber: -1,
      },
      children: [2],
    },
    {
      id: 2,
      callFrame: {
        functionName: "handleCheckout",
        scriptId: "2",
        url: "file:///app/checkout.ts",
        lineNumber: 40,
        columnNumber: 3,
      },
      children: [3],
    },
    {
      id: 3,
      callFrame: {
        functionName: "applyDiscounts",
        scriptId: "2",
        url: "file:///app/checkout.ts",
        lineNumber: 78,
        columnNumber: 2,
      },
    },
  ],
  samples: [3, 3, 2],
  timeDeltas: [10_000, 10_000, 10_000],
  startTime: 1_000_000,
  endTime: 1_030_000,
};

describe("pprof encoding", () => {
  it("emits gzip-compressed profile.proto with CPU sample metadata", () => {
    const compressed = encodePprof(PROFILE, { sampleIntervalUs: 10_000 });
    expect(Array.from(compressed.slice(0, 2))).toEqual([0x1f, 0x8b]);
    const decoded = decodePprof(gunzipSync(compressed)) as {
      stringTable: string[];
      sampleType: unknown[];
      sample: Array<{ locationId: string[]; value: string[] }>;
      location: unknown[];
      function: unknown[];
      period: string;
      durationNanos: string;
    };
    expect(decoded.stringTable).toContain("handleCheckout");
    expect(decoded.stringTable).toContain("applyDiscounts");
    expect(decoded.sampleType).toHaveLength(2);
    expect(decoded.sample).toHaveLength(3);
    expect(decoded.sample[0]?.locationId).toHaveLength(2);
    expect(decoded.location).toHaveLength(2);
    expect(decoded.function).toHaveLength(2);
    expect(decoded.period).toBe("10000000");
    expect(decoded.durationNanos).toBe("30000000");
  });
});

type DecodedProfile = {
  stringTable: string[];
  sampleType: Array<{ type: string; unit: string }>;
  sample: Array<{ locationId: string[]; value: string[] }>;
  location: Array<{
    id: string;
    line: Array<{ functionId: string; line: string; column: string }>;
  }>;
  function: Array<{
    id: string;
    name: string;
    systemName: string;
    filename: string;
    startLine: string;
  }>;
  periodType: { type: string; unit: string };
  period: string;
  timeNanos: string;
  durationNanos: string;
  defaultSampleType: string;
};

function decode(profile: CdpProfile, options?: Parameters<typeof encodePprof>[1]): DecodedProfile {
  return decodePprof(gunzipSync(encodePprof(profile, options))) as DecodedProfile;
}

describe("pprof encoding details", () => {
  it("drops (root), (idle) and inspector frames from locations and functions", () => {
    const noisy: CdpProfile = {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "(root)",
            scriptId: "0",
            url: "",
            lineNumber: -1,
            columnNumber: -1,
          },
          children: [2, 3],
        },
        {
          id: 2,
          callFrame: {
            functionName: "(idle)",
            scriptId: "0",
            url: "",
            lineNumber: -1,
            columnNumber: -1,
          },
        },
        {
          id: 3,
          callFrame: {
            functionName: "poll",
            scriptId: "9",
            url: "node:inspector",
            lineNumber: 1,
            columnNumber: 1,
          },
          children: [4],
        },
        {
          id: 4,
          callFrame: {
            functionName: "work",
            scriptId: "2",
            url: "file:///app/w.ts",
            lineNumber: 10,
            columnNumber: 4,
          },
        },
      ],
      samples: [4, 2, 4],
      timeDeltas: [10_000, 10_000, 10_000],
      startTime: 0,
      endTime: 30_000,
    };
    const decoded = decode(noisy);
    const names = decoded.function.map((fn) => decoded.stringTable[Number(fn.name)]);
    expect(names).toEqual(["work"]);
    expect(decoded.location).toHaveLength(1);
    // Only the two samples whose leaf is a usable frame survive; the (idle) sample is dropped.
    expect(decoded.sample).toHaveLength(2);
    for (const sample of decoded.sample) expect(sample.locationId).toEqual(["1"]);
  });

  it("orders sample locations leaf-to-root and pairs count with cpu nanoseconds", () => {
    const decoded = decode(PROFILE, { sampleIntervalUs: 10_000 });
    // First sample's leaf is node 3 (applyDiscounts), then node 2 (handleCheckout).
    const leaf = decoded.location.find((loc) => loc.id === decoded.sample[0]?.locationId[0]);
    expect(
      decoded.stringTable[
        Number(decoded.function.find((fn) => fn.id === leaf?.line[0]?.functionId)?.name)
      ]
    ).toBe("applyDiscounts");
    for (const sample of decoded.sample) expect(sample.value).toEqual(["1", "10000000"]);
  });

  it("scales period and per-sample cpu value with sampleIntervalUs", () => {
    const decoded = decode(PROFILE, { sampleIntervalUs: 250 });
    expect(decoded.period).toBe("250000");
    expect(decoded.periodType).toEqual({
      type: String(decoded.stringTable.indexOf("cpu")),
      unit: String(decoded.stringTable.indexOf("nanoseconds")),
    });
    for (const sample of decoded.sample) expect(sample.value[1]).toBe("250000");
  });

  it("stores 1-based line and column numbers and file names for functions", () => {
    const decoded = decode(PROFILE);
    const fn = decoded.function.find(
      (f) => decoded.stringTable[Number(f.name)] === "handleCheckout"
    );
    expect(decoded.stringTable[Number(fn?.filename)]).toBe("file:///app/checkout.ts");
    const loc = decoded.location.find((l) => l.line[0]?.functionId === fn?.id);
    // CDP reports 0-based line 40 / column 3; pprof is 1-based.
    expect(loc?.line[0]?.line).toBe("41");
    expect(loc?.line[0]?.column).toBe("4");
  });

  it("falls back to (anonymous) for unnamed frames", () => {
    const anon: CdpProfile = {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "(root)",
            scriptId: "0",
            url: "",
            lineNumber: -1,
            columnNumber: -1,
          },
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            functionName: "   ",
            scriptId: "2",
            url: "file:///a.ts",
            lineNumber: 0,
            columnNumber: 0,
          },
        },
      ],
      samples: [2],
      timeDeltas: [10_000],
      startTime: 0,
      endTime: 10_000,
    };
    const decoded = decode(anon);
    expect(decoded.stringTable).toContain("(anonymous)");
  });

  it("honours explicit durationNanos and timeNanos overrides", () => {
    const decoded = decode(PROFILE, { durationNanos: "123456", timeNanos: "789" });
    expect(decoded.durationNanos).toBe("123456");
    expect(decoded.timeNanos).toBe("789");
  });

  it("emits both sample types and no samples for an empty profile", () => {
    const empty: CdpProfile = {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "(root)",
            scriptId: "0",
            url: "",
            lineNumber: -1,
            columnNumber: -1,
          },
        },
      ],
      samples: [],
      timeDeltas: [],
      startTime: 0,
      endTime: 0,
    };
    const decoded = decode(empty);
    expect(decoded.sampleType).toHaveLength(2);
    expect(decoded.sample).toHaveLength(0);
    expect(decoded.location).toHaveLength(0);
  });

  it("round-trips the string table without duplicating shared names", () => {
    const decoded = decode(PROFILE);
    // "(anonymous)" is not needed here; each real name appears exactly once.
    const occurrences = decoded.stringTable.filter((s) => s === "handleCheckout").length;
    expect(occurrences).toBe(1);
    expect(decoded.stringTable[0]).toBe("");
  });
});

describe("Speedscope conversion", () => {
  it("produces a sampled profile with root-to-leaf stacks", () => {
    const output = convertToSpeedscope(PROFILE, "checkout") as {
      $schema: string;
      shared: { frames: Array<{ name: string }> };
      profiles: Array<{ samples: number[][]; weights: number[] }>;
    };
    expect(output.$schema).toContain("speedscope");
    expect(output.shared.frames.map((frame) => frame.name)).toContain("applyDiscounts");
    expect(output.profiles[0]?.samples).toHaveLength(3);
    expect(output.profiles[0]?.weights).toEqual([10_000, 10_000, 10_000]);
  });
});
