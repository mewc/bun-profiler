import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildDefaultLabels,
  detectPlatformLabels,
  encodePyroscopeName,
  resolveAppName,
} from "../src/labels";

// Snapshot and restore specific env vars across tests
const ENV_KEYS = [
  "SERVICE_NAME",
  "npm_package_name",
  "SERVICE_VERSION",
  "npm_package_version",
  "NODE_ENV",
  "BUN_ENV",
  "FLY_REGION",
  "FLY_APP_NAME",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "RAILWAY_REGION",
  "RAILWAY_SERVICE_NAME",
  "POD_NAME",
  "K8S_NAMESPACE",
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("resolveAppName", () => {
  it("returns explicit appName over all env vars", () => {
    process.env.SERVICE_NAME = "from-env";
    expect(resolveAppName("explicit")).toBe("explicit");
  });

  it("falls back to SERVICE_NAME when no explicit name", () => {
    process.env.SERVICE_NAME = "from-service-name";
    expect(resolveAppName()).toBe("from-service-name");
  });

  it("falls back to npm_package_name when SERVICE_NAME is absent", () => {
    process.env.npm_package_name = "my-npm-pkg";
    expect(resolveAppName()).toBe("my-npm-pkg");
  });

  it('falls back to "bun-app" when no env vars are set', () => {
    expect(resolveAppName()).toBe("bun-app");
  });

  it("prefers SERVICE_NAME over npm_package_name", () => {
    process.env.SERVICE_NAME = "svc";
    process.env.npm_package_name = "pkg";
    expect(resolveAppName()).toBe("svc");
  });
});

describe("detectPlatformLabels", () => {
  it("returns empty object when no platform env vars are set", () => {
    expect(detectPlatformLabels()).toEqual({});
  });

  it("detects Fly.io region and app name", () => {
    process.env.FLY_REGION = "iad";
    process.env.FLY_APP_NAME = "my-fly-app";
    const labels = detectPlatformLabels();
    expect(labels.fly_region).toBe("iad");
    expect(labels.fly_app_name).toBe("my-fly-app");
  });

  it("detects AWS_REGION", () => {
    process.env.AWS_REGION = "us-east-1";
    expect(detectPlatformLabels().aws_region).toBe("us-east-1");
  });

  it("falls back to AWS_DEFAULT_REGION when AWS_REGION is absent", () => {
    process.env.AWS_DEFAULT_REGION = "eu-west-1";
    expect(detectPlatformLabels().aws_region).toBe("eu-west-1");
  });

  it("prefers AWS_REGION over AWS_DEFAULT_REGION", () => {
    process.env.AWS_REGION = "us-west-2";
    process.env.AWS_DEFAULT_REGION = "us-east-1";
    expect(detectPlatformLabels().aws_region).toBe("us-west-2");
  });

  it("detects Railway labels", () => {
    process.env.RAILWAY_REGION = "us-west2";
    process.env.RAILWAY_SERVICE_NAME = "api";
    const labels = detectPlatformLabels();
    expect(labels.railway_region).toBe("us-west2");
    expect(labels.railway_service).toBe("api");
  });

  it("detects Kubernetes pod and namespace", () => {
    process.env.POD_NAME = "api-abc123";
    process.env.K8S_NAMESPACE = "production";
    const labels = detectPlatformLabels();
    expect(labels.pod_name).toBe("api-abc123");
    expect(labels.k8s_namespace).toBe("production");
  });
});

describe("buildDefaultLabels", () => {
  it("always includes hostname and service_name", () => {
    const labels = buildDefaultLabels("my-service");
    expect(labels.hostname).toBeTruthy();
    expect(labels.service_name).toBe("my-service");
  });

  it("includes environment from NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    const labels = buildDefaultLabels("app");
    expect(labels.environment).toBe("production");
  });

  it("includes environment from BUN_ENV when NODE_ENV absent", () => {
    process.env.BUN_ENV = "staging";
    const labels = buildDefaultLabels("app");
    expect(labels.environment).toBe("staging");
  });

  it("omits environment when neither NODE_ENV nor BUN_ENV is set", () => {
    const labels = buildDefaultLabels("app");
    expect(Object.keys(labels)).not.toContain("environment");
  });

  it("includes service_version from SERVICE_VERSION", () => {
    process.env.SERVICE_VERSION = "1.2.3";
    const labels = buildDefaultLabels("app");
    expect(labels.service_version).toBe("1.2.3");
  });

  it("falls back to npm_package_version for service_version", () => {
    process.env.npm_package_version = "2.0.0";
    const labels = buildDefaultLabels("app");
    expect(labels.service_version).toBe("2.0.0");
  });

  it("merges platform labels", () => {
    process.env.FLY_REGION = "iad";
    const labels = buildDefaultLabels("app");
    expect(labels.fly_region).toBe("iad");
  });
});

describe("encodePyroscopeName", () => {
  it("appends .cpu with no labels", () => {
    expect(encodePyroscopeName("myapp", {})).toBe("myapp.cpu");
  });

  it("encodes a single label", () => {
    expect(encodePyroscopeName("myapp", { env: "prod" })).toBe("myapp.cpu{env=prod}");
  });

  it("sorts labels alphabetically for deterministic output", () => {
    expect(encodePyroscopeName("myapp", { z: "last", a: "first" })).toBe(
      "myapp.cpu{a=first,z=last}"
    );
  });

  it("sanitizes key special chars to underscores", () => {
    const result = encodePyroscopeName("myapp", { "key with spaces": "value" });
    expect(result).toContain("key_with_spaces=value");
  });

  it("sanitizes value special chars to underscores", () => {
    const result = encodePyroscopeName("myapp", { key: "val=with=equals" });
    expect(result).toContain("key=val_with_equals");
  });

  it("sanitizes braces in values", () => {
    const result = encodePyroscopeName("myapp", { key: "val{bad}" });
    expect(result).toContain("val_bad_");
    expect(result).not.toContain("{bad}");
  });

  it("handles multiple labels in sorted order", () => {
    const result = encodePyroscopeName("svc", {
      hostname: "web-1",
      environment: "production",
      service_version: "1.0.0",
    });
    expect(result).toBe("svc.cpu{environment=production,hostname=web-1,service_version=1.0.0}");
  });
});
