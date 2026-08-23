import type { ProfilerStats } from "./types.js";

type StatsSource = ProfilerStats | { stats(): ProfilerStats };

function metricLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Render profiler health in Prometheus text exposition format. */
export function renderPrometheusMetrics(source: StatsSource): string {
  const stats: ProfilerStats =
    "stats" in source && typeof source.stats === "function"
      ? source.stats()
      : (source as ProfilerStats);
  const lines = [
    "# HELP bun_profiler_running Whether the capture loop is active.",
    "# TYPE bun_profiler_running gauge",
    `bun_profiler_running ${stats.running ? 1 : 0}`,
    "# HELP bun_profiler_captured_windows_total Completed CPU capture windows.",
    "# TYPE bun_profiler_captured_windows_total counter",
    `bun_profiler_captured_windows_total ${stats.capturedWindows}`,
    "# HELP bun_profiler_captured_samples_total CDP samples captured.",
    "# TYPE bun_profiler_captured_samples_total counter",
    `bun_profiler_captured_samples_total ${stats.capturedSamples}`,
    "# HELP bun_profiler_capture_failures_total Failed inspector captures.",
    "# TYPE bun_profiler_capture_failures_total counter",
    `bun_profiler_capture_failures_total ${stats.captureFailures}`,
    "# HELP bun_profiler_empty_windows_total Windows with no usable CPU samples.",
    "# TYPE bun_profiler_empty_windows_total counter",
    `bun_profiler_empty_windows_total ${stats.emptyWindows}`,
    "# HELP bun_profiler_capture_gap_seconds Most recent stop-to-start sampling gap.",
    "# TYPE bun_profiler_capture_gap_seconds gauge",
    `bun_profiler_capture_gap_seconds ${(stats.lastCaptureGapMs ?? 0) / 1_000}`,
    "# HELP bun_profiler_capture_gap_max_seconds Largest observed sampling gap.",
    "# TYPE bun_profiler_capture_gap_max_seconds gauge",
    `bun_profiler_capture_gap_max_seconds ${stats.maxCaptureGapMs / 1_000}`,
    "# HELP bun_profiler_conversion_duration_seconds Most recent profile conversion duration.",
    "# TYPE bun_profiler_conversion_duration_seconds gauge",
    `bun_profiler_conversion_duration_seconds ${(stats.lastConversionDurationMs ?? 0) / 1_000}`,
    "# TYPE bun_profiler_sample_interval_microseconds gauge",
    `bun_profiler_sample_interval_microseconds ${stats.currentSampleIntervalUs}`,
    "# TYPE bun_profiler_sample_interval_changes_total counter",
    `bun_profiler_sample_interval_changes_total ${stats.samplingIntervalChanges}`,
  ];

  const exporterMetrics: Array<
    [string, keyof ProfilerStats["exporters"][string], "counter" | "gauge"]
  > = [
    ["exported_profiles_total", "exportedProfiles", "counter"],
    ["export_failures_total", "failedProfiles", "counter"],
    ["export_retries_total", "retries", "counter"],
    ["export_dropped_total", "droppedProfiles", "counter"],
    ["export_queue_depth", "queueDepth", "gauge"],
    ["exported_bytes_total", "exportedBytes", "counter"],
  ];
  for (const [metric, field, type] of exporterMetrics) {
    lines.push(`# TYPE bun_profiler_${metric} ${type}`);
    for (const [name, exporter] of Object.entries(stats.exporters)) {
      lines.push(
        `bun_profiler_${metric}{exporter="${metricLabel(name)}"} ${Number(exporter[field])}`
      );
    }
  }
  lines.push("# TYPE bun_profiler_export_in_flight gauge");
  lines.push("# TYPE bun_profiler_export_last_success_unixtime gauge");
  lines.push("# TYPE bun_profiler_export_duration_seconds gauge");
  for (const [name, exporter] of Object.entries(stats.exporters)) {
    const label = `exporter="${metricLabel(name)}"`;
    lines.push(`bun_profiler_export_in_flight{${label}} ${exporter.inFlight ? 1 : 0}`);
    lines.push(
      `bun_profiler_export_last_success_unixtime{${label}} ${(exporter.lastSuccessAt ?? 0) / 1_000}`
    );
    lines.push(
      `bun_profiler_export_duration_seconds{${label}} ${(exporter.lastExportDurationMs ?? 0) / 1_000}`
    );
  }
  for (const [name, value] of Object.entries({
    rss_bytes: stats.memory.rssBytes,
    heap_used_bytes: stats.memory.heapUsedBytes,
    heap_total_bytes: stats.memory.heapTotalBytes,
    external_bytes: stats.memory.externalBytes,
    jsc_heap_size_bytes: stats.memory.jscHeapSizeBytes,
    jsc_heap_capacity_bytes: stats.memory.jscHeapCapacityBytes,
    jsc_extra_memory_size_bytes: stats.memory.jscExtraMemorySizeBytes,
  })) {
    if (value === undefined) continue;
    lines.push(`# TYPE bun_profiler_${name} gauge`, `bun_profiler_${name} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}
