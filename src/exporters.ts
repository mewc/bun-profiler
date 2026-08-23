import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { ExporterError, ProfilerConfigError } from "./errors.js";
import { requestDeadline } from "./http.js";
import { encodePyroscopeName } from "./labels.js";
import { encodePprof } from "./pprof.js";
import { parseRetryAfter } from "./retry.js";
import { convertToSpeedscope } from "./speedscope.js";
import type {
  CdpProfile,
  PprofFileExporterOptions,
  ProfileExporter,
  ProfileWindow,
  PyroscopeExporterOptions,
} from "./types.js";

function authHeader(options: PyroscopeExporterOptions): string | undefined {
  if (options.authToken) return `Bearer ${options.authToken}`;
  if (options.basicAuth) {
    return `Basic ${Buffer.from(`${options.basicAuth.username}:${options.basicAuth.password}`).toString("base64")}`;
  }
  return undefined;
}

class PyroscopeExporter implements ProfileExporter {
  readonly name: string;
  private readonly options: PyroscopeExporterOptions;

  constructor(options: PyroscopeExporterOptions) {
    this.options = { ...options, url: options.url.replace(/\/$/, "") };
    this.name = options.name ?? "pyroscope";
  }

  async export(window: ProfileWindow, signal?: AbortSignal): Promise<void> {
    const deadline = requestDeadline(signal, this.options.timeoutMs ?? 10_000);
    const usePprof = this.options.format === "pprof" && window.type === "cpu";
    const labels = { ...window.labels };
    const params = new URLSearchParams({
      name: encodePyroscopeName(window.appName, labels, usePprof ? null : window.type),
      from: String(window.from),
      until: String(window.until),
      format: usePprof ? "pprof" : "folded",
      spyName: "nodespy",
    });
    if (!usePprof) params.set("sampleRate", String(window.sampleRate));

    const headers: Record<string, string> = {
      ...this.options.headers,
      "Content-Type": usePprof ? "application/octet-stream" : "text/plain",
    };
    const authorization = authHeader(this.options);
    if (authorization) headers.Authorization = authorization;
    if (this.options.tenantId) headers["X-Scope-OrgID"] = this.options.tenantId;

    let body: string | Uint8Array<ArrayBuffer>;
    if (usePprof) {
      body = encodePprof(window.profile as CdpProfile, {
        sampleIntervalUs: window.sampleIntervalUs,
        durationNanos: String((window.until - window.from) * 1_000_000_000),
        timeNanos: String(window.until * 1_000_000_000),
      }) as Uint8Array<ArrayBuffer>;
      headers["Content-Encoding"] = "gzip";
    } else if (this.options.compress) {
      const gzipped = gzipSync(Buffer.from(window.folded, "utf8"));
      body = new Uint8Array(
        gzipped.buffer,
        gzipped.byteOffset,
        gzipped.byteLength
      ) as Uint8Array<ArrayBuffer>;
      headers["Content-Encoding"] = "gzip";
    } else {
      body = window.folded;
    }

    try {
      const response = await fetch(`${this.options.url}/ingest?${params.toString()}`, {
        method: "POST",
        headers,
        body,
        signal: deadline.signal,
      });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
      const text = await response.text().catch(() => "(unreadable)");
      const retryable =
        response.status >= 500 || response.status === 429 || response.status === 408;
      throw new ExporterError(`HTTP ${response.status}: ${text}`, {
        retryable,
        status: response.status,
        retryAfterMs: retryable ? parseRetryAfter(response.headers.get("Retry-After")) : undefined,
      });
    } catch (error) {
      if (error instanceof ExporterError) throw error;
      if (deadline.timedOut()) {
        throw new ExporterError(`export timed out after ${this.options.timeoutMs ?? 10_000}ms`);
      }
      if (signal?.aborted) throw new ExporterError("export aborted", { retryable: false });
      throw new ExporterError(error instanceof Error ? error.message : String(error));
    } finally {
      deadline.cleanup();
    }
  }
}

export function pyroscopeExporter(options: PyroscopeExporterOptions): ProfileExporter {
  if (!options.url) throw new ProfilerConfigError("Pyroscope exporter URL is required");
  if (options.authToken && options.basicAuth) {
    throw new ProfilerConfigError(
      "Pyroscope exporter authToken and basicAuth are mutually exclusive"
    );
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new ProfilerConfigError("Pyroscope exporter timeoutMs must be greater than zero");
  }
  return new PyroscopeExporter(options);
}

export function callbackExporter(
  name: string,
  callback: (window: ProfileWindow, signal?: AbortSignal) => void | Promise<void>
): ProfileExporter {
  if (!name.trim()) throw new ProfilerConfigError("callback exporter name must not be empty");
  return { name, export: async (window, signal) => callback(window, signal) };
}

export function pprofFileExporter(options: PprofFileExporterOptions): ProfileExporter {
  const format = options.format ?? "pprof";
  let sequence = 0;
  return {
    name: options.name ?? `file-${format}`,
    async export(window) {
      if (window.type !== "cpu") return;
      await mkdir(options.directory, { recursive: true });
      const stem = `${window.appName.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${window.from}-${sequence++}`;
      if (format === "pprof") {
        await writeFile(
          `${options.directory}/${stem}.pb.gz`,
          encodePprof(window.profile as CdpProfile, {
            sampleIntervalUs: window.sampleIntervalUs,
            durationNanos: String((window.until - window.from) * 1_000_000_000),
            timeNanos: String(window.until * 1_000_000_000),
          })
        );
      } else if (format === "cpuprofile") {
        await writeFile(`${options.directory}/${stem}.cpuprofile`, JSON.stringify(window.profile));
      } else {
        await writeFile(
          `${options.directory}/${stem}.speedscope.json`,
          JSON.stringify(convertToSpeedscope(window.profile as CdpProfile, window.appName))
        );
      }
    },
  };
}
