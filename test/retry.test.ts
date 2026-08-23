import { describe, expect, test } from "bun:test";
import { ExporterError } from "../src/errors.js";
import { pyroscopeExporter } from "../src/exporters.js";
import { MAX_RETRY_AFTER_MS, parseRetryAfter, retryDelayMs } from "../src/retry.js";
import type { ProfileWindow } from "../src/types.js";

const window: ProfileWindow = Object.freeze({
  type: "cpu",
  appName: "retry-test",
  labels: Object.freeze({}),
  from: 1,
  until: 2,
  sampleRate: 100,
  sampleIntervalUs: 10_000,
  folded: "work 1",
  profile: { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 },
});

describe("Retry-After parsing", () => {
  test("accepts delay-seconds and HTTP dates", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
    expect(parseRetryAfter("12", now)).toBe(12_000);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now)).toBe(60_000);
  });

  test("ignores invalid values, floors past dates at zero, and caps extreme delays", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
    expect(parseRetryAfter("not-a-date", now)).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:26:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("86400", now)).toBe(MAX_RETRY_AFTER_MS);
  });

  test("preserves server retry metadata on exporter errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("busy", { status: 503, headers: { "Retry-After": "12" } })) as typeof fetch;
    try {
      await pyroscopeExporter({ url: "http://collector:4040" }).export(window);
      throw new Error("expected exporter to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ExporterError);
      expect((error as ExporterError).retryAfterMs).toBe(12_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("retry jitter", () => {
  test("uses equal jitter for exponential backoff", () => {
    expect(retryDelayMs(1, undefined, () => 0)).toBe(500);
    expect(retryDelayMs(2, undefined, () => 0.5)).toBe(1_500);
    expect(retryDelayMs(10, undefined, () => 1)).toBe(30_000);
  });

  test("only adds positive jitter to Retry-After", () => {
    expect(retryDelayMs(1, 10_000, () => 0)).toBe(10_000);
    expect(retryDelayMs(1, 10_000, () => 1)).toBe(11_000);
  });
});
