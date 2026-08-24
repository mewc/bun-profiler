import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { CdpCallFrame, CdpProfile } from "./types.js";

interface CachedMap {
  map: TraceMap;
  baseUrl: URL;
}

/** Bounded, failure-tolerant source-map resolver for bundled JavaScript frames. */
export class SourceMapResolver {
  private readonly cacheSize: number;
  private readonly cache = new Map<string, CachedMap | null>();

  constructor(cacheSize = 64) {
    this.cacheSize = cacheSize;
  }

  async resolveProfile(profile: CdpProfile): Promise<CdpProfile> {
    const frames = await Promise.all(
      profile.nodes.map((node) => this.resolveFrame(node.callFrame))
    );
    return {
      ...profile,
      nodes: profile.nodes.map((node, index) => ({
        ...node,
        callFrame: frames[index] ?? node.callFrame,
      })),
    };
  }

  private async resolveFrame(frame: CdpCallFrame): Promise<CdpCallFrame> {
    if (!frame.url.startsWith("file://") || frame.lineNumber < 0 || frame.columnNumber < 0) {
      return frame;
    }
    const cached = await this.loadMap(frame.url);
    if (!cached) return frame;
    const original = originalPositionFor(cached.map, {
      line: frame.lineNumber + 1,
      column: frame.columnNumber,
    });
    if (original.line === null || original.column === null || !original.source) return frame;
    let source = original.source;
    try {
      source = new URL(source, cached.baseUrl).href;
    } catch {
      // Keep the source-map-provided path when it is not a valid URL.
    }
    return {
      ...frame,
      functionName: original.name ?? frame.functionName,
      url: source,
      lineNumber: original.line - 1,
      columnNumber: original.column,
    };
  }

  private async loadMap(scriptUrl: string): Promise<CachedMap | null> {
    if (this.cache.has(scriptUrl)) {
      const value = this.cache.get(scriptUrl) ?? null;
      this.cache.delete(scriptUrl);
      this.cache.set(scriptUrl, value);
      return value;
    }
    let result: CachedMap | null = null;
    try {
      const script = await readFile(fileURLToPath(scriptUrl), "utf8");
      const match = /[#@]\s*sourceMappingURL=([^\s*]+)\s*(?:\*\/)?\s*$/.exec(script);
      const reference = match?.[1];
      if (reference) {
        let raw: string;
        let baseUrl = new URL(scriptUrl);
        if (reference.startsWith("data:")) {
          const comma = reference.indexOf(",");
          const metadata = reference.slice(0, comma);
          const payload = reference.slice(comma + 1);
          raw = metadata.includes(";base64")
            ? Buffer.from(payload, "base64").toString("utf8")
            : decodeURIComponent(payload);
        } else {
          baseUrl = new URL(reference, scriptUrl);
          raw = await readFile(fileURLToPath(baseUrl), "utf8");
        }
        result = { map: new TraceMap(raw), baseUrl };
      }
    } catch {
      result = null;
    }
    this.cache.set(scriptUrl, result);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return result;
  }
}
