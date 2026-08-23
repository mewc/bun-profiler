import { describe, expect, it } from "bun:test";
import { optionsFromEnv, parseLabels } from "../src/config";
import { ProfilerConfigError } from "../src/errors";
import { pyroscopeExporter } from "../src/exporters";
import { BunPyroscope } from "../src/profiler";

describe("environment configuration", () => {
  it("parses common Pyroscope variables and duration units", () => {
    const options = optionsFromEnv(
      {},
      {
        PYROSCOPE_SERVER_ADDRESS: "http://collector:4040",
        PYROSCOPE_APPLICATION_NAME: "orders",
        PYROSCOPE_LABELS: "region=melbourne,team:payments",
        PYROSCOPE_PROFILING_INTERVAL: "5ms",
        PYROSCOPE_UPLOAD_INTERVAL: "20s",
        PYROSCOPE_BASIC_AUTH_USER: "user",
        PYROSCOPE_BASIC_AUTH_PASSWORD: "pass",
        PYROSCOPE_TENANT_ID: "tenant-a",
        BUN_PROFILER_WALL_TIME_ENABLED: "true",
        BUN_PROFILER_MAX_PENDING_WINDOWS: "4",
        BUN_PROFILER_SHUTDOWN_TIMEOUT: "3s",
        BUN_PROFILER_EXPORT_TIMEOUT: "750ms",
      }
    );
    expect(options).toMatchObject({
      pyroscopeUrl: "http://collector:4040",
      appName: "orders",
      labels: { region: "melbourne", team: "payments" },
      sampleIntervalUs: 5_000,
      pushIntervalMs: 20_000,
      tenantId: "tenant-a",
      maxPendingWindows: 4,
      shutdownTimeoutMs: 3_000,
      exportTimeoutMs: 750,
      wallTime: { enabled: true },
    });
  });

  it("applies explicit overrides after environment values", () => {
    const options = optionsFromEnv(
      { appName: "explicit", labels: { region: "sydney" } },
      {
        PYROSCOPE_SERVER_ADDRESS: "http://localhost:4040",
        PYROSCOPE_APPLICATION_NAME: "env-name",
        PYROSCOPE_LABELS: "region=melbourne,team=core",
      }
    );
    expect(options.appName).toBe("explicit");
    expect(options.labels).toEqual({ region: "sydney", team: "core" });
  });

  it("lets an explicit authentication mode replace the environment mode", () => {
    const options = optionsFromEnv(
      { authToken: "explicit-token" },
      {
        PYROSCOPE_BASIC_AUTH_USER: "environment-user",
        PYROSCOPE_BASIC_AUTH_PASSWORD: "environment-password",
      }
    );
    expect(options.authToken).toBe("explicit-token");
    expect(options.basicAuth).toBeUndefined();
  });

  it("rejects malformed labels and partial basic auth", () => {
    expect(() => parseLabels("not-a-pair")).toThrow(ProfilerConfigError);
    expect(() => optionsFromEnv({}, { PYROSCOPE_BASIC_AUTH_USER: "lonely" })).toThrow(
      "must be set together"
    );
  });
});

describe("configuration validation", () => {
  it("requires a destination", () => {
    expect(() => new BunPyroscope({})).toThrow("pyroscopeUrl or at least one exporter");
  });

  it("rejects unsafe headers and conflicting auth", () => {
    expect(
      () =>
        new BunPyroscope({
          pyroscopeUrl: "http://localhost:4040",
          headers: { "Content-Length": "2" },
        })
    ).toThrow("cannot be overridden");
    expect(
      () =>
        new BunPyroscope({
          pyroscopeUrl: "http://localhost:4040",
          authToken: "token",
          basicAuth: { username: "u", password: "p" },
        })
    ).toThrow("mutually exclusive");
  });

  it("rejects non-positive export deadlines", () => {
    expect(
      () => new BunPyroscope({ pyroscopeUrl: "http://localhost:4040", exportTimeoutMs: 0 })
    ).toThrow("exportTimeoutMs must be a finite number greater than zero");
    expect(() => pyroscopeExporter({ url: "http://localhost:4040", timeoutMs: 0 })).toThrow(
      "timeoutMs must be greater than zero"
    );
    expect(() => optionsFromEnv({}, { BUN_PROFILER_EXPORT_TIMEOUT: "0ms" })).toThrow(
      "must be greater than zero"
    );
  });
});
