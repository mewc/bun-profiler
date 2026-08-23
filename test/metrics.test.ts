import { expect, it } from "bun:test";
import { renderPrometheusMetrics } from "../src/metrics";
import type { ProfilerStats } from "../src/types";

it("renders capture, exporter, and memory metrics", () => {
  const stats: ProfilerStats = {
    running: true,
    pushedWindows: 3,
    failedWindows: 1,
    emptyWindows: 2,
    lastPushAt: 1_000,
    lastError: null,
    streams: ["cpu"],
    capturedWindows: 4,
    capturedSamples: 99,
    captureFailures: 0,
    lastCaptureGapMs: 1.5,
    maxCaptureGapMs: 2,
    lastConversionDurationMs: 0.5,
    currentSampleIntervalUs: 10_000,
    samplingIntervalChanges: 0,
    exporters: {
      'remote"one': {
        exportedProfiles: 3,
        failedProfiles: 1,
        retries: 2,
        droppedProfiles: 0,
        queueDepth: 1,
        inFlight: true,
        lastSuccessAt: 1_000,
        lastError: null,
        lastExportDurationMs: 20,
        exportedBytes: 123,
      },
    },
    memory: { rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 80, externalBytes: 5 },
  };
  const rendered = renderPrometheusMetrics(stats);
  expect(rendered).toContain("bun_profiler_captured_samples_total 99");
  expect(rendered).toContain('exporter="remote\\"one"');
  expect(rendered).toContain("bun_profiler_export_queue_depth");
  expect(rendered).toContain("bun_profiler_rss_bytes 100");
});
