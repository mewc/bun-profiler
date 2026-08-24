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
