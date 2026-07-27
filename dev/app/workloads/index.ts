/**
 * The workload registry.
 *
 * Both the HTTP routes and the HTML control panel are generated from this one
 * list, so there is a single place to add a new demo workload.
 */

import { buildCart, handleCheckout } from "./checkout.ts";
import { runFibonacci, runHashChain, runJsonRoundtrip, runLogScan, runSort } from "./cpu.ts";
import { callUpstream, queryDatabase, runParallelQueries, runWaterfall, sleep } from "./io.ts";

export type WorkloadKind = "cpu" | "io" | "mixed";

export interface Workload {
  path: string;
  kind: WorkloadKind;
  title: string;
  /** What it does, and what to look for in the flamegraph. */
  blurb: string;
  run: (url: URL, baseUrl: string) => Promise<unknown> | unknown;
}

export const WORKLOADS: Workload[] = [
  {
    path: "/api/cpu/fib",
    kind: "cpu",
    title: "Deep recursion",
    blurb:
      "fibonacci(32), 30 times over (~240ms). A tall, narrow tower — the clearest example of stack depth in a flamegraph.",
    run: (url) => {
      const depth = Number(url.searchParams.get("depth") ?? 32);
      return { result: runFibonacci(depth) };
    },
  },
  {
    path: "/api/cpu/sort",
    kind: "cpu",
    title: "Hot comparator",
    blurb:
      "Sorts 1M records with a custom comparator (~210ms). Shallow and wide — almost all time in one leaf frame.",
    run: () => ({ firstId: runSort() }),
  },
  {
    path: "/api/cpu/json",
    kind: "cpu",
    title: "Serialize / parse",
    blurb:
      "280 stringify/parse round trips over a deeply nested payload (~245ms). Two fat sibling blocks under one parent.",
    run: () => ({ bytes: runJsonRoundtrip() }),
  },
  {
    path: "/api/cpu/regex",
    kind: "cpu",
    title: "Regex scan",
    blurb:
      "Matches 120k log lines against a capture-heavy pattern, 28 passes (~250ms). Regex engine frames dominate.",
    run: () => ({ matched: runLogScan() }),
  },
  {
    path: "/api/cpu/hash",
    kind: "cpu",
    title: "Crypto chain",
    blurb:
      "900k chained sha256 digests (~245ms). Time lands in native crypto frames rather than your own JS.",
    run: () => ({ digest: runHashChain() }),
  },

  {
    path: "/api/io/slow-query",
    kind: "io",
    title: "Single slow query",
    blurb:
      "One 250ms 'database' call. Near-zero CPU — it appears as (idle) in the wall flamegraph and is absent from the cpu one.",
    run: async (url) => {
      const ms = Number(url.searchParams.get("ms") ?? 250);
      return queryDatabase("users", ms);
    },
  },
  {
    path: "/api/io/waterfall",
    kind: "io",
    title: "Serial waterfall",
    blurb:
      "Four dependent queries awaited one after another (~400ms wall, ~0ms CPU). The classic latency bug that CPU profiling cannot see.",
    run: () => runWaterfall(),
  },
  {
    path: "/api/io/parallel",
    kind: "io",
    title: "Concurrent queries",
    blurb:
      "The same four queries via Promise.all (~130ms wall). Compare its p95 against the waterfall on the Grafana dashboard.",
    run: () => runParallelQueries(),
  },
  {
    path: "/api/io/upstream",
    kind: "io",
    title: "Upstream HTTP call",
    blurb: "A real fetch() round trip back into this server, so you see actual socket wait time.",
    run: async (url, baseUrl) => {
      const delay = Number(url.searchParams.get("delay") ?? 150);
      return { bytes: await callUpstream(baseUrl, delay) };
    },
  },

  {
    path: "/api/checkout",
    kind: "mixed",
    title: "Checkout pipeline",
    blurb:
      "A realistic request: validate → load customer → price → reserve → charge → render. ~60ms CPU but ~250ms wall. The cpu and wall flamegraphs tell two different stories about the same request.",
    run: async (url) => {
      const lines = Number(url.searchParams.get("lines") ?? 60);
      const customerId = url.searchParams.get("customer") ?? "cust-1009";
      return handleCheckout(customerId, buildCart(lines));
    },
  },
];

/** Internal endpoint used by the upstream-call workload. Not shown in the panel. */
export async function echo(url: URL): Promise<string> {
  const delay = Number(url.searchParams.get("delay") ?? 0);
  await sleep(delay);
  return `echoed after ${delay}ms`;
}
