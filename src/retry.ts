/** Prevent an untrusted Retry-After response from parking a destination indefinitely. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** Parse the HTTP Retry-After delay-seconds or HTTP-date forms. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  let delayMs: number;
  if (/^[0-9]+$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1_000;
  } else {
    const retryAt = Date.parse(trimmed);
    if (!Number.isFinite(retryAt)) return undefined;
    delayMs = retryAt - nowMs;
  }
  if (!Number.isFinite(delayMs)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(delayMs)));
}

function randomUnit(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Equal-jitter exponential backoff, or Retry-After plus up to 10% positive
 * jitter (capped at one second). Positive jitter never retries before the
 * server-requested time.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random
): number {
  const unit = randomUnit(random);
  if (retryAfterMs !== undefined) {
    const minimum = Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAfterMs));
    const jitterRange = Math.min(1_000, minimum * 0.1);
    return Math.ceil(minimum + jitterRange * unit);
  }
  const ceiling = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 30_000);
  return Math.ceil(ceiling / 2 + (ceiling / 2) * unit);
}
