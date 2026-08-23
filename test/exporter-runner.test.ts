import { expect, test } from "bun:test";
import { ExporterError } from "../src/errors.js";
import { ExporterRunner } from "../src/exporter-runner.js";
import type { ProfileWindow } from "../src/types.js";

function window(from: number): ProfileWindow {
  return Object.freeze({
    type: "cpu",
    appName: "queue-test",
    labels: Object.freeze({}),
    from,
    until: from + 1,
    sampleRate: 100,
    sampleIntervalUs: 10_000,
    folded: `work ${from}`,
    profile: { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 },
  });
}

test("exporter queues stay bounded and evict the oldest waiting window", async () => {
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const exported: number[] = [];
  let calls = 0;
  const runner = new ExporterRunner(
    {
      name: "slow",
      async export(profile) {
        calls++;
        if (calls === 1) await first;
        exported.push(profile.from);
      },
    },
    { maxPending: 2, maxRetries: 0, debug: () => undefined }
  );

  runner.enqueue(window(1));
  runner.enqueue(window(2));
  runner.enqueue(window(3));
  runner.enqueue(window(4));
  expect(runner.stats().queueDepth).toBe(2);
  expect(runner.stats().droppedProfiles).toBe(1);
  releaseFirst();
  await runner.waitForIdle();
  expect(exported).toEqual([1, 3, 4]);
});

test("honors Retry-After without retrying before the requested delay", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const runner = new ExporterRunner(
    {
      name: "rate-limited",
      async export() {
        attempts++;
        if (attempts === 1) {
          throw new ExporterError("rate limited", { retryAfterMs: 2_000 });
        }
      },
    },
    {
      maxPending: 2,
      maxRetries: 1,
      debug: () => undefined,
      random: () => 0,
      wait: async (delay) => {
        delays.push(delay);
      },
    }
  );

  runner.enqueue(window(1));
  await runner.waitForIdle();
  expect(attempts).toBe(2);
  expect(delays).toEqual([2_000]);
  expect(runner.stats()).toMatchObject({ retries: 1, exportedProfiles: 1, failedProfiles: 0 });
});
