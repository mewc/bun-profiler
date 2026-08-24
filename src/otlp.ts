import { ExporterError, ProfilerConfigError } from "./errors.js";
import { requestDeadline } from "./http.js";
import { parseRetryAfter } from "./retry.js";
import type { CdpProfile, ProfileExporter, ProfileWindow } from "./types.js";

export interface OtlpHttpProfilesExporterOptions {
  /** Collector base URL or the full /v1development/profiles endpoint. */
  url: string;
  headers?: Record<string, string>;
  name?: string;
  /** Abort one HTTP attempt after this duration. Default: 10000. */
  timeoutMs?: number;
}

interface OtlpProfilesRequest {
  resourceProfiles: unknown[];
  dictionary: Record<string, unknown>;
}

function profileEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProfilerConfigError("OTLP Profiles exporter URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProfilerConfigError("OTLP Profiles exporter URL must use http or https");
  }
  const path = url.pathname.replace(/\/$/, "");
  if (!path.endsWith("/v1development/profiles")) {
    url.pathname = `${path}/v1development/profiles`.replace(/^\/\//, "/");
  }
  return url.toString();
}

function usableFrame(functionName: string, url: string): boolean {
  return functionName !== "(root)" && functionName !== "(idle)" && url !== "node:inspector";
}

/**
 * Convert one captured CPU window to the current Alpha OTLP Profiles JSON shape.
 * This is intentionally kept out of the stable package entry point.
 */
export function encodeOtlpProfilesJson(window: ProfileWindow): OtlpProfilesRequest | null {
  if (window.type !== "cpu") return null;
  const profile = window.profile as CdpProfile;
  const strings = [""];
  const stringIndices = new Map<string, number>([["", 0]]);
  const stringIndex = (value: string): number => {
    const existing = stringIndices.get(value);
    if (existing !== undefined) return existing;
    const index = strings.length;
    strings.push(value);
    stringIndices.set(value, index);
    return index;
  };

  const cpuIndex = stringIndex("cpu");
  const nanosecondsIndex = stringIndex("nanoseconds");
  const nodeMap = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentMap = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parentMap.set(child, node.id);
  }

  // Index zero is the required zero value for every OTLP Profiles dictionary.
  const functionTable: Array<Record<string, unknown>> = [{}];
  const locationTable: Array<Record<string, unknown>> = [{}];
  const functionIndexByNode = new Map<number, number>();
  const locationIndexByNode = new Map<number, number>();
  for (const node of profile.nodes) {
    if (!usableFrame(node.callFrame.functionName, node.callFrame.url)) continue;
    const name = node.callFrame.functionName.trim() || "(anonymous)";
    const functionIndex = functionTable.length;
    functionIndexByNode.set(node.id, functionIndex);
    functionTable.push({
      nameStrindex: stringIndex(name),
      systemNameStrindex: stringIndex(name),
      filenameStrindex: stringIndex(node.callFrame.url || "<unknown>"),
      startLine: String(Math.max(0, node.callFrame.lineNumber + 1)),
    });
    const locationIndex = locationTable.length;
    locationIndexByNode.set(node.id, locationIndex);
    locationTable.push({
      lines: [
        {
          functionIndex,
          line: String(Math.max(0, node.callFrame.lineNumber + 1)),
          column: String(Math.max(0, node.callFrame.columnNumber + 1)),
        },
      ],
    });
  }

  const stackTable: Array<Record<string, unknown>> = [{}];
  const stackIndices = new Map<string, number>();
  const sampleTotals = new Map<number, number>();
  const periodNanos = Math.max(1, Math.round(window.sampleIntervalUs * 1_000));
  for (const leafId of profile.samples ?? []) {
    const locations: number[] = [];
    let current: number | undefined = leafId;
    let depth = 0;
    while (current !== undefined && depth++ < 512) {
      const node = nodeMap.get(current);
      if (!node || node.callFrame.functionName === "(root)") break;
      const location = locationIndexByNode.get(current);
      if (location !== undefined) locations.push(location);
      current = parentMap.get(current);
    }
    if (locations.length === 0) continue;
    const key = locations.join(",");
    let stackIndex = stackIndices.get(key);
    if (stackIndex === undefined) {
      stackIndex = stackTable.length;
      stackIndices.set(key, stackIndex);
      stackTable.push({ locationIndices: locations });
    }
    sampleTotals.set(stackIndex, (sampleTotals.get(stackIndex) ?? 0) + periodNanos);
  }

  const attributes = Object.entries({ "service.name": window.appName, ...window.labels }).map(
    ([key, value]) => ({
      key,
      value: { stringValue: value },
    })
  );
  const durationNanos = String(Math.max(1, window.until - window.from) * 1_000_000_000);
  const samples = [...sampleTotals].map(([stackIndex, value]) => ({
    stackIndex,
    values: [String(value)],
  }));

  return {
    resourceProfiles: [
      {
        resource: { attributes },
        scopeProfiles: [
          {
            scope: { name: "bun-profiler" },
            profiles: [
              {
                sampleType: { typeStrindex: cpuIndex, unitStrindex: nanosecondsIndex },
                samples,
                timeUnixNano: String(window.until * 1_000_000_000),
                durationNano: durationNanos,
                periodType: { typeStrindex: cpuIndex, unitStrindex: nanosecondsIndex },
                period: String(periodNanos),
              },
            ],
          },
        ],
      },
    ],
    dictionary: {
      mappingTable: [{}],
      locationTable,
      functionTable,
      linkTable: [{}],
      stringTable: strings,
      attributeTable: [{}],
      stackTable,
    },
  };
}

/** Experimental Alpha OTLP/HTTP Profiles exporter. Wire stability is not promised. */
export function otlpHttpProfilesExporter(
  options: OtlpHttpProfilesExporterOptions
): ProfileExporter {
  const endpoint = profileEndpoint(options.url);
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new ProfilerConfigError("OTLP Profiles exporter timeoutMs must be greater than zero");
  }
  return {
    name: options.name ?? "otlp-profiles-experimental",
    async export(window, signal) {
      const request = encodeOtlpProfilesJson(window);
      if (!request) return;
      const deadline = requestDeadline(signal, options.timeoutMs ?? 10_000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { ...options.headers, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: deadline.signal,
        });
        if (response.ok) {
          await response.arrayBuffer();
          return;
        }
        const body = await response.text().catch(() => "(unreadable)");
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ExporterError(`HTTP ${response.status}: ${body}`, {
          status: response.status,
          retryable,
          retryAfterMs: retryable
            ? parseRetryAfter(response.headers.get("Retry-After"))
            : undefined,
        });
      } catch (error) {
        if (error instanceof ExporterError) throw error;
        if (deadline.timedOut()) {
          throw new ExporterError(`export timed out after ${options.timeoutMs ?? 10_000}ms`);
        }
        if (signal?.aborted) throw new ExporterError("export aborted", { retryable: false });
        throw new ExporterError(error instanceof Error ? error.message : String(error));
      } finally {
        deadline.cleanup();
      }
    },
  };
}
