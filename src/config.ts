import { ProfilerConfigError } from "./errors.js";
import { buildDefaultLabels, resolveAppName } from "./labels.js";
import type { BunPyroscopeOptions, ResolvedConfig } from "./types.js";

const BLOCKED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
]);

function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new ProfilerConfigError(`${name} must be true, false, 1, or 0`);
}

function parseInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProfilerConfigError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseDurationMs(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)(us|ms|s|m)$/.exec(value.trim());
  if (!match) throw new ProfilerConfigError(`${name} must include us, ms, s, or m`);
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "us" ? 0.001 : unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000;
  const result = amount * multiplier;
  if (!Number.isFinite(result) || result <= 0) {
    throw new ProfilerConfigError(`${name} must be greater than zero`);
  }
  return result;
}

function parseDurationUs(name: string, value: string | undefined): number | undefined {
  const milliseconds = parseDurationMs(name, value);
  return milliseconds === undefined ? undefined : Math.round(milliseconds * 1_000);
}

export function parseLabels(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined;
  const labels: Record<string, string> = {};
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    const separator = entry.includes("=") ? entry.indexOf("=") : entry.indexOf(":");
    if (separator <= 0) {
      throw new ProfilerConfigError("PYROSCOPE_LABELS must use key=value pairs");
    }
    const key = entry.slice(0, separator).trim();
    const labelValue = entry.slice(separator + 1).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new ProfilerConfigError(`invalid label key ${JSON.stringify(key)}`);
    }
    if (!labelValue) throw new ProfilerConfigError(`label ${key} must not be empty`);
    labels[key] = labelValue;
  }
  return labels;
}

/** Resolve only environment-backed configuration. Explicit overrides win. */
export function optionsFromEnv(
  overrides: Partial<BunPyroscopeOptions> = {},
  env: Record<string, string | undefined> = process.env
): BunPyroscopeOptions {
  const profilingMs = parseDurationMs(
    "PYROSCOPE_PROFILING_INTERVAL",
    env.PYROSCOPE_PROFILING_INTERVAL
  );
  const uploadMs = parseDurationMs("PYROSCOPE_UPLOAD_INTERVAL", env.PYROSCOPE_UPLOAD_INTERVAL);
  const user = env.PYROSCOPE_BASIC_AUTH_USER;
  const password = env.PYROSCOPE_BASIC_AUTH_PASSWORD;
  if ((user && !password) || (!user && password)) {
    throw new ProfilerConfigError(
      "PYROSCOPE_BASIC_AUTH_USER and PYROSCOPE_BASIC_AUTH_PASSWORD must be set together"
    );
  }

  const envOptions: BunPyroscopeOptions = {
    pyroscopeUrl: env.PYROSCOPE_SERVER_ADDRESS,
    appName: env.PYROSCOPE_APPLICATION_NAME,
    labels: parseLabels(env.PYROSCOPE_LABELS),
    sampleIntervalUs: profilingMs === undefined ? undefined : Math.round(profilingMs * 1_000),
    pushIntervalMs: uploadMs,
    basicAuth: user && password ? { username: user, password } : undefined,
    authToken: env.BUN_PROFILER_AUTH_TOKEN,
    tenantId: env.PYROSCOPE_TENANT_ID,
    maxRetries: parseInteger("BUN_PROFILER_MAX_RETRIES", env.BUN_PROFILER_MAX_RETRIES),
    maxPendingWindows: parseInteger(
      "BUN_PROFILER_MAX_PENDING_WINDOWS",
      env.BUN_PROFILER_MAX_PENDING_WINDOWS
    ),
    shutdownTimeoutMs: parseDurationMs(
      "BUN_PROFILER_SHUTDOWN_TIMEOUT",
      env.BUN_PROFILER_SHUTDOWN_TIMEOUT
    ),
    exportTimeoutMs: parseDurationMs(
      "BUN_PROFILER_EXPORT_TIMEOUT",
      env.BUN_PROFILER_EXPORT_TIMEOUT
    ),
    debug: parseBoolean("BUN_PROFILER_DEBUG", env.BUN_PROFILER_DEBUG),
    compress: parseBoolean("BUN_PROFILER_COMPRESS", env.BUN_PROFILER_COMPRESS),
    pyroscopeFormat:
      env.BUN_PROFILER_PYROSCOPE_FORMAT === "pprof"
        ? "pprof"
        : env.BUN_PROFILER_PYROSCOPE_FORMAT === "folded" ||
            env.BUN_PROFILER_PYROSCOPE_FORMAT === undefined
          ? "folded"
          : (() => {
              throw new ProfilerConfigError(
                "BUN_PROFILER_PYROSCOPE_FORMAT must be folded or pprof"
              );
            })(),
    wallTime: {
      enabled:
        parseBoolean("BUN_PROFILER_WALL_TIME_ENABLED", env.BUN_PROFILER_WALL_TIME_ENABLED) ?? false,
    },
    sourceMaps: {
      enabled:
        parseBoolean("BUN_PROFILER_SOURCE_MAPS_ENABLED", env.BUN_PROFILER_SOURCE_MAPS_ENABLED) ??
        false,
      cacheSize: parseInteger(
        "BUN_PROFILER_SOURCE_MAP_CACHE_SIZE",
        env.BUN_PROFILER_SOURCE_MAP_CACHE_SIZE
      ),
    },
    adaptiveSampling: {
      enabled:
        parseBoolean("BUN_PROFILER_ADAPTIVE_ENABLED", env.BUN_PROFILER_ADAPTIVE_ENABLED) ?? false,
      busyIntervalUs: parseDurationUs(
        "BUN_PROFILER_ADAPTIVE_BUSY_INTERVAL",
        env.BUN_PROFILER_ADAPTIVE_BUSY_INTERVAL
      ),
      idleIntervalUs: parseDurationUs(
        "BUN_PROFILER_ADAPTIVE_IDLE_INTERVAL",
        env.BUN_PROFILER_ADAPTIVE_IDLE_INTERVAL
      ),
    },
    heap: {
      enabled: parseBoolean("BUN_PROFILER_HEAP_ENABLED", env.BUN_PROFILER_HEAP_ENABLED) ?? false,
      samplingIntervalBytes: parseInteger(
        "BUN_PROFILER_HEAP_SAMPLING_INTERVAL_BYTES",
        env.BUN_PROFILER_HEAP_SAMPLING_INTERVAL_BYTES
      ),
    },
  };

  const resolved: BunPyroscopeOptions = {
    ...envOptions,
    ...overrides,
    labels: { ...(envOptions.labels ?? {}), ...(overrides.labels ?? {}) },
    wallTime: overrides.wallTime ?? envOptions.wallTime,
    heap: overrides.heap ?? envOptions.heap,
  };
  // Authentication is one logical choice. An explicit choice replaces the
  // environment-backed alternative instead of creating a false conflict.
  if (overrides.authToken !== undefined && overrides.basicAuth === undefined) {
    resolved.basicAuth = undefined;
  }
  if (overrides.basicAuth !== undefined && overrides.authToken === undefined) {
    resolved.authToken = undefined;
  }
  return resolved;
}

function requirePositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ProfilerConfigError(`${name} must be a finite number greater than zero`);
  }
}

function validateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProfilerConfigError("pyroscopeUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProfilerConfigError("pyroscopeUrl must use http or https");
  }
  return value.replace(/\/$/, "");
}

function validateHeaders(headers: Record<string, string>): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new ProfilerConfigError(`invalid HTTP header name ${JSON.stringify(name)}`);
    }
    if (BLOCKED_HEADERS.has(name.toLowerCase())) {
      throw new ProfilerConfigError(`${name} is managed by bun-profiler and cannot be overridden`);
    }
    if (typeof value !== "string" || /\r|\n/.test(value)) {
      throw new ProfilerConfigError(`${name} must be a string without newlines`);
    }
    validated[name] = value;
  }
  return validated;
}

export function resolveConfig(options: BunPyroscopeOptions): ResolvedConfig {
  if (!options.pyroscopeUrl && (!options.exporters || options.exporters.length === 0)) {
    throw new ProfilerConfigError("pyroscopeUrl or at least one exporter is required");
  }
  if (options.authToken && options.basicAuth) {
    throw new ProfilerConfigError("authToken and basicAuth are mutually exclusive");
  }
  if (options.basicAuth && (!options.basicAuth.username || !options.basicAuth.password)) {
    throw new ProfilerConfigError("basicAuth requires both username and password");
  }
  if (
    options.pyroscopeFormat &&
    options.pyroscopeFormat !== "folded" &&
    options.pyroscopeFormat !== "pprof"
  ) {
    throw new ProfilerConfigError("pyroscopeFormat must be folded or pprof");
  }
  if (options.tenantId && /\r|\n/.test(options.tenantId)) {
    throw new ProfilerConfigError("tenantId must not contain newlines");
  }
  for (const [key, value] of Object.entries(options.labels ?? {})) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new ProfilerConfigError(`invalid label key ${JSON.stringify(key)}`);
    }
    if (typeof value !== "string" || !value || /\r|\n/.test(value)) {
      throw new ProfilerConfigError(`label ${key} must be a non-empty single-line string`);
    }
  }

  const sampleIntervalUs = options.sampleIntervalUs ?? 10_000;
  const pushIntervalMs = options.pushIntervalMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 2;
  const maxPendingWindows = options.maxPendingWindows ?? 2;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  const exportTimeoutMs = options.exportTimeoutMs ?? 10_000;
  const heapSamplingInterval = options.heap?.samplingIntervalBytes ?? 32_768;
  const sourceMapCacheSize = options.sourceMaps?.cacheSize ?? 64;
  const adaptiveBusyInterval = options.adaptiveSampling?.busyIntervalUs ?? sampleIntervalUs;
  const adaptiveIdleInterval = options.adaptiveSampling?.idleIntervalUs ?? sampleIntervalUs * 5;
  const adaptiveBusyThreshold = options.adaptiveSampling?.busyThreshold ?? 0.25;
  requirePositiveFinite("sampleIntervalUs", sampleIntervalUs);
  requirePositiveFinite("pushIntervalMs", pushIntervalMs);
  requirePositiveFinite("maxPendingWindows", maxPendingWindows);
  requirePositiveFinite("shutdownTimeoutMs", shutdownTimeoutMs);
  requirePositiveFinite("exportTimeoutMs", exportTimeoutMs);
  requirePositiveFinite("heap.samplingIntervalBytes", heapSamplingInterval);
  requirePositiveFinite("sourceMaps.cacheSize", sourceMapCacheSize);
  requirePositiveFinite("adaptiveSampling.busyIntervalUs", adaptiveBusyInterval);
  requirePositiveFinite("adaptiveSampling.idleIntervalUs", adaptiveIdleInterval);
  for (const [name, value] of [
    ["sampleIntervalUs", sampleIntervalUs],
    ["maxPendingWindows", maxPendingWindows],
    ["heap.samplingIntervalBytes", heapSamplingInterval],
    ["sourceMaps.cacheSize", sourceMapCacheSize],
    ["adaptiveSampling.busyIntervalUs", adaptiveBusyInterval],
    ["adaptiveSampling.idleIntervalUs", adaptiveIdleInterval],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new ProfilerConfigError(`${name} must be an integer`);
    }
  }
  if (adaptiveBusyThreshold <= 0 || adaptiveBusyThreshold > 1) {
    throw new ProfilerConfigError(
      "adaptiveSampling.busyThreshold must be greater than 0 and at most 1"
    );
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new ProfilerConfigError("maxRetries must be a non-negative integer");
  }

  const appName = resolveAppName(options.appName);
  if (!appName.trim()) throw new ProfilerConfigError("appName must not be empty");

  return {
    pyroscopeUrl: options.pyroscopeUrl ? validateUrl(options.pyroscopeUrl) : undefined,
    appName,
    sampleIntervalUs,
    pushIntervalMs,
    labels: { ...buildDefaultLabels(appName), ...(options.labels ?? {}) },
    authToken: options.authToken,
    basicAuth: options.basicAuth,
    tenantId: options.tenantId,
    headers: validateHeaders(options.headers ?? {}),
    maxRetries,
    maxPendingWindows: Math.floor(maxPendingWindows),
    shutdownTimeoutMs,
    exportTimeoutMs,
    debug: options.debug ?? false,
    compress: options.compress ?? false,
    pyroscopeFormat: options.pyroscopeFormat ?? "folded",
    exporters: options.exporters ?? [],
    heap: { enabled: options.heap?.enabled ?? false, samplingIntervalBytes: heapSamplingInterval },
    wallTime: { enabled: options.wallTime?.enabled ?? false },
    sourceMaps: { enabled: options.sourceMaps?.enabled ?? false, cacheSize: sourceMapCacheSize },
    adaptiveSampling: {
      enabled: options.adaptiveSampling?.enabled ?? false,
      busyIntervalUs: adaptiveBusyInterval,
      idleIntervalUs: adaptiveIdleInterval,
      busyThreshold: adaptiveBusyThreshold,
    },
  };
}
