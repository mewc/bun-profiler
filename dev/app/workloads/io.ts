/**
 * I/O-bound workloads.
 *
 * These barely touch the CPU — they mostly `await`. That is the whole point:
 * they are nearly INVISIBLE in the `cpu` flamegraph but DOMINATE the `wall`
 * flamegraph. Comparing the two side by side is the clearest demonstration of
 * why wall-time profiling matters for a typical I/O-heavy service.
 */

/** Stand-in for a network/disk wait. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A single "database" round trip. */
export async function queryDatabase(table: string, ms: number): Promise<{ table: string }> {
  await sleep(ms);
  return { table };
}

/**
 * Four dependent queries run one after another.
 * Wall time ≈ sum of all four. CPU time ≈ 0.
 */
export async function runWaterfall(): Promise<string[]> {
  const results: string[] = [];
  results.push((await queryDatabase("users", 90)).table);
  results.push((await queryDatabase("orders", 110)).table);
  results.push((await queryDatabase("line_items", 130)).table);
  results.push((await queryDatabase("shipping", 70)).table);
  return results;
}

/**
 * The same four queries issued concurrently.
 * Wall time ≈ the slowest single query. Compare against runWaterfall in the
 * wall flamegraph to see the win.
 */
export async function runParallelQueries(): Promise<string[]> {
  const results = await Promise.all([
    queryDatabase("users", 90),
    queryDatabase("orders", 110),
    queryDatabase("line_items", 130),
    queryDatabase("shipping", 70),
  ]);
  return results.map((r) => r.table);
}

/** A real HTTP round trip back into this same server. */
export async function callUpstream(baseUrl: string, delayMs: number): Promise<number> {
  const response = await fetch(`${baseUrl}/api/io/echo?delay=${delayMs}`);
  const body = await response.text();
  return body.length;
}
