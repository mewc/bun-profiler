import type { Session } from "node:inspector/promises";
import { ProfilerConfigError } from "./errors.js";
import { encodePprof } from "./pprof.js";
import type { CdpProfile } from "./types.js";

const ACTIVE_PROFILER = Symbol.for("bun-profiler.active-profiler");
const registry = globalThis as typeof globalThis & { [ACTIVE_PROFILER]?: object };

export interface PprofPullHandlerOptions {
  sampleIntervalUs?: number;
  defaultDurationSeconds?: number;
  maxDurationSeconds?: number;
}

/**
 * Create a framework-neutral Go-compatible CPU pprof handler.
 *
 * Pull mode owns the process-wide sampler while a request is active and is
 * therefore intentionally incompatible with continuous push mode.
 */
export function createPprofHandler(
  options: PprofPullHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const sampleIntervalUs = options.sampleIntervalUs ?? 10_000;
  const defaultDuration = options.defaultDurationSeconds ?? 10;
  const maxDuration = options.maxDurationSeconds ?? 120;
  if (sampleIntervalUs <= 0 || defaultDuration <= 0 || maxDuration <= 0) {
    throw new ProfilerConfigError("pull-mode intervals must be greater than zero");
  }
  let inFlight: Promise<Uint8Array> | null = null;

  return async (request: Request): Promise<Response> => {
    const secondsValue = new URL(request.url).searchParams.get("seconds");
    const seconds = secondsValue === null ? defaultDuration : Number(secondsValue);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxDuration) {
      return new Response(`seconds must be greater than 0 and at most ${maxDuration}\n`, {
        status: 400,
      });
    }
    if (registry[ACTIVE_PROFILER] && !inFlight) {
      return new Response("continuous profiling is already active in this isolate\n", {
        status: 409,
      });
    }
    if (!inFlight) {
      const token = {};
      registry[ACTIVE_PROFILER] = token;
      inFlight = capturePprof(seconds * 1_000, sampleIntervalUs).finally(() => {
        if (registry[ACTIVE_PROFILER] === token) delete registry[ACTIVE_PROFILER];
        inFlight = null;
      });
    }
    try {
      const data = await inFlight;
      return new Response(data as Uint8Array<ArrayBuffer>, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return new Response(`profile capture failed: ${error}\n`, { status: 500 });
    }
  };
}

async function capturePprof(durationMs: number, sampleIntervalUs: number): Promise<Uint8Array> {
  const mod = await import("node:inspector/promises");
  const session: Session = new mod.Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: sampleIntervalUs });
    await session.post("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const { profile } = (await session.post("Profiler.stop")) as { profile: CdpProfile };
    return encodePprof(profile, {
      sampleIntervalUs,
      durationNanos: String(Math.round(durationMs * 1_000_000)),
      timeNanos: String(Date.now() * 1_000_000),
    });
  } finally {
    session.disconnect();
  }
}
