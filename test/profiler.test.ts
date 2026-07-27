import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/** Wait for any remaining microtasks / libuv callbacks (e.g. after tag() which doesn't await pushes). */
async function flushAsync() {
  await new Promise<void>((r) => setTimeout(r, 20));
}

// ---------- Mock node:inspector/promises ----------
// mock.module is hoisted by Bun before all import statements, so the Session
// class below is what profiler.ts receives when it imports the module.

type PostFn = (method: string, params?: unknown) => Promise<unknown>;

let _postFn: PostFn = async () => ({});
let _connectCalls = 0;
let _disconnectCalls = 0;
const _postCalls: Array<{ method: string; params?: unknown }> = [];
let _inspectorAvailable = true;

mock.module("node:inspector/promises", () => ({
  Session: class {
    connect() {
      if (!_inspectorAvailable) throw new Error("NotImplementedError");
      _connectCalls++;
    }
    disconnect() {
      _disconnectCalls++;
    }
    async post(method: string, params?: unknown) {
      _postCalls.push({ method, params });
      return _postFn(method, params);
    }
  },
}));

import { BunPyroscope } from "../src/profiler";

// ---------- Mock fetch ----------
const _fetchMock = mock(() => Promise.resolve(new Response("ok", { status: 200 })));
(globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;

// ---------- Helpers ----------

function cpuProfile(sampleCount = 2) {
  const samples = Array.from({ length: sampleCount }, () => 2);
  return {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "1",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        children: [2],
      },
      {
        id: 2,
        callFrame: {
          functionName: "main",
          scriptId: "1",
          url: "app.ts",
          lineNumber: 1,
          columnNumber: 0,
        },
      },
    ],
    samples,
    startTime: 0,
    endTime: 1_000_000,
    timeDeltas: samples.map(() => Math.floor(1_000_000 / sampleCount)),
  };
}

function emptyHeapProfile() {
  return {
    head: {
      id: 1,
      callFrame: {
        functionName: "(root)",
        scriptId: "1",
        url: "",
        lineNumber: -1,
        columnNumber: -1,
      },
      selfSize: 0,
      children: [],
    },
  };
}

function defaultPost(method: string): Promise<unknown> {
  if (method === "Profiler.stop") return Promise.resolve({ profile: cpuProfile() });
  if (method === "HeapProfiler.stopSampling")
    return Promise.resolve({ profile: emptyHeapProfile() });
  return Promise.resolve({});
}

const BASE = {
  pyroscopeUrl: "http://localhost:4040",
  appName: "test-app",
  pushIntervalMs: 60_000, // long so the timer never fires during tests
  maxRetries: 0,
  debug: false,
};

let profiler: BunPyroscope | null = null;

beforeEach(() => {
  _connectCalls = 0;
  _disconnectCalls = 0;
  _postCalls.length = 0;
  _fetchMock.mockClear();
  _postFn = defaultPost;
  _inspectorAvailable = true;
  profiler = null;
});

afterEach(async () => {
  if (profiler) {
    await profiler.stop();
    profiler = null;
  }
});

// ---------- tag() ----------

describe("tag()", () => {
  it("short-circuits (calls fn immediately) when profiler is not running", async () => {
    const p = new BunPyroscope(BASE);
    const result = await p.tag({ env: "test" }, () => 42);
    expect(result).toBe(42);
    // No session activity since profiler never started
    expect(_connectCalls).toBe(0);
  });

  it("returns the synchronous fn result", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    const result = await profiler.tag({ route: "/api" }, () => "sync-value");
    expect(result).toBe("sync-value");
  });

  it("returns the async fn result", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    const result = await profiler.tag({ route: "/api" }, async () => {
      await Promise.resolve();
      return "async-value";
    });
    expect(result).toBe("async-value");
  });

  it("propagates exceptions thrown by fn", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    await expect(
      profiler.tag({ route: "/api" }, () => {
        throw new Error("fn-error");
      })
    ).rejects.toThrow("fn-error");
  });

  it("restores original labels after fn throws", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();

    await expect(
      profiler.tag({ route: "/api" }, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // If labels weren't restored, the stop push would include route=
    _fetchMock.mockClear();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    // All stop-flush URLs must use original labels (no route=)
    for (const [url] of calls) {
      expect(url as string).not.toContain("route=");
    }
  });

  it("applies extra labels only during the tagged window", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();

    _fetchMock.mockClear();
    await profiler.tag({ route: "api" }, () => "ok");
    await flushAsync();

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    // Labels are URL-encoded inside the `name` query param (= → %3D)
    const tagged = calls.find(([url]) => decodeURIComponent(url as string).includes("route=api"));
    expect(tagged).toBeTruthy();
    // At least one push should NOT carry it (the pre-tag flush)
    const untagged = calls.find(([url]) => !decodeURIComponent(url as string).includes("route="));
    expect(untagged).toBeTruthy();
  });
});

// ---------- start() / stop() ----------

describe("start()", () => {
  it("connects the session and starts the profiler", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();

    expect(_connectCalls).toBe(1);
    const methods = _postCalls.map((c) => c.method);
    expect(methods).toContain("Profiler.enable");
    expect(methods).toContain("Profiler.setSamplingInterval");
    expect(methods).toContain("Profiler.start");
  });

  it("calls Profiler.enable before Profiler.setSamplingInterval", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();

    const methods = _postCalls.map((c) => c.method);
    expect(methods.indexOf("Profiler.enable")).toBeLessThan(
      methods.indexOf("Profiler.setSamplingInterval")
    );
  });

  it("passes the configured sampleIntervalUs to setSamplingInterval", async () => {
    profiler = new BunPyroscope({ ...BASE, sampleIntervalUs: 5_000 });
    await profiler.start();

    const call = _postCalls.find((c) => c.method === "Profiler.setSamplingInterval");
    expect(call?.params).toEqual({ interval: 5_000 });
  });

  it("is idempotent — second call is a no-op", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    const connectsBefore = _connectCalls;
    await profiler.start();
    expect(_connectCalls).toBe(connectsBefore);
  });

  it("does NOT call HeapProfiler methods when heap is disabled (default)", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();

    const methods = _postCalls.map((c) => c.method);
    expect(methods.every((m) => !m.startsWith("HeapProfiler"))).toBe(true);
  });

  it("calls HeapProfiler.enable and startSampling when heap.enabled is true", async () => {
    profiler = new BunPyroscope({ ...BASE, heap: { enabled: true } });
    await profiler.start();

    const methods = _postCalls.map((c) => c.method);
    expect(methods).toContain("HeapProfiler.enable");
    expect(methods).toContain("HeapProfiler.startSampling");
  });

  it("passes the configured samplingIntervalBytes to HeapProfiler.startSampling", async () => {
    profiler = new BunPyroscope({
      ...BASE,
      heap: { enabled: true, samplingIntervalBytes: 65_536 },
    });
    await profiler.start();

    const call = _postCalls.find((c) => c.method === "HeapProfiler.startSampling");
    expect(call?.params).toEqual({ samplingInterval: 65_536 });
  });

  it("uses 32768 as default samplingIntervalBytes", async () => {
    profiler = new BunPyroscope({ ...BASE, heap: { enabled: true } });
    await profiler.start();

    const call = _postCalls.find((c) => c.method === "HeapProfiler.startSampling");
    expect(call?.params).toEqual({ samplingInterval: 32_768 });
  });

  it("continues CPU profiling if HeapProfiler.enable throws", async () => {
    _postFn = async (method: string) => {
      if (method === "HeapProfiler.enable") throw new Error("not supported");
      return defaultPost(method);
    };
    profiler = new BunPyroscope({ ...BASE, heap: { enabled: true } });
    // Should not throw
    await expect(profiler.start()).resolves.toBeUndefined();

    const methods = _postCalls.map((c) => c.method);
    expect(methods).toContain("Profiler.start");
  });
});

describe("stop()", () => {
  it("flushes the current window and disconnects", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    _postCalls.length = 0;

    await profiler.stop();
    profiler = null;

    const methods = _postCalls.map((c) => c.method);
    expect(methods).toContain("Profiler.stop");
    expect(_disconnectCalls).toBe(1);
  });

  it("calls HeapProfiler.disable on stop when heap was enabled", async () => {
    profiler = new BunPyroscope({ ...BASE, heap: { enabled: true } });
    await profiler.start();
    _postCalls.length = 0;

    await profiler.stop();
    profiler = null;

    const methods = _postCalls.map((c) => c.method);
    expect(methods).toContain("HeapProfiler.stopSampling");
    expect(methods).toContain("HeapProfiler.disable");
  });

  it("does NOT call HeapProfiler.disable when heap was disabled", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    _postCalls.length = 0;

    await profiler.stop();
    profiler = null;

    const methods = _postCalls.map((c) => c.method);
    expect(methods.every((m) => !m.startsWith("HeapProfiler"))).toBe(true);
  });

  it("is idempotent — second call is a no-op", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();

    await profiler.stop();
    _disconnectCalls = 0;
    _postCalls.length = 0;

    await profiler.stop(); // second call
    profiler = null;
    expect(_disconnectCalls).toBe(0);
  });
});

// ---------- ingest URL shape ----------

describe("ingest URL", () => {
  it("pushes to /ingest with correct query params", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    expect(calls.length).toBeGreaterThan(0);
    const url = calls[0]?.[0] as string;
    expect(url).toContain("/ingest?");
    expect(url).toContain("name=test-app.cpu");
    expect(url).toContain("format=folded");
    expect(url).toContain("spyName=nodespy");
  });

  it("pushes heap data to alloc_space stream", async () => {
    profiler = new BunPyroscope({ ...BASE, heap: { enabled: true } });
    _postFn = async (method: string) => {
      if (method === "Profiler.stop") return { profile: cpuProfile() };
      if (method === "HeapProfiler.stopSampling") {
        return {
          profile: {
            head: {
              id: 1,
              callFrame: {
                functionName: "(root)",
                scriptId: "1",
                url: "",
                lineNumber: -1,
                columnNumber: -1,
              },
              selfSize: 0,
              children: [
                {
                  id: 2,
                  callFrame: {
                    functionName: "allocHeavy",
                    scriptId: "1",
                    url: "alloc.ts",
                    lineNumber: 5,
                    columnNumber: 0,
                  },
                  selfSize: 1024,
                  children: [],
                },
              ],
            },
          },
        };
      }
      return {};
    };

    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    const heapPush = calls.find(([url]) => (url as string).includes("alloc_space"));
    expect(heapPush).toBeTruthy();
  });
});

// ---------- auth headers ----------

describe("auth headers", () => {
  it("sends Bearer token when authToken is configured", async () => {
    profiler = new BunPyroscope({ ...BASE, authToken: "my-secret-token" });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(0);
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-secret-token");
  });

  it("sends Basic auth header when basicAuth is configured", async () => {
    profiler = new BunPyroscope({
      ...BASE,
      basicAuth: { username: "admin", password: "hunter2" },
    });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(0);
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from("admin:hunter2").toString("base64")}`;
    expect(headers.Authorization).toBe(expected);
  });

  it("omits Authorization header when no auth is configured", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(0);
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

// ---------- wall-time profiling ----------

describe("wall-time profiling", () => {
  it("does NOT push wall-time data when wallTime is disabled (default)", async () => {
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    const wallPush = calls.find(([url]) => (url as string).includes(".wall"));
    expect(wallPush).toBeUndefined();
  });

  it("pushes wall-time data to 'wall' stream when enabled", async () => {
    profiler = new BunPyroscope({ ...BASE, wallTime: { enabled: true } });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    const wallPush = calls.find(([url]) => (url as string).includes(".wall"));
    expect(wallPush).toBeTruthy();
  });

  it("pushes both CPU and wall-time streams when wallTime is enabled", async () => {
    profiler = new BunPyroscope({ ...BASE, wallTime: { enabled: true } });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    const cpuPush = calls.find(([url]) => (url as string).includes(".cpu"));
    const wallPush = calls.find(([url]) => (url as string).includes(".wall"));
    expect(cpuPush).toBeTruthy();
    expect(wallPush).toBeTruthy();
  });

  it("uses sampleRate=1000000 for wall-time pushes", async () => {
    profiler = new BunPyroscope({ ...BASE, wallTime: { enabled: true } });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    const calls = _fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    const wallPush = calls.find(([url]) => (url as string).includes(".wall"));
    expect(wallPush).toBeTruthy();
    const url = wallPush?.[0] as string;
    expect(url).toContain("sampleRate=1000000");
  });

  it("does not require separate CDP calls — reuses the CPU profile data", async () => {
    profiler = new BunPyroscope({ ...BASE, wallTime: { enabled: true } });
    await profiler.start();
    _postCalls.length = 0;

    await profiler.stop();
    profiler = null;

    // Wall-time should NOT add any extra Profiler.stop calls
    const stopCalls = _postCalls.filter((c) => c.method === "Profiler.stop");
    expect(stopCalls).toHaveLength(1);
  });
});

// ---------- timer auto-cycle ----------

describe("push interval timer", () => {
  it("automatically flushes and restarts when the push interval elapses", async () => {
    profiler = new BunPyroscope({ ...BASE, pushIntervalMs: 15 });
    await profiler.start();
    _postCalls.length = 0;

    // Wait for at least one timer fire
    await new Promise<void>((r) => setTimeout(r, 50));

    const stopCalls = _postCalls.filter((c) => c.method === "Profiler.stop");
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);

    // Also verify the window restarts (Profiler.start re-called)
    const startCalls = _postCalls.filter((c) => c.method === "Profiler.start");
    expect(startCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- unavailable inspector ----------

describe("start() when node:inspector/promises is unavailable", () => {
  // Use the _inspectorAvailable flag to toggle Session availability
  // within the shared mock. The mock uses a getter so it checks the flag
  // each time start() dynamically imports the module.

  beforeEach(() => {
    _inspectorAvailable = false;
  });

  afterEach(() => {
    _inspectorAvailable = true;
  });

  it("constructor succeeds — no side effects until start()", () => {
    const p = new BunPyroscope(BASE);
    expect(p).toBeInstanceOf(BunPyroscope);
  });

  it("throws a clear error mentioning the runtime limitation", async () => {
    const p = new BunPyroscope(BASE);
    await expect(p.start()).rejects.toThrow(
      "node:inspector/promises is not available in this runtime"
    );
  });

  it("stop() is safe to call after start() fails", async () => {
    const p = new BunPyroscope(BASE);
    await expect(p.start()).rejects.toThrow();
    await expect(p.stop()).resolves.toBeUndefined();
  });

  it("stop() is safe to call even if start() was never called", async () => {
    const p = new BunPyroscope(BASE);
    await expect(p.stop()).resolves.toBeUndefined();
  });

  it("profiler works normally after inspector is restored", async () => {
    const p1 = new BunPyroscope(BASE);
    await expect(p1.start()).rejects.toThrow();

    _inspectorAvailable = true;
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    expect(_connectCalls).toBeGreaterThan(0);
  });
});

// ---------- push failure ----------

describe("push failure handling", () => {
  it("drops the window and continues profiling when push fails with 5xx", async () => {
    let fetchCallCount = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = mock(() => {
      fetchCallCount++;
      return Promise.resolve(new Response("server error", { status: 503 }));
    });

    profiler = new BunPyroscope({ ...BASE, maxRetries: 0 });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    // Fetch was called (push attempted) and profiler didn't throw
    expect(fetchCallCount).toBeGreaterThan(0);

    // Restore mock
    (globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;
  });

  it("retries a 429 — an ingest rate limit is transient, not fatal", async () => {
    let attempts = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = mock(() => {
      attempts++;
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    });

    profiler = new BunPyroscope({ ...BASE, maxRetries: 1 });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    // 1 initial attempt + 1 retry. Treating 429 as fatal would give exactly 1.
    expect(attempts).toBe(2);

    (globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;
  });

  it("does not retry a 400 — a malformed request will never succeed", async () => {
    let attempts = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = mock(() => {
      attempts++;
      return Promise.resolve(new Response("bad request", { status: 400 }));
    });

    profiler = new BunPyroscope({ ...BASE, maxRetries: 3 });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    expect(attempts).toBe(1);

    (globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;
  });

  it("sends an uncompressed body by default", async () => {
    // Pyroscope's /ingest silently discards gzipped folded bodies: it answers
    // HTTP 200 and stores an empty profile, so a compressed default means the
    // profiler appears healthy while delivering nothing.
    let seenHeaders: Record<string, string> = {};
    let seenBody: unknown;
    (globalThis as unknown as { fetch: unknown }).fetch = mock(
      (_url: string, init: { headers: Record<string, string>; body: unknown }) => {
        seenHeaders = init.headers;
        seenBody = init.body;
        return Promise.resolve(new Response("ok", { status: 200 }));
      }
    );

    profiler = new BunPyroscope(BASE);
    await profiler.start();
    await profiler.stop();
    profiler = null;

    expect(Object.keys(seenHeaders)).not.toContain("Content-Encoding");
    expect(typeof seenBody).toBe("string");

    (globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;
  });

  it("does not set Content-Length — fetch derives it from the body", async () => {
    let seenHeaders: Record<string, string> = {};
    (globalThis as unknown as { fetch: unknown }).fetch = mock(
      (_url: string, init: { headers: Record<string, string> }) => {
        seenHeaders = init.headers;
        return Promise.resolve(new Response("ok", { status: 200 }));
      }
    );

    profiler = new BunPyroscope({ ...BASE, compress: true });
    await profiler.start();
    await profiler.stop();
    profiler = null;

    expect(seenHeaders["Content-Encoding"]).toBe("gzip");
    expect(Object.keys(seenHeaders)).not.toContain("Content-Length");

    (globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;
  });
});

describe("ingest window bounds", () => {
  it("never pushes a zero-length range, even for a sub-second window", async () => {
    const urls: string[] = [];
    (globalThis as unknown as { fetch: unknown }).fetch = mock((url: string) => {
      urls.push(url);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });

    // tag() closes its window the moment the callback returns, so this is the
    // realistic way to produce from === until.
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    await profiler.tag({ job: "quick" }, () => 1 + 1);
    await profiler.stop();
    profiler = null;

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      const from = Number(params.get("from"));
      const until = Number(params.get("until"));
      expect(until).toBeGreaterThan(from);
    }

    (globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;
  });
});

describe("stats()", () => {
  it("reports nothing delivered before start()", () => {
    const p = new BunPyroscope(BASE);
    expect(p.stats()).toMatchObject({
      running: false,
      pushedWindows: 0,
      failedWindows: 0,
      lastPushAt: null,
      lastError: null,
    });
  });

  it("counts a delivered window and timestamps it", async () => {
    const before = Date.now();
    profiler = new BunPyroscope(BASE);
    await profiler.start();
    await profiler.stop();

    const s = profiler.stats();
    profiler = null;

    expect(s.pushedWindows).toBeGreaterThan(0);
    expect(s.failedWindows).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.lastPushAt).toBeGreaterThanOrEqual(before);
  });

  it("records the failure instead of reporting a clean profiler", async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = mock(() =>
      Promise.resolve(new Response("nope", { status: 400 }))
    );

    profiler = new BunPyroscope({ ...BASE, maxRetries: 0 });
    await profiler.start();
    await profiler.stop();

    const s = profiler.stats();
    profiler = null;

    // Pushes attempted, none accepted — the profiler must not look healthy.
    expect(s.pushedWindows).toBe(0);
    expect(s.failedWindows).toBeGreaterThan(0);
    expect(s.lastError).toContain("HTTP 400");

    (globalThis as unknown as { fetch: unknown }).fetch = _fetchMock;
  });

  it("lists the enabled profile streams", async () => {
    const cpuOnly = new BunPyroscope(BASE);
    expect(cpuOnly.stats().streams).toEqual(["cpu"]);

    const withWall = new BunPyroscope({ ...BASE, wallTime: { enabled: true } });
    expect(withWall.stats().streams).toEqual(["cpu", "wall"]);
  });

  it("tracks running state across start and stop", async () => {
    profiler = new BunPyroscope(BASE);
    expect(profiler.stats().running).toBe(false);

    await profiler.start();
    expect(profiler.stats().running).toBe(true);

    await profiler.stop();
    expect(profiler.stats().running).toBe(false);
    profiler = null;
  });
});

describe("shutdown handlers", () => {
  function signalListenerCount() {
    return process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
  }

  it("removes its SIGTERM/SIGINT listeners on stop()", async () => {
    const before = signalListenerCount();

    const p = new BunPyroscope(BASE);
    await p.start();
    expect(signalListenerCount()).toBe(before + 2);

    await p.stop();
    expect(signalListenerCount()).toBe(before);
  });

  it("does not accumulate listeners across repeated start/stop cycles", async () => {
    const before = signalListenerCount();

    for (let i = 0; i < 5; i++) {
      const p = new BunPyroscope(BASE);
      await p.start();
      await p.stop();
    }

    expect(signalListenerCount()).toBe(before);
  });

  it("reinstalls handlers when the same instance is restarted", async () => {
    const before = signalListenerCount();

    const p = new BunPyroscope(BASE);
    await p.start();
    await p.stop();
    await p.start();

    // Without reinstalling, a later SIGTERM would skip the final flush.
    expect(signalListenerCount()).toBe(before + 2);

    await p.stop();
    expect(signalListenerCount()).toBe(before);
  });
});
