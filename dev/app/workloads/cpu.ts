/**
 * CPU-bound workloads.
 *
 * Everything here burns real CPU, so it shows up in BOTH the `cpu` and `wall`
 * flamegraphs. Each workload has a deliberately distinct shape so you can tell
 * them apart at a glance in Pyroscope:
 *
 *   fibonacci   → tall, narrow tower (deep recursion)
 *   sortRecords → shallow and wide (one hot comparator)
 *   jsonRoundtrip → two fat sibling blocks (serialize / parse)
 *   scanLogLines  → regex engine frames dominate
 *   hashChain     → crypto frames dominate
 *
 * Functions are declared (not arrow consts) and nested on purpose — the frame
 * labels in the flamegraph come straight from these names.
 */

import { createHash } from "node:crypto";

/** Deep recursion — produces a tall, narrow flame tower. */
export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export function runFibonacci(depth = 32, rounds = 30): number {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    total += fibonacci(depth);
  }
  return total;
}

interface ScoredRecord {
  id: number;
  score: number;
  name: string;
}

function buildRecords(count: number): ScoredRecord[] {
  const records: ScoredRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    records[i] = {
      id: i,
      // Deterministic pseudo-random so the workload is reproducible run to run.
      score: (i * 2654435761) % 1_000_003,
      name: `record-${i.toString(36)}`,
    };
  }
  return records;
}

function compareByScoreThenName(a: ScoredRecord, b: ScoredRecord): number {
  if (a.score !== b.score) return a.score - b.score;
  return a.name.localeCompare(b.name);
}

/** Shallow + wide — a single hot comparator called millions of times. */
export function runSort(count = 1_000_000): number {
  const records = buildRecords(count);
  records.sort(compareByScoreThenName);
  return records[0]?.id ?? -1;
}

interface PayloadNode {
  depth: number;
  children: unknown[];
}

function buildNestedPayload(width: number, depth: number): unknown {
  if (depth === 0) return { leaf: true, blob: "x".repeat(64) };
  const node: PayloadNode = { depth, children: [] };
  for (let i = 0; i < width; i++) {
    node.children.push(buildNestedPayload(width, depth - 1));
  }
  return node;
}

/** Two fat sibling blocks: JSON.stringify next to JSON.parse. */
export function runJsonRoundtrip(rounds = 280): number {
  const payload = buildNestedPayload(6, 5);
  let bytes = 0;
  for (let i = 0; i < rounds; i++) {
    const serialized = serializePayload(payload);
    bytes += serialized.length;
    parsePayload(serialized);
  }
  return bytes;
}

function serializePayload(payload: unknown): string {
  return JSON.stringify(payload);
}

function parsePayload(serialized: string): unknown {
  return JSON.parse(serialized);
}

const LOG_LINE_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(\w+)\s+\[([\w.-]+)\]\s+(.*?)(?:\s+duration=(\d+)ms)?$/;

function generateLogLines(count: number): string[] {
  const levels = ["INFO", "WARN", "ERROR", "DEBUG"];
  const lines: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const level = levels[i % levels.length];
    lines[i] =
      `2026-07-27T12:${String(i % 60).padStart(2, "0")}:00.000Z ${level} ` +
      `[svc.worker-${i % 8}] processed batch ${i} duration=${i % 500}ms`;
  }
  return lines;
}

/**
 * Regex engine frames dominate this one.
 * `rounds` re-scans the same corpus so we can add CPU time without generating
 * millions of throwaway strings.
 */
export function runLogScan(count = 120_000, rounds = 28): number {
  const lines = generateLogLines(count);
  let matched = 0;
  for (let round = 0; round < rounds; round++) {
    for (const line of lines) {
      if (LOG_LINE_PATTERN.test(line)) matched++;
    }
  }
  return matched;
}

/** Native crypto frames dominate — useful for spotting non-JS hot spots. */
export function runHashChain(rounds = 900_000): string {
  let digest = "seed";
  for (let i = 0; i < rounds; i++) {
    digest = createHash("sha256").update(digest).digest("hex");
  }
  return digest;
}
