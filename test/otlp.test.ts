import { describe, expect, test } from "bun:test";
import { encodeOtlpProfilesJson, otlpHttpProfilesExporter } from "../src/otlp.js";
import type { CdpProfile, ProfileWindow } from "../src/types.js";

const profile: CdpProfile = {
  nodes: [
    {
      id: 1,
      callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: 0, columnNumber: 0 },
      children: [2],
    },
    {
      id: 2,
      callFrame: {
        functionName: "hotLoop",
        scriptId: "1",
        url: "file:///app.ts",
        lineNumber: 4,
        columnNumber: 2,
      },
    },
  ],
  samples: [2, 2],
  timeDeltas: [10_000, 10_000],
  startTime: 0,
  endTime: 20_000,
};

const window: ProfileWindow = Object.freeze({
  type: "cpu",
  appName: "otlp-test",
  labels: Object.freeze({ service_name: "otlp-test" }),
  from: 1_700_000_000,
  until: 1_700_000_001,
  sampleRate: 100,
  sampleIntervalUs: 10_000,
  folded: "hotLoop 2",
  profile,
});

describe("experimental OTLP Profiles", () => {
  test("uses the v1development dictionary-based JSON schema", () => {
    const encoded = encodeOtlpProfilesJson(window) as {
      dictionary: {
        stringTable: string[];
        functionTable: unknown[];
        stackTable: Array<{ locationIndices?: number[] }>;
      };
      resourceProfiles: Array<{
        scopeProfiles: Array<{
          profiles: Array<{
            sampleType: unknown;
            samples: unknown[];
            period: string;
          }>;
        }>;
      }>;
    };
    expect(encoded.dictionary.stringTable[0]).toBe("");
    expect(encoded.dictionary.functionTable[0]).toEqual({});
    expect(encoded.dictionary.stackTable[1].locationIndices).toEqual([1]);
    const output = encoded.resourceProfiles[0].scopeProfiles[0].profiles[0];
    expect(output.sampleType).toEqual({ typeStrindex: 1, unitStrindex: 2 });
    expect(output.samples).toEqual([{ stackIndex: 1, values: ["20000000"] }]);
    expect(output.period).toBe("10000000");
  });

  test("posts JSON to the development endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    let calledBody: { resourceProfiles?: unknown[] } = {};
    globalThis.fetch = (async (input, init) => {
      calledUrl = String(input);
      calledBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await otlpHttpProfilesExporter({ url: "http://collector:4318" }).export(window);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calledUrl).toBe("http://collector:4318/v1development/profiles");
    expect(calledBody.resourceProfiles).toHaveLength(1);
  });
});
