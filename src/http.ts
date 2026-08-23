interface RequestDeadline {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
}

/** Combine a caller abort with a per-request deadline without requiring AbortSignal.any(). */
export function requestDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number
): RequestDeadline {
  const controller = new AbortController();
  let deadlineReached = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    deadlineReached = true;
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => deadlineReached,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}
