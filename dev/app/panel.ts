/**
 * The HTML control panel served at "/".
 *
 * Generated from the workload registry so it never drifts from the routes.
 * Deliberately screenshot-friendly: dark, high contrast, no external assets.
 */

import type { Workload } from "./workloads/index.ts";
import { WORKLOADS } from "./workloads/index.ts";

const KIND_META: Record<Workload["kind"], { label: string; color: string; note: string }> = {
  cpu: {
    label: "CPU-bound",
    color: "#f97316",
    note: "Shows up in both the cpu and wall flamegraphs.",
  },
  io: {
    label: "I/O-bound",
    color: "#38bdf8",
    note:
      "Absent from cpu. In wall these show up as the (idle) frame — JavaScriptCore reports " +
      "no stack while the process is parked, so you see how much time went off-CPU, not which call waited.",
  },
  mixed: {
    label: "Mixed",
    color: "#a78bfa",
    note: "CPU and I/O in one call tree — the clearest cpu-vs-wall comparison.",
  },
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string
  );
}

function renderCard(w: Workload): string {
  const meta = KIND_META[w.kind];
  return `
    <article class="card" data-kind="${w.kind}">
      <header>
        <span class="pill" style="--pill:${meta.color}">${meta.label}</span>
        <h3>${escapeHtml(w.title)}</h3>
      </header>
      <p>${escapeHtml(w.blurb)}</p>
      <footer>
        <code>${escapeHtml(w.path)}</code>
        <button data-path="${escapeHtml(w.path)}">Run</button>
      </footer>
      <output aria-live="polite"></output>
    </article>`;
}

function renderGroup(kind: Workload["kind"]): string {
  const meta = KIND_META[kind];
  const cards = WORKLOADS.filter((w) => w.kind === kind).map(renderCard).join("");
  return `
    <section>
      <h2><span class="dot" style="--pill:${meta.color}"></span>${meta.label}</h2>
      <p class="note">${meta.note}</p>
      <div class="grid">${cards}</div>
    </section>`;
}

export function renderPanel(appName: string, pyroscopeUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bun-profiler demo</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 32px 64px;
    background: #0b0d12; color: #e6e8ee;
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.02em; }
  .sub { color: #9aa3b2; margin: 0 0 28px; }
  .sub code { color: #e6e8ee; }
  h2 { font-size: 17px; margin: 36px 0 4px; display: flex; align-items: center; gap: 9px; }
  .note { color: #7c8697; margin: 0 0 16px; font-size: 13.5px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--pill); }
  .links { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
  .links a {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 9px 15px; border-radius: 9px; text-decoration: none;
    background: #161a23; border: 1px solid #262c39; color: #e6e8ee; font-size: 14px;
  }
  .links a:hover { border-color: #3a4358; background: #1b2029; }
  .links a small { color: #7c8697; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
  .card {
    background: #12151d; border: 1px solid #222836; border-radius: 12px;
    padding: 16px; display: flex; flex-direction: column; gap: 9px;
  }
  .card header { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .card h3 { font-size: 15px; margin: 0; font-weight: 600; }
  .card p { margin: 0; color: #98a1b1; font-size: 13.5px; flex: 1; }
  .pill {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
    color: var(--pill); border: 1px solid color-mix(in srgb, var(--pill) 40%, transparent);
    background: color-mix(in srgb, var(--pill) 12%, transparent);
    padding: 2px 7px; border-radius: 999px;
  }
  .card footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .card code { color: #7c8697; font-size: 12.5px; }
  button {
    background: #2563eb; color: #fff; border: 0; border-radius: 8px;
    padding: 7px 15px; font-size: 13.5px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  button:hover { background: #1d4ed8; }
  button:disabled { opacity: 0.55; cursor: progress; }
  output {
    display: none; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px;
    background: #0b0d12; border: 1px solid #222836; border-radius: 8px;
    padding: 9px 11px; color: #7ee2a8; white-space: pre-wrap; word-break: break-all;
    max-height: 108px; overflow: auto;
  }
  output.show { display: block; }
  output.err { color: #fca5a5; }
  .bar { display: flex; gap: 10px; align-items: center; margin: 28px 0 4px; flex-wrap: wrap; }
  .bar button { background: #7c3aed; padding: 9px 17px; }
  .bar button:hover { background: #6d28d9; }
  .bar span { color: #7c8697; font-size: 13.5px; }
</style>
</head>
<body>
<main>
  <h1>bun-profiler demo</h1>
  <p class="sub">Profiling <code>${escapeHtml(appName)}</code> → <code>${escapeHtml(pyroscopeUrl)}</code>, pushed every 5s. CPU and wall-time streams are both enabled.</p>

  <div class="links">
    <a href="http://localhost:4042" target="_blank">Pyroscope <small>:4042</small></a>
    <a href="http://localhost:3003/d/bun-profiler-demo" target="_blank">Grafana dashboard <small>:3003</small></a>
    <a href="http://localhost:3003/a/grafana-pyroscope-app/single" target="_blank">Grafana flamegraphs <small>:3003</small></a>
    <a href="http://localhost:9091/targets" target="_blank">Prometheus <small>:9091</small></a>
    <a href="/metrics" target="_blank">/metrics</a>
  </div>

  <div class="bar">
    <button id="all">Run every workload once</button>
    <span>…then open Pyroscope and compare the <code>.cpu</code> and <code>.wall</code> streams.</span>
  </div>

  ${renderGroup("mixed")}
  ${renderGroup("cpu")}
  ${renderGroup("io")}
</main>

<script>
async function run(button) {
  const card = button.closest('.card');
  const out = card.querySelector('output');
  button.disabled = true;
  out.className = 'show';
  out.textContent = 'running…';
  const t0 = performance.now();
  try {
    const res = await fetch(button.dataset.path);
    const body = await res.text();
    const ms = (performance.now() - t0).toFixed(0);
    out.className = res.ok ? 'show' : 'show err';
    out.textContent = ms + 'ms  ' + body.slice(0, 300);
  } catch (err) {
    out.className = 'show err';
    out.textContent = String(err);
  } finally {
    button.disabled = false;
  }
}

for (const b of document.querySelectorAll('.card button')) {
  b.addEventListener('click', () => run(b));
}

document.getElementById('all').addEventListener('click', async (e) => {
  e.target.disabled = true;
  for (const b of document.querySelectorAll('.card button')) {
    await run(b);
  }
  e.target.disabled = false;
});
</script>
</body>
</html>`;
}
