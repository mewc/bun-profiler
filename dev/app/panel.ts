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
  const group = WORKLOADS.filter((w) => w.kind === kind);
  const cards = group.map(renderCard).join("");
  return `
    <section data-group="${kind}">
      <h2>
        <span class="dot" style="--pill:${meta.color}"></span>${meta.label}
        <button class="ghost" data-run-group="${kind}">Run all ${group.length}</button>
      </h2>
      <p class="note">${meta.note}</p>
      <div class="grid">${cards}</div>
    </section>`;
}

export interface PanelLinks {
  /** Host-side URLs — published ports vary per workspace, so they're injected. */
  grafana: string;
  pyroscope: string;
  prometheus: string;
}

/** ":3003" from "http://localhost:3003", or "" if the URL has no explicit port. */
function portLabel(url: string): string {
  try {
    const { port } = new URL(url);
    return port ? `:${port}` : "";
  } catch {
    return "";
  }
}

export function renderPanel(appName: string, pyroscopeUrl: string, links: PanelLinks): string {
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
    max-height: 150px; overflow: auto;
  }
  output.show { display: block; }
  output.err { color: #fca5a5; }
  .bar { display: flex; gap: 10px; align-items: center; margin: 28px 0 4px; flex-wrap: wrap; }
  .bar button { background: #7c3aed; padding: 9px 17px; }
  .bar button:hover { background: #6d28d9; }
  .bar span { color: #7c8697; font-size: 13.5px; }
  .cta {
    display: inline-flex; align-items: center; padding: 9px 15px; border-radius: 8px;
    background: #161a23; border: 1px solid #262c39; color: #e6e8ee;
    text-decoration: none; font-size: 13.5px; font-weight: 600;
  }
  .cta:hover { border-color: #7c3aed; background: #1b2029; }
  .cta.pulse { border-color: #7c3aed; box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.25); }
  h2 button.ghost {
    background: transparent; border: 1px solid #2b3242; color: #9aa3b2;
    font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
    margin-left: 4px;
  }
  h2 button.ghost:hover { border-color: #4b5569; color: #e6e8ee; background: #161a23; }
  h2 button.ghost:disabled { opacity: 0.6; }
  output .ms { color: #e6e8ee; font-weight: 600; }
  output .viz {
    display: block; margin-top: 7px; color: #a78bfa;
    font-family: inherit; font-size: 12.5px; text-decoration: none; font-weight: 600;
  }
  output .viz:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <h1>bun-profiler demo</h1>
  <p class="sub">Profiling <code>${escapeHtml(appName)}</code> → <code>${escapeHtml(pyroscopeUrl)}</code>, pushed every 5s. CPU and wall-time streams are both enabled.</p>

  <div class="links">
    <a href="${links.grafana}/d/bun-profiler-demo" target="_blank">Grafana dashboard <small>${portLabel(links.grafana)}</small></a>
    <a href="${links.pyroscope}" target="_blank">Pyroscope <small>${portLabel(links.pyroscope)}</small></a>
    <a href="${links.prometheus}/targets" target="_blank">Prometheus <small>${portLabel(links.prometheus)}</small></a>
    <a href="/metrics" target="_blank">/metrics</a>
  </div>

  <div class="bar">
    <button id="all">Run all ${WORKLOADS.length} workloads</button>
    <a class="cta" id="all-grafana" href="${links.grafana}/d/bun-profiler-demo" target="_blank">Open Grafana dashboard &rarr;</a>
    <span>Each result links to the flamegraph for that exact run.</span>
  </div>

  ${renderGroup("mixed")}
  ${renderGroup("cpu")}
  ${renderGroup("io")}
</main>

<script>
const GRAFANA = ${JSON.stringify(links.grafana)};
const SERVICE = ${JSON.stringify(appName)};

// Profiles are pushed on an interval, so a window covering only the request
// itself would usually be empty. Pad generously on both sides.
const LEAD_MS = 15000;
const TRAIL_MS = 20000;

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** Dashboard link scoped to the window a single run occupied. */
function grafanaLink(startedAt, endedAt) {
  const params = new URLSearchParams({
    from: String(startedAt - LEAD_MS),
    to: String(endedAt + TRAIL_MS),
    'var-service': SERVICE,
  });
  return GRAFANA + '/d/bun-profiler-demo?' + params.toString();
}

async function run(button) {
  const card = button.closest('.card');
  const out = card.querySelector('output');
  button.disabled = true;
  out.className = 'show';
  out.textContent = 'running…';

  const startedAt = Date.now();
  try {
    const res = await fetch(button.dataset.path);
    const body = await res.text();
    const endedAt = Date.now();

    out.className = res.ok ? 'show' : 'show err';
    out.innerHTML =
      '<span class="ms">' + (endedAt - startedAt) + 'ms</span> ' +
      escapeHtml(body.slice(0, 260)) +
      '<a class="viz" href="' + grafanaLink(startedAt, endedAt) + '" target="_blank">' +
      'View this run in Grafana &rarr;</a>';
  } catch (err) {
    out.className = 'show err';
    out.textContent = String(err);
  } finally {
    button.disabled = false;
  }
}

/** Run a set of cards in sequence so their profiles don't overlap. */
async function runAll(buttons, trigger) {
  const startedAt = Date.now();
  trigger.disabled = true;
  const label = trigger.textContent;
  let done = 0;
  for (const b of buttons) {
    done++;
    trigger.textContent = 'Running ' + done + '/' + buttons.length + '…';
    await run(b);
  }
  trigger.textContent = label;
  trigger.disabled = false;

  const bar = document.getElementById('all-grafana');
  bar.href = grafanaLink(startedAt, Date.now());
  bar.classList.add('pulse');
  setTimeout(() => bar.classList.remove('pulse'), 2000);
}

for (const b of document.querySelectorAll('.card button')) {
  b.addEventListener('click', () => run(b));
}

for (const groupButton of document.querySelectorAll('[data-run-group]')) {
  groupButton.addEventListener('click', () => {
    const section = groupButton.closest('section');
    runAll([...section.querySelectorAll('.card button')], groupButton);
  });
}

document.getElementById('all').addEventListener('click', (e) => {
  runAll([...document.querySelectorAll('.card button')], e.target);
});
</script>
</body>
</html>`;
}
