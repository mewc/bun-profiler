import { gzipSync } from "node:zlib";
import { Root } from "protobufjs";
import type { CdpProfile, PprofEncodeOptions } from "./types.js";

const root = Root.fromJSON({
  nested: {
    perftools: {
      nested: {
        profiles: {
          nested: {
            ValueType: {
              fields: { type: { type: "int64", id: 1 }, unit: { type: "int64", id: 2 } },
            },
            Label: {
              fields: {
                key: { type: "int64", id: 1 },
                str: { type: "int64", id: 2 },
                num: { type: "int64", id: 3 },
                numUnit: { type: "int64", id: 4 },
              },
            },
            Sample: {
              fields: {
                locationId: { rule: "repeated", type: "uint64", id: 1, options: { packed: true } },
                value: { rule: "repeated", type: "int64", id: 2, options: { packed: true } },
                label: { rule: "repeated", type: "Label", id: 3 },
              },
            },
            Mapping: {
              fields: {
                id: { type: "uint64", id: 1 },
                memoryStart: { type: "uint64", id: 2 },
                memoryLimit: { type: "uint64", id: 3 },
                fileOffset: { type: "uint64", id: 4 },
                filename: { type: "int64", id: 5 },
                buildId: { type: "int64", id: 6 },
                hasFunctions: { type: "bool", id: 7 },
                hasFilenames: { type: "bool", id: 8 },
                hasLineNumbers: { type: "bool", id: 9 },
                hasInlineFrames: { type: "bool", id: 10 },
              },
            },
            Line: {
              fields: {
                functionId: { type: "uint64", id: 1 },
                line: { type: "int64", id: 2 },
                column: { type: "int64", id: 3 },
              },
            },
            Location: {
              fields: {
                id: { type: "uint64", id: 1 },
                mappingId: { type: "uint64", id: 2 },
                address: { type: "uint64", id: 3 },
                line: { rule: "repeated", type: "Line", id: 4 },
                isFolded: { type: "bool", id: 5 },
              },
            },
            Function: {
              fields: {
                id: { type: "uint64", id: 1 },
                name: { type: "int64", id: 2 },
                systemName: { type: "int64", id: 3 },
                filename: { type: "int64", id: 4 },
                startLine: { type: "int64", id: 5 },
              },
            },
            Profile: {
              fields: {
                sampleType: { rule: "repeated", type: "ValueType", id: 1 },
                sample: { rule: "repeated", type: "Sample", id: 2 },
                mapping: { rule: "repeated", type: "Mapping", id: 3 },
                location: { rule: "repeated", type: "Location", id: 4 },
                function: { rule: "repeated", type: "Function", id: 5 },
                stringTable: { rule: "repeated", type: "string", id: 6 },
                dropFrames: { type: "int64", id: 7 },
                keepFrames: { type: "int64", id: 8 },
                timeNanos: { type: "int64", id: 9 },
                durationNanos: { type: "int64", id: 10 },
                periodType: { type: "ValueType", id: 11 },
                period: { type: "int64", id: 12 },
                comment: { rule: "repeated", type: "int64", id: 13 },
                defaultSampleType: { type: "int64", id: 14 },
              },
            },
          },
        },
      },
    },
  },
});

const ProfileMessage = root.lookupType("perftools.profiles.Profile");

function usableFrame(functionName: string, url: string): boolean {
  return functionName !== "(root)" && functionName !== "(idle)" && url !== "node:inspector";
}

/** Encode a CDP CPU profile as a gzip-compressed profile.proto payload. */
export function encodePprof(profile: CdpProfile, options: PprofEncodeOptions = {}): Uint8Array {
  const sampleIntervalUs = options.sampleIntervalUs ?? 10_000;
  const periodNanos = Math.max(1, Math.round(sampleIntervalUs * 1_000));
  const strings = [""];
  const stringIds = new Map<string, number>([["", 0]]);
  const stringId = (value: string): number => {
    const existing = stringIds.get(value);
    if (existing !== undefined) return existing;
    const id = strings.length;
    strings.push(value);
    stringIds.set(value, id);
    return id;
  };

  const samplesIndex = stringId("samples");
  const countIndex = stringId("count");
  const cpuIndex = stringId("cpu");
  const nanosecondsIndex = stringId("nanoseconds");

  const nodeMap = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentMap = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parentMap.set(child, node.id);
  }

  const visibleNodes = profile.nodes.filter((node) =>
    usableFrame(node.callFrame.functionName, node.callFrame.url)
  );
  const functionIdByNode = new Map<number, number>();
  const locationIdByNode = new Map<number, number>();
  const functions = visibleNodes.map((node, index) => {
    const id = index + 1;
    functionIdByNode.set(node.id, id);
    const name = node.callFrame.functionName.trim() || "(anonymous)";
    return {
      id,
      name: stringId(name),
      systemName: stringId(name),
      filename: stringId(node.callFrame.url || "<unknown>"),
      startLine: Math.max(0, node.callFrame.lineNumber + 1),
    };
  });
  const locations = visibleNodes.map((node, index) => {
    const id = index + 1;
    locationIdByNode.set(node.id, id);
    return {
      id,
      line: [
        {
          functionId: functionIdByNode.get(node.id),
          line: Math.max(0, node.callFrame.lineNumber + 1),
          column: Math.max(0, node.callFrame.columnNumber + 1),
        },
      ],
    };
  });

  const samples = [];
  for (const leafId of profile.samples ?? []) {
    const locationIds: number[] = [];
    let current: number | undefined = leafId;
    let depth = 0;
    while (current !== undefined && depth++ < 512) {
      const node = nodeMap.get(current);
      if (!node || node.callFrame.functionName === "(root)") break;
      const locationId = locationIdByNode.get(current);
      if (locationId !== undefined) locationIds.push(locationId);
      current = parentMap.get(current);
    }
    if (locationIds.length > 0) samples.push({ locationId: locationIds, value: [1, periodNanos] });
  }

  const durationNanos =
    options.durationNanos ?? String(Math.max(0, profile.endTime - profile.startTime) * 1_000);
  const timeNanos = options.timeNanos ?? String(Date.now() * 1_000_000);
  const message = ProfileMessage.create({
    sampleType: [
      { type: samplesIndex, unit: countIndex },
      { type: cpuIndex, unit: nanosecondsIndex },
    ],
    sample: samples,
    location: locations,
    function: functions,
    stringTable: strings,
    timeNanos,
    durationNanos,
    periodType: { type: cpuIndex, unit: nanosecondsIndex },
    period: periodNanos,
    defaultSampleType: cpuIndex,
  });
  return gzipSync(ProfileMessage.encode(message).finish());
}

/** Decode helper intended for conformance tests and diagnostic tooling. */
export function decodePprof(data: Uint8Array): unknown {
  return ProfileMessage.toObject(ProfileMessage.decode(data), {
    longs: String,
    arrays: true,
    defaults: true,
  });
}
