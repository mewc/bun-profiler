/**
 * Minimal Prometheus exposition — enough to make the bundled Prometheus and
 * the Grafana dashboard useful without pulling in a metrics library.
 *
 * The dev Prometheus config scrapes `app:3000/metrics`, so this endpoint has
 * to exist or the target sits permanently DOWN.
 */

/**
 * Bucket edges concentrated where this demo's latencies actually land
 * (~130ms parallel, ~250ms slow-query, ~280ms CPU, ~400ms waterfall,
 * ~440ms checkout under load).
 *
 * histogram_quantile interpolates linearly *within* a bucket, so a coarse
 * bucket makes the quantile a guess. With the previous 100/250/500/1000 edges
 * nearly every request fell into 250→500, and p95 for the ~130ms
 * /api/io/parallel route was reported as 466ms — the panel's whole purpose is
 * comparing that route against the waterfall, so the resolution has to be finer
 * than the difference being measured.
 */
const LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 150, 200, 250, 300, 350, 400, 500, 650, 800, 1000, 1500, 2500, 5000,
];

interface RouteStats {
  count: number;
  totalMs: number;
  buckets: number[];
}

const stats = new Map<string, RouteStats>();

export function recordRequest(route: string, status: number, durationMs: number): void {
  const key = `${route}|${status}`;
  let entry = stats.get(key);
  if (!entry) {
    entry = { count: 0, totalMs: 0, buckets: new Array(LATENCY_BUCKETS_MS.length).fill(0) };
    stats.set(key, entry);
  }
  entry.count++;
  entry.totalMs += durationMs;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (durationMs <= LATENCY_BUCKETS_MS[i]) entry.buckets[i]++;
  }
}

export function renderMetrics(): string {
  const lines: string[] = [
    "# HELP demo_http_requests_total Total HTTP requests handled by the demo app.",
    "# TYPE demo_http_requests_total counter",
  ];

  for (const [key, entry] of stats) {
    const [route, status] = key.split("|");
    lines.push(`demo_http_requests_total{route="${route}",status="${status}"} ${entry.count}`);
  }

  lines.push(
    "# HELP demo_http_request_duration_ms Request duration in milliseconds.",
    "# TYPE demo_http_request_duration_ms histogram"
  );

  for (const [key, entry] of stats) {
    const [route, status] = key.split("|");
    const labels = `route="${route}",status="${status}"`;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      lines.push(
        `demo_http_request_duration_ms_bucket{${labels},le="${LATENCY_BUCKETS_MS[i]}"} ${entry.buckets[i]}`
      );
    }
    lines.push(`demo_http_request_duration_ms_bucket{${labels},le="+Inf"} ${entry.count}`);
    lines.push(`demo_http_request_duration_ms_sum{${labels}} ${entry.totalMs.toFixed(3)}`);
    lines.push(`demo_http_request_duration_ms_count{${labels}} ${entry.count}`);
  }

  const mem = process.memoryUsage();
  lines.push(
    "# HELP demo_process_heap_used_bytes Heap currently in use.",
    "# TYPE demo_process_heap_used_bytes gauge",
    `demo_process_heap_used_bytes ${mem.heapUsed}`,
    "# HELP demo_process_rss_bytes Resident set size.",
    "# TYPE demo_process_rss_bytes gauge",
    `demo_process_rss_bytes ${mem.rss}`
  );

  return `${lines.join("\n")}\n`;
}
