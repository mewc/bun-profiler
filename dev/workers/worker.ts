import { createHash } from "node:crypto";

const kind = new URL(import.meta.url).searchParams.get("kind");

function fibonacci(n: number): number {
  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

self.onmessage = () => {
  setInterval(() => {
    if (kind === "fibonacci") fibonacci(34);
    else {
      let value = "bun-profiler";
      for (let i = 0; i < 40_000; i++) value = createHash("sha256").update(value).digest("hex");
    }
  }, 25);
};
