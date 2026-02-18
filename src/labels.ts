import { hostname } from "node:os";

/**
 * Resolve the application name.
 * Priority: explicit arg > SERVICE_NAME env > npm_package_name env > "bun-app"
 */
export function resolveAppName(appName?: string): string {
  return appName ?? process.env.SERVICE_NAME ?? process.env.npm_package_name ?? "bun-app";
}

/**
 * Detect cloud/platform labels from well-known environment variables.
 * Returns only keys where the env var is actually set.
 */
export function detectPlatformLabels(): Record<string, string> {
  const labels: Record<string, string> = {};

  // Fly.io
  if (process.env.FLY_REGION) labels.fly_region = process.env.FLY_REGION;
  if (process.env.FLY_APP_NAME) labels.fly_app_name = process.env.FLY_APP_NAME;

  // AWS
  const awsRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (awsRegion) labels.aws_region = awsRegion;

  // Railway
  if (process.env.RAILWAY_REGION) labels.railway_region = process.env.RAILWAY_REGION;
  if (process.env.RAILWAY_SERVICE_NAME) labels.railway_service = process.env.RAILWAY_SERVICE_NAME;

  // Kubernetes (injected via downward API)
  if (process.env.POD_NAME) labels.pod_name = process.env.POD_NAME;
  if (process.env.K8S_NAMESPACE) labels.k8s_namespace = process.env.K8S_NAMESPACE;

  return labels;
}

/**
 * Build the full default label set for a given app name.
 * Always includes: hostname, service_name.
 * Conditionally includes: environment, service_version, and platform labels.
 */
export function buildDefaultLabels(appName: string): Record<string, string> {
  const labels: Record<string, string> = {
    hostname: hostname(),
    service_name: appName,
  };

  const env = process.env.NODE_ENV ?? process.env.BUN_ENV;
  if (env) labels.environment = env;

  const version = process.env.SERVICE_VERSION ?? process.env.npm_package_version;
  if (version) labels.service_version = version;

  Object.assign(labels, detectPlatformLabels());

  return labels;
}

/**
 * Encode labels into the Pyroscope name query parameter format.
 *
 * Format: "appName.cpu{key=value,key2=value2}"
 * Keys are sorted for deterministic output. Special chars in keys/values
 * that would break the label syntax are replaced with underscores.
 *
 * Examples:
 *   encodePyroscopeName("myapp", {}) → "myapp.cpu"
 *   encodePyroscopeName("myapp", {env: "prod", host: "web-1"}) → "myapp.cpu{env=prod,host=web-1}"
 */
export function encodePyroscopeName(appName: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return `${appName}.cpu`;

  entries.sort(([a], [b]) => a.localeCompare(b));
  const labelStr = entries
    .map(([k, v]) => {
      const safeK = k.replace(/[{}=,\s]/g, "_");
      const safeV = v.replace(/[{}=,]/g, "_");
      return `${safeK}=${safeV}`;
    })
    .join(",");

  return `${appName}.cpu{${labelStr}}`;
}
