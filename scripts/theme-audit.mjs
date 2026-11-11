#!/usr/bin/env node
/* ==========================================================================
   Shinzora — theme contrast audit
   --------------------------------------------------------------------------
   "This is not visible in every theme" is a measurable claim, so it is measured.
   For each of the six themes this mounts the real component markup in Chromium,
   walks every element that renders text, and compares its colour with the colour
   actually painted behind it.

   Flags anything below 3:1 (large or bold text) or 4.5:1 (everything else). The
   threshold is by role, not by hope: muted labels are allowed to be quieter than
   headings, nothing is allowed to disappear.

     node scripts/theme-audit.mjs              # all six themes
     node scripts/theme-audit.mjs --theme nebula
   ========================================================================== */

import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUB = path.join(ROOT, "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const args = process.argv.slice(2);
const only = args.includes("--theme") ? args[args.indexOf("--theme") + 1] : null;

/* The markup the reports were about: stat cards, page heads, cards, the admin
   console, the rail, the tooltip and the assistant shell. */
const PAGE = `<!doctype html><html data-theme="midnight" data-tone="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/views.css">
<link rel="stylesheet" href="/css/admin.css"><link rel="stylesheet" href="/css/theme-light.css">
<style>
  /* Theme swaps are transitioned for the eye; a contrast reading taken mid-swap
     reports the theme the page is leaving. Freeze them for the measurement. */
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
  }
</style>
</head><body><div id="root" style="padding:24px"></div>
<script type="module">
  const { statCard, pageHead, emptyState } = await import("/js/modules/dashboard/components.js");
  document.getElementById("root").innerHTML = \`
    \${pageHead({ title: "Overview", desc: "Live totals from your database.", actions: '<a class="btn btn-primary btn-sm" href="#">Review</a>' })}
    <div class="stat-grid">
      \${statCard({ label: "Customers", value: "10", foot: "Registered accounts", iconName: "users" })}
      \${statCard({ label: "Revenue", value: "₹4,998", foot: "2 confirmed payments", iconName: "indian-rupee" })}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3 class="section-title">Recent projects</h3><a href="#">View all</a></div>
      <div class="card-body">
        <div class="stat"><div class="stat-label">Customers</div><div class="stat-value">10</div></div>
        <div class="admin-stat"><div class="admin-stat-label">Verified revenue</div><div class="admin-stat-value">₹4,998</div></div>
        <div class="admin-card-title">Payments to review</div>
        <p class="muted">Muted body copy that must stay readable.</p>
        <p class="dim">Dim helper copy.</p>
        <a class="mk-link" href="#">Add skills</a>
        <span class="badge badge-violet">Pro</span>
        <span class="badge badge-neutral">Free</span>
        <button class="btn btn-secondary btn-sm">Secondary</button>
        <button class="chip" aria-pressed="true">Chip on</button>
        <div class="segmented"><button aria-pressed="true">One</button><button>Two</button></div>
      </div>
    </div>
    <div class="admin-head" style="margin-top:16px"><h1>Admin overview</h1><p>Every number is a count query.</p></div>
    <aside class="sidebar" style="position:static;width:240px;margin-top:16px">
      <a class="sidebar-link is-active" href="#"><span>Overview</span></a>
      <a class="sidebar-link" href="#"><span>Projects</span></a>
    </aside>
    <div class="rail-tip is-visible">Domains</div>
    <div class="chat-shell" style="height:120px;margin-top:16px"></div>
    <div class="call-avatar">AS</div>
  \`;
  window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/audit.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(PAGE);
  }
  for (const file of [path.join(PUB, url), path.join(ROOT, url)]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
  }
  res.writeHead(404);
  res.end("no");
}).listen(4210, "0.0.0.0");

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto("http://127.0.0.1:4210/audit.html");
await page.waitForFunction(() => window.__ready);

const report = await page.evaluate(async ([onlyTheme, process_env_debug]) => {
  const { THEMES, toneOf } = await import("/js/ui/theme.js");

  const parse = (value) => {
    const nums = String(value).match(/[\d.]+/g);
    if (!nums) return null;
    const [r, g, b, a = 1] = nums.map(Number);
    return { r, g, b, a };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1
  });
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  /* The colour actually painted behind an element: walk up until an opaque
     background is found, compositing every translucent layer on the way. */
  /* A brand gradient paints a colour the computed style does not expose, so a
     text element sitting on one (a primary button, an avatar) cannot be measured
     honestly. Those are reported separately rather than guessed at. */
  /* Every colour stop baked into a gradient, so text on a brand fill can be
     checked against the worst stop it actually sits on. */
  const gradientStops = (style) => {
    const image = String(style.backgroundImage || "");
    if (!image.includes("gradient")) return [];
    return [...image.matchAll(/rgba?\(([^)]+)\)/g)]
      .map((match) => parse(match[1]))
      .filter((stop) => stop && stop.a >= 0.999);
  };

  /* Every surface the text could be sitting on: the composited solid backdrop,
     plus each colour stop of every gradient between the text and the page. */
  const surfacesBehind = (element) => {
    const layers = [];
    const stops = [];
    let node = element;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      stops.push(...gradientStops(style));
      const bg = parse(style.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    const base = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    return { solid: layers.reverse().reduce((acc, layer) => over(layer, acc), base), stops };
  };

  const results = [];
  for (const theme of THEMES) {
    if (onlyTheme && theme.id !== onlyTheme) continue;
    document.documentElement.dataset.theme = theme.id;
    document.documentElement.dataset.tone = toneOf(theme.id);
    void document.body.offsetHeight;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

    const failures = [];
    let onGradient = 0;

    for (const element of document.querySelectorAll("#root *, .rail-tip")) {
      const own = [...element.childNodes].some(
        (node) => node.nodeType === 3 && node.textContent.trim().length > 1
      );
      if (!own) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      if (style.color === "rgba(0, 0, 0, 0)" || style.webkitTextFillColor === "rgba(0, 0, 0, 0)") continue;

      const colour = parse(style.color);
      if (!colour) continue;
      /* Judged by the worst surface the text could land on, so "white on the
         brand gradient" is a number, not an assumption. */
      const { solid, stops } = surfacesBehind(element);
      /* A gradient paints over the element's (transparent) background colour, so
         when stops exist the page behind is not a surface the text can land on. */
      const surfaces = stops.length ? stops : [solid];
      const candidates = surfaces.map((surface) => {
        const fg = colour.a < 1 ? over(colour, surface) : colour;
        return { surface, ratio: +contrast(fg, surface).toFixed(2), gradient: surface !== solid };
      });
      const worst = candidates.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      const behind = worst.surface;
      const ratio = worst.ratio;
      if (worst.gradient) onGradient += 1;
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 600;
      const large = size >= 24 || (size >= 18.66 && bold);
      const floor = large ? 3 : element.classList.contains("dim") || element.classList.contains("muted") ? 3 : 4.5;
      if (ratio < floor) {
        failures.push({
          text: element.textContent.trim().slice(0, 40),
          selector: element.className || element.tagName.toLowerCase(),
          ratio,
          floor,
          colour: style.color,
          behind: `rgb(${Math.round(behind.r)}, ${Math.round(behind.g)}, ${Math.round(behind.b)})${worst.gradient ? " (worst gradient stop)" : ""}`
        });
      }
    }
    results.push({
      theme: theme.id,
      tone: toneOf(theme.id),
      failures,
      onGradient,
      white: getComputedStyle(document.documentElement).getPropertyValue("--white").trim(),
      base: getComputedStyle(document.documentElement).getPropertyValue("--base").trim()
    });
  }
  return results;
}, [only, true]);

await browser.close();
server.close();

let bad = 0;
for (const row of report) {
  if (!row.failures.length) {
    console.log(`  ✓ ${row.theme.padEnd(10)} ${row.tone}   every text element clears its floor${row.onGradient ? `  (${row.onGradient} judged against a gradient stop)` : ""}`);
    continue;
  }
  bad += row.failures.length;
  console.log(`  ✗ ${row.theme} (${row.tone}) — ${row.failures.length} unreadable element(s)  [--white ${row.white}, --base ${row.base}]`);
  for (const failure of row.failures) {
    console.log(`      ${failure.ratio}:1 (needs ${failure.floor}) "${failure.text}" [${failure.selector}] ${failure.colour} on ${failure.behind}`);
  }
}
console.log(bad ? `\n  ${bad} element(s) below the floor.\n` : "\n  All six themes readable.\n");
process.exit(bad ? 1 : 0);
