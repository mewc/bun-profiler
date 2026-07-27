/**
 * Regenerate the screenshots used in the README.
 *
 * Drives the real stack with a real browser — it clicks "Run all", waits for the
 * profiler to actually push a window, and captures what Grafana renders. There
 * is no mocking, so a passing run is evidence the demo works end to end.
 *
 * Usage:
 *   bun run dev            # stack must be up first
 *   bun run screenshots
 *
 * Ports come from dev/_env.sh's defaults or the environment, so this works in a
 * Conductor workspace as well as a plain checkout.
 */

import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

const APP_PORT = process.env.APP_PORT ?? "3002";
const GRAFANA_PORT = process.env.GRAFANA_PORT ?? "3003";
const PROMETHEUS_PORT = process.env.PROMETHEUS_PORT ?? "9091";

const APP_URL = `http://localhost:${APP_PORT}`;
const GRAFANA_URL = `http://localhost:${GRAFANA_PORT}`;
const PROMETHEUS_URL = `http://localhost:${PROMETHEUS_PORT}`;
const OUT_DIR = new URL("../docs/images/", import.meta.url).pathname;

/**
 * How long to drive traffic before capturing Grafana.
 *
 * A single "Run all" pass is not enough for the dashboard: Prometheus scrapes
 * every 15s and the panels use rate(...[1m]), so a short burst renders as
 * "No data". Sustained traffic also gives a more representative wall profile —
 * one I/O-heavy burst alone reads as ~95% idle.
 */
const TRAFFIC_MS = 90_000;

/** Weighted like dev/loadgen.sh, so the flamegraph isn't dominated by one route. */
const TRAFFIC_MIX = [
  "/api/checkout",
  "/api/checkout",
  "/api/checkout",
  "/api/io/waterfall",
  "/api/io/parallel",
  "/api/io/slow-query",
  "/api/io/upstream",
  "/api/cpu/fib",
  "/api/cpu/sort",
  "/api/cpu/json",
  "/api/cpu/regex",
  "/api/cpu/hash",
];

function log(msg: string): void {
  console.log(`[screenshots] ${msg}`);
}

async function assertUp(url: string, name: string): Promise<void> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) {
    throw new Error(`${name} is not responding at ${url}. Start the stack with: bun run dev`);
  }
}

async function shoot(page: Page, file: string, fullPage = false): Promise<void> {
  const path = `${OUT_DIR}${file}`;
  await page.screenshot({ path, fullPage });
  log(`wrote ${file}`);
}

/** Hit the demo with a weighted mix, a few requests in flight at a time. */
async function driveTraffic(durationMs: number): Promise<number> {
  const deadline = Date.now() + durationMs;
  const CONCURRENCY = 4;
  let sent = 0;

  const worker = async (offset: number) => {
    let i = offset;
    while (Date.now() < deadline) {
      const path = TRAFFIC_MIX[i % TRAFFIC_MIX.length];
      i += CONCURRENCY;
      await fetch(`${APP_URL}${path}`).catch(() => undefined);
      sent++;
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => worker(n)));
  return sent;
}

/** Poll Prometheus until the dashboard's own query actually returns series. */
async function waitForPrometheusData(timeoutMs = 90_000): Promise<void> {
  const query = "sum by (route) (rate(demo_http_requests_total[1m]))";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`
    ).catch(() => null);

    if (res?.ok) {
      const body = (await res.json()) as { data?: { result?: unknown[] } };
      const series = body.data?.result?.length ?? 0;
      if (series > 0) {
        log(`Prometheus is returning ${series} series`);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  log("warning: Prometheus still has no series — the rate panels may render empty");
}

/**
 * Grafana renders flamegraphs in canvas/SVG after its queries resolve; waiting
 * on a selector alone races the paint.
 */
async function waitForGrafanaPanels(page: Page): Promise<void> {
  await page.waitForSelector("text=CPU profile", { timeout: 60_000 });
  await page.waitForSelector("text=Wall profile", { timeout: 60_000 });
  // "(idle)" only appears once wall-time data has actually landed.
  await page
    .waitForSelector("text=(idle)", { timeout: 60_000 })
    .catch(() => log("warning: no (idle) frame yet — generate more I/O traffic"));
  await page.waitForTimeout(2500);
}

async function capturePanel(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1600 } });
  await page.goto(APP_URL, { waitUntil: "networkidle" });

  log("clicking 'Run all' and waiting for every workload to finish…");
  await page.getByRole("button", { name: /Run all \d+ workloads/ }).click();

  // The button re-enables only after the last workload returns.
  await page.waitForFunction(
    () => {
      const b = document.getElementById("all") as HTMLButtonElement | null;
      return b !== null && !b.disabled;
    },
    { timeout: 180_000 }
  );

  const results = await page.locator("output.show").count();
  const links = await page.locator("output .viz").count();
  log(`${results} workloads reported results, ${links} carry a Grafana link`);
  if (results === 0) throw new Error("no workload produced a result");
  if (links !== results) throw new Error(`expected a Grafana link per result, got ${links}`);

  await page.waitForTimeout(500);
  await shoot(page, "demo-panel.png", true);
  await page.close();
}

async function captureGrafana(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  await page.goto(`${GRAFANA_URL}/d/bun-profiler-demo?kiosk&from=now-15m&to=now`, {
    waitUntil: "networkidle",
  });
  await waitForGrafanaPanels(page);

  // Catch the failure mode where the flamegraphs render but the Prometheus
  // panels are empty — a screenshot with "No data" in it is worse than none.
  const empty = await page.getByText("No data", { exact: true }).count();
  if (empty > 0) {
    throw new Error(
      `${empty} panel(s) rendered "No data". Let the stack run longer, then re-run.`
    );
  }

  await shoot(page, "grafana-dashboard.png");

  // The wall panel on its own, where the (idle) block is legible.
  await page.setViewportSize({ width: 1600, height: 760 });
  await page.goto(`${GRAFANA_URL}/d/bun-profiler-demo?kiosk&viewPanel=3&from=now-15m&to=now`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector("text=Wall profile", { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await shoot(page, "wall-flamegraph.png");

  await page.close();
}

async function main(): Promise<void> {
  await assertUp(`${APP_URL}/health`, "The demo app");
  await assertUp(`${GRAFANA_URL}/api/health`, "Grafana");
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    await capturePanel(browser);

    log(`driving ${TRAFFIC_MS / 1000}s of mixed traffic so the dashboard has real data…`);
    const sent = await driveTraffic(TRAFFIC_MS);
    log(`${sent} requests sent`);

    await waitForPrometheusData();
    // One more profiler push interval so the last window reaches Pyroscope.
    await new Promise((r) => setTimeout(r, 10_000));

    await captureGrafana(browser);
  } finally {
    await browser.close();
  }

  log("done");
}

await main();
