let status = 200;
let delayMs = 0;
let retryAfter: string | null = null;
const upstream = process.env.UPSTREAM_URL ?? "http://pyroscope:4040";

Bun.serve({
  port: 4040,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/control") {
      if (url.searchParams.has("status")) status = Number(url.searchParams.get("status"));
      if (url.searchParams.has("delayMs")) delayMs = Number(url.searchParams.get("delayMs"));
      if (url.searchParams.has("retryAfter")) {
        retryAfter = url.searchParams.get("retryAfter") || null;
      }
      return Response.json({ status, delayMs, retryAfter });
    }
    if (delayMs > 0) await Bun.sleep(delayMs);
    if (status !== 200) {
      return new Response(`injected HTTP ${status}`, {
        status,
        headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
      });
    }
    const target = new URL(`${url.pathname}${url.search}`, upstream);
    return fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // Required by fetch when streaming an incoming request body.
      duplex: "half",
    } as RequestInit);
  },
});

console.log(`[fault-receiver] listening on :4040, forwarding to ${upstream}`);
