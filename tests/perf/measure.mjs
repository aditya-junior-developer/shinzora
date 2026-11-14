/* ==========================================================================
   Shinzora — page-load and interaction measurements under mobile conditions
   --------------------------------------------------------------------------
   Lighthouse can score the public pages, but it cannot sign in, so the
   dashboard is measured here with the same method on every page:

     • Network: 1.6 Mbit/s down, 150 ms round-trip, 4× CPU slowdown — the
       conditions Lighthouse uses for its mobile score.
     • Phone:  390×844 touch viewport, mobile user agent.
     • Cold:   a fresh browser profile (empty HTTP cache, no service worker).
     • Repeat: the same profile loaded a second time (warm HTTP cache and the
       service worker that the first visit installed).
     • Every number is the median of RUNS loads.

   Recorded per page: first contentful paint, largest contentful paint, cumulative
   layout shift, total blocking time (long tasks after FCP), DOMContentLoaded,
   load, the moment real content is on screen, requests and bytes on the wire
   (by type), and the worst input delay for a tap on a real control.

   Supabase is answered by the harness with the same stub shape the app
   expects. Nothing reaches the real backend, and nothing is written.

     node tests/perf/measure.mjs --label before        # writes tests/perf/results/before.json
     node tests/perf/measure.mjs --label after
   ========================================================================== */

import { chromium, devices } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || "http://127.0.0.1:4180";
const RUNS = Number(process.env.RUNS || 3);
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const LABEL = arg("--label", "run");
const ONLY = arg("--only", null);

const NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };
const CPU_SLOWDOWN = 4;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const ISO = new Date(NOW * 1000).toISOString();
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: {
    id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: ISO,
    created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Harness User" }, app_metadata: { provider: "email" }
  }
};

/* Enough rows that each view renders its populated layout. */
const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", username: "harness", email: "harness@example.com", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", category: "Design studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active", billing_cycle: "monthly", current_period_end: ISO }],
  projects: [{ id: "dddddddd-1111-2222-3333-444444444444", user_id: UID, name: "Paper & Thread Bindery", description: "A one-page site for a bookbinding studio.", type: "website", status: "published", slug: "paper-thread-bindery", version_count: 4, created_at: ISO, updated_at: ISO }],
  payments: [{ id: "eeeeeeee-1111-2222-3333-444444444444", user_id: UID, reference: "SZ-6D6757C8A6", purpose: "subscription:pro", amount: 2499, currency: "INR", status: "rejected", created_at: ISO }],
  store_orders: [], store_products: [], store_customers: [],
  support_tickets: [], notifications: [], onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "complete", current_step: 9, draft: {} }],
  customer_activity: [], team_members: [], team_conversations: [], community_groups: [], domains: [], store_visits: []
};

const JSON_HEADERS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "content-type": "application/json" };

/* ----------------------------------------------------------- the pages */
const PAGES = [
  { id: "landing", url: "/", signedIn: false, interact: "[data-nav-toggle]", ready: "h1" },
  { id: "login", url: "/auth/login/", signedIn: false, interact: null, ready: "form, input" },
  { id: "app-overview", url: "/app/", signedIn: true, interact: "#sidebar-nav [data-nav]", ready: ".page-title" },
  { id: "app-messages", url: "/app/?view=messages", signedIn: true, interact: "#sidebar-nav [data-nav]", ready: ".page-title" },
  { id: "app-builder", url: "/app/?view=website-builder", signedIn: true, interact: "#sidebar-nav [data-nav]", ready: ".page-title, h1, h2" },
  { id: "app-billing", url: "/app/?view=billing", signedIn: true, interact: "#sidebar-nav [data-nav]", ready: ".page-title" }
].filter((page) => !ONLY || ONLY.split(",").includes(page.id));

/* ------------------------------------------------------- the page probe */
/* Runs before any page script. Collects paint, layout-shift, long-task and
   event-timing entries into window.__perf so the harness can read them after
   the load. */
const PROBE = () => {
  window.__perf = { fcp: null, lcp: null, cls: 0, longTasks: [], events: [] };
  const observe = (type, options, onEntry) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe({ type, buffered: true, ...options });
    } catch {
      /* unsupported entry type on this engine */
    }
  };
  observe("paint", {}, (entry) => {
    if (entry.name === "first-contentful-paint" && window.__perf.fcp === null) window.__perf.fcp = entry.startTime;
  });
  observe("largest-contentful-paint", {}, (entry) => {
    window.__perf.lcp = entry.startTime;
  });
  observe("layout-shift", {}, (entry) => {
    if (!entry.hadRecentInput) window.__perf.cls += entry.value;
  });
  observe("longtask", {}, (entry) => {
    window.__perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observe("event", { durationThreshold: 16 }, (entry) => {
    window.__perf.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration, processing: entry.processingEnd - entry.processingStart });
  });
};

const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/* ------------------------------------------------------------- one load */
async function loadOnce(browser, page, { signedIn, url, ready, interact }, context) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", NETWORK);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

  const requests = [];
  const finished = new Map();
  cdp.on("Network.requestWillBeSent", (event) => {
    requests.push({ id: event.requestId, url: event.request.url, type: event.type || "Other" });
  });
  cdp.on("Network.loadingFinished", (event) => finished.set(event.requestId, event.encodedDataLength));
  cdp.on("Network.responseReceived", (event) => {
    const request = requests.find((r) => r.id === event.requestId);
    if (request) request.status = event.response.status;
  });

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const start = Date.now();
  await page.goto(BASE + url, { waitUntil: "load", timeout: 90000 });
  const loadMs = Date.now() - start;

  const ready_ms = await page
    .waitForFunction(
      (selector) => {
        const node = document.querySelector(selector);
        return node && node.textContent && node.textContent.trim().length > 0;
      },
      ready.split(",")[0].trim(),
      { timeout: 60000, polling: 50 }
    )
    .then(() => Date.now() - start)
    .catch(() => null);

  await page.waitForTimeout(1500);

  let inp = null;
  if (interact) {
    const target = page.locator(interact).first();
    if (await target.count()) {
      await target.click({ timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(1200);
    }
  }

  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const longTasks = window.__perf.longTasks;
    const fcp = window.__perf.fcp || 0;
    /* Total blocking time: the part of every long task beyond 50 ms that ran
       after the first paint, which is what delays taps. */
    const tbt = longTasks.filter((t) => t.start >= fcp).reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0);
    const events = window.__perf.events;
    const worst = events.length ? Math.max(...events.map((e) => e.duration)) : null;
    return {
      fcp,
      lcp: window.__perf.lcp,
      cls: window.__perf.cls,
      tbt,
      dcl: nav ? nav.domContentLoadedEventEnd : null,
      load: nav ? nav.loadEventEnd : null,
      worstEvent: worst,
      tapProcessing: events.length ? Math.max(...events.map((e) => e.processing)) : null
    };
  });
  inp = perf.worstEvent;

  const bytes = { total: 0, js: 0, css: 0, img: 0, font: 0, data: 0 };
  const counts = { total: 0, js: 0, css: 0, img: 0, font: 0, data: 0 };
  for (const request of requests) {
    if (!request.url.startsWith(BASE) && !/supabase/.test(request.url)) continue;
    const size = finished.get(request.id) || 0;
    const kind = /\.js(\?|$)/.test(request.url) ? "js"
      : /\.css(\?|$)/.test(request.url) ? "css"
      : /\.(png|jpe?g|webp|gif|svg|ico)(\?|$)/.test(request.url) ? "img"
      : /\.woff2?(\?|$)/.test(request.url) ? "font"
      : "data";
    bytes.total += size;
    bytes[kind] += size;
    counts.total += 1;
    counts[kind] += 1;
  }

  return {
    ...perf,
    tbt: Math.round(perf.tbt),
    ready: ready_ms,
    loadMs,
    inp,
    bytes,
    counts,
    errors: errors.length,
    signedIn
  };
}

/* ----------------------------------------------------------- one context */
async function makeContext(browser, { signedIn }) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    viewport: { width: 390, height: 844 },
    serviceWorkers: "allow"
  });
  await context.addInitScript(PROBE);
  if (signedIn) {
    await context.addInitScript((session) => {
      try {
        localStorage.setItem("shinzora.auth", JSON.stringify(session));
      } catch {
        /* sandboxed frame */
      }
    }, SESSION);
  }
  await context.route("**://*.supabase.co/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!signedIn) {
      if (pathname.includes("/auth/v1/")) return route.fulfill({ status: 401, headers: JSON_HEADERS, body: '{"message":"no session"}' });
      if (pathname.includes("/rest/v1/")) return route.fulfill({ status: 200, headers: { ...JSON_HEADERS, "content-range": "*/0" }, body: "[]" });
    }
    if (pathname.includes("/auth/v1/")) return route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(SESSION.user) });
    if (pathname.includes("/rest/v1/rpc/")) return route.fulfill({ status: 200, headers: JSON_HEADERS, body: "null" });
    const table = Object.keys(ROWS).find((name) => pathname.includes(`/rest/v1/${name}`));
    if (table) return route.fulfill({ status: 200, headers: { ...JSON_HEADERS, "content-range": `0-${ROWS[table].length}/${ROWS[table].length}` }, body: JSON.stringify(ROWS[table]) });
    if (pathname.includes("/rest/v1/")) return route.fulfill({ status: 200, headers: { ...JSON_HEADERS, "content-range": "*/0" }, body: "[]" });
    return route.fulfill({ status: 503, headers: JSON_HEADERS, body: '{"error":"not deployed in this environment"}' });
  });
  return context;
}

const median_of = (rows, key) => median(rows.map((row) => row[key]));
const medianBytes = (rows, group, key) => median(rows.map((row) => row[group][key]));

/* ------------------------------------------------------------ the run */
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const results = {};

console.log(`\nperformance: ${LABEL} · ${BASE} · ${RUNS} runs · 1.6 Mbit/s, 150 ms RTT, 4× CPU\n`);
for (const pageSpec of PAGES) {
  const cold = [];
  const repeat = [];
  for (let run = 0; run < RUNS; run += 1) {
    const context = await makeContext(browser, pageSpec);
    const page = await context.newPage();
    cold.push(await loadOnce(browser, page, pageSpec, context));
    repeat.push(await loadOnce(browser, page, pageSpec, context));
    await context.close();
  }
  const summarise = (rows) => ({
    fcp: median_of(rows, "fcp"),
    lcp: median_of(rows, "lcp"),
    cls: median_of(rows, "cls"),
    tbt: median_of(rows, "tbt"),
    dcl: median_of(rows, "dcl"),
    load: median_of(rows, "load"),
    ready: median_of(rows, "ready"),
    inp: median_of(rows, "inp"),
    bytes: medianBytes(rows, "bytes", "total"),
    jsBytes: medianBytes(rows, "bytes", "js"),
    cssBytes: medianBytes(rows, "bytes", "css"),
    imgBytes: medianBytes(rows, "bytes", "img"),
    fontBytes: medianBytes(rows, "bytes", "font"),
    requests: medianBytes(rows, "counts", "total"),
    errors: median_of(rows, "errors")
  });
  results[pageSpec.id] = { cold: summarise(cold), repeat: summarise(repeat) };
  const c = results[pageSpec.id].cold;
  const r = results[pageSpec.id].repeat;
  const kb = (n) => (n == null ? "—" : `${Math.round(n / 102.4) / 10} KB`);
  const ms = (n) => (n == null ? "—" : `${Math.round(n)} ms`);
  console.log(
    `${pageSpec.id.padEnd(13)} cold   FCP ${ms(c.fcp).padStart(8)}  LCP ${ms(c.lcp).padStart(8)}  ready ${ms(c.ready).padStart(8)}  TBT ${ms(c.tbt).padStart(7)}  CLS ${(c.cls ?? 0).toFixed(3)}  bytes ${kb(c.bytes).padStart(9)} (js ${kb(c.jsBytes)}, css ${kb(c.cssBytes)}, img ${kb(c.imgBytes)})  req ${c.requests}`
  );
  console.log(
    `${"".padEnd(13)} repeat FCP ${ms(r.fcp).padStart(8)}  LCP ${ms(r.lcp).padStart(8)}  ready ${ms(r.ready).padStart(8)}  TBT ${ms(r.tbt).padStart(7)}  CLS ${(r.cls ?? 0).toFixed(3)}  bytes ${kb(r.bytes).padStart(9)}  req ${r.requests}   tap ${ms(c.inp)}`
  );
}

await browser.close();

fs.mkdirSync(path.join(here, "results"), { recursive: true });
const out = path.join(here, "results", `${LABEL}.json`);
fs.writeFileSync(out, JSON.stringify({ label: LABEL, base: BASE, runs: RUNS, network: "1.6 Mbit/s, 150 ms RTT", cpu: "4x", measuredAt: new Date().toISOString(), results }, null, 2));
console.log(`\nwrote ${path.relative(path.resolve(here, "../.."), out)}`);
