/* ==========================================================================
   Shinzora — mobile layout harness for the dashboard views
   --------------------------------------------------------------------------
   The shell chrome is one thing; the view inside it is another. These views
   were reported as unusable on a phone, and "unusable" is specific: a table
   that pushes the page sideways, a two-column grid that never collapses, a card
   that clips its own content.

   This harness mounts the **real view modules** into the real shell markup and
   the real stylesheets, at phone width, with the data layer stubbed (no
   Supabase, no network). It then measures, for each view:

     • horizontal overflow of the document (the sideways scroll)
     • any element whose right edge is past the viewport
     • any element scrolling inside itself when it should have wrapped
     • tiny tap targets on the primary controls

   Screenshots are written to /tmp/mobile/ so the layout can be looked at, not
   only measured.

     node tests/browser/mobile-views.mjs            # needs playwright-core
     node tests/browser/mobile-views.mjs --only billing,projects
   ========================================================================== */

import { chromium } from "playwright-core";
import * as esbuild from "esbuild";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const OUT = "/tmp/mobile";

const only = (() => {
  const index = process.argv.indexOf("--only");
  return index > 0 ? new Set(process.argv[index + 1].split(",")) : null;
})();

/* Phones, not one phone: a 360px Android is the narrowest thing in real use,
   and a layout that only fits 390 is not fixed. */
const WIDTHS = (() => {
  const index = process.argv.indexOf("--widths");
  return index > 0 ? process.argv[index + 1].split(",").map(Number) : [360, 390, 430];
})();

const THEME = (() => {
  const index = process.argv.indexOf("--theme");
  return index > 0 ? process.argv[index + 1] : "midnight";
})();

/* Every view that is reachable from the sidebar. */
const VIEWS = [
  "overview",
  "analytics",
  "billing",
  "projects",
  "messages",
  "meeting",
  "support",
  "notifications",
  "settings",
  "team",
  "community"
];

/* --------------------------------------------------------------- data stubs */
/* Shapes taken from the real data layer; no invented demo rows beyond the one
   record each view needs to render its card instead of its empty state. */
const DATA_STUB = `
  const fakeId = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const now = new Date().toISOString();
  export const state = {
    profile: { id: fakeId(1), full_name: "Aditya Sharma", username: "aditya", account_type: "business",
      business_name: "Evoluova", plan: "pro", category: "Creative agency", created_at: now },
    session: { user: { id: fakeId(1) } },
    business: { id: fakeId(2), name: "Evoluova" }
  };
  export const plan = () => ({ id: "pro", name: "Pro" });
  export const aiCredits = () => ({ used: 26, limit: 900, percent: 3 });
  export const hasCompletedOnboarding = () => true;
  export const displayName = () => "Aditya Sharma";
  export const loadIdentity = async () => state;
  const rows = {
    projects: [{ id: fakeId(3), name: "Paper & Thread Bindery", description:
      "Purpose: A one-page site for a Delhi bookbinding studio that repairs and rebinds old books by hand. Visitors should be able to read the services and send an enquiry.",
      kind: "website", status: "published", slug: "paper-thread-bindery-88ep", versions: 4, updated_at: now, created_at: now }],
    payments: [{ id: fakeId(4), reference: "SZ-6D6757C8A6", purpose: "subscription:pro", amount: 2499,
      currency: "INR", status: "rejected", created_at: now },
      { id: fakeId(5), reference: "SZ-8593B31642", purpose: "subscription:pro", amount: 2499,
      currency: "INR", status: "rejected", created_at: now },
      { id: fakeId(6), reference: "SZ-E1AF8F8BB1", purpose: "subscription:pro", amount: 2499,
      currency: "INR", status: "rejected", created_at: now }],
    orders: [], products: [], customers: [],
    tickets: [{ id: fakeId(7), subject: "website is not working", description: "website is not working",
      type: "customer", priority: "low", status: "resolved", created_at: now }],
    notifications: [{ id: fakeId(8), title: "Call from Manglam", body: "Voice call", type: "call",
      is_read: false, created_at: now, meta: {} },
      { id: fakeId(9), title: "Video call from Manglam", body: "Video call", type: "call",
      is_read: false, created_at: now, meta: {} }],
    announcements: []
  };
  const ok = (key) => async () => ({ data: rows[key] || [], error: null, count: (rows[key] || []).length });
  export const projects = ok("projects");
  export const payments = ok("payments");
  export const orders = ok("orders");
  export const products = ok("products");
  export const customers = ok("customers");
  export const tickets = ok("tickets");
  export const notifications = ok("notifications");
  export const announcements = ok("announcements");
  export const overview = async () => ({
      orders: [], recentOrders: [], activity: [], notifications: [], projects: [],
      lowStock: [], pendingPayments: [], tickets: [], stats: {}, metrics: {},
      revenueSeries: [], topProducts: [],
      revenue: 0, orderCount: 0, customerCount: 0, productCount: 0, openTickets: 0
    });
  export const subscription = async () => ({ data: { plan: "pro", status: "active" }, error: null });
  export const isSchemaMissing = () => false;
`;

const DATA_EXPORTS = `
  export const logActivity = async () => ({ error: null });
  export const markAllNotificationsRead = async () => ({ error: null });
  export const markNotificationRead = async () => ({ error: null });
  export const updateBusiness = async () => ({ error: null });
  export const updateProfile = async () => ({ error: null });
  export const uid = () => "00000000-0000-4000-8000-000000000001";
`;

const STUB_PLUGIN = {
  name: "mobile-view-stubs",
  setup(build) {
    const stub = (path) => ({ path, namespace: "stub" });
    /* The views only need the data layer and the network edges replaced; the
       components, DOM helpers, icons and formatting are the real ones, because
       the layout being measured is built out of them. */
    build.onResolve({ filter: /(^|\/)data\.js$/ }, () => stub("data-stub"));
    build.onResolve({ filter: /lib\/supabase\.js$/ }, () => stub("sb-stub"));
    build.onResolve({ filter: /lib\/api\.js$/ }, () => stub("api-stub"));
    build.onResolve({ filter: /config\/env\.js$/ }, () => stub("env-stub"));
    build.onResolve({ filter: /lib\/store\.js$/ }, () => stub("store-stub"));
    build.onResolve({ filter: /lib\/guard\.js$/ }, () => stub("guard-stub"));
    build.onResolve({ filter: /lib\/site-url\.js$/ }, () => stub("site-stub"));
    build.onResolve({ filter: /lib\/live-channel\.js$/ }, () => stub("channel-stub"));
    build.onResolve({ filter: /ui\/notify\.js$/ }, () => stub("notify-stub"));
    build.onResolve({ filter: /ui\/heartbeat\.js$/ }, () => stub("noop"));
    build.onResolve({ filter: /ui\/sidebar\.js$/ }, () => stub("noop"));
    build.onResolve({ filter: /dashboard\/shell\.js$/ }, () => stub("noop"));
    build.onResolve({ filter: /(^|\/)shell\.js$/ }, () => stub("shell-stub"));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      switch (args.path) {
        case "data-stub":
          return { contents: DATA_STUB + DATA_EXPORTS, loader: "js" };
        case "sb-stub":
          return {
            contents: `
              export const sb = {
                rpc: async () => ({ data: {}, error: null }),
                from: () => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q,
                  insert: () => q, update: () => q, single: () => q,
                  then: (done) => Promise.resolve({ data: [], error: null, count: 0 }).then(done) };
                  return q; },
                channel: () => { const api = { on: () => api, subscribe: () => api, track: async () => {}, presenceState: () => ({}) }; return api; },
                removeChannel: () => {},
                storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
                auth: {
                  getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-000000000001" } } }),
                  getSession: async () => ({ data: { session: { user: { id: "00000000-0000-4000-8000-000000000001" } } }, error: null })
                }
              };
              export const getSession = async () => ({ data: { session: { user: { id: "00000000-0000-4000-8000-000000000001" } } }, error: null });
              export const uploadPublic = async () => ({ path: "", error: null });
              export const normalizeError = (e) => (e instanceof Error ? e : new Error(String(e?.message || e || "error")));`,
            loader: "js"
          };
        case "api-stub":
          return {
            contents: `export const api = new Proxy({}, { get: () => async () => ({ data: {}, error: null }) });
              export const runtimeConfig = () => ({ upiReady: false, razorpayReady: false });
              export const actionPendingDeploy = () => false;
              export const invokeEdge = async () => ({ data: null, error: null });`,
            loader: "js"
          };
        case "env-stub":
          return {
            contents: `export const env = { appName: "Shinzora", supportEmail: "x@y.z", supabaseUrl: "", supabaseKey: "", siteUrl: "" };
              export const BUSINESS_CATEGORIES = ["Creative agency", "Retail", "Services"];
              export const PLANS = [
                { id: "free", name: "Free", priceMonthly: 0, blurb: "Validate an idea and ship a first page.",
                  features: ["1 project (website, app or store)", "AI assistant — 30 generations / month",
                    "Shinzora subdomain publishing (with Shinzora badge)", "Single-page version history"] },
                { id: "pro", name: "Pro", priceMonthly: 2499, blurb: "For founders running a real business on it.",
                  features: ["15 projects", "AI assistant — 900 generations / month", "Store, inventory and orders",
                    "Custom domain with a domain manager"] },
                { id: "enterprise", name: "Enterprise", priceMonthly: 9999, blurb: "Managed operations for established teams.",
                  features: ["100 projects and unlimited pages", "AI assistant — 6,000 generations / month",
                    "Priority AI queue and larger context", "Managed domain + registrar workflow"] }
              ];
              export const planById = (id) => PLANS.find((p) => p.id === id) || PLANS[0];`,
            loader: "js"
          };
        case "store-stub":
          return { contents: DATA_STUB.replace(/export const (projects|payments|orders|products|customers|tickets|notifications|announcements|overview|subscription|isSchemaMissing)[\s\S]*?(?=\n  export const|\n  const ok)/g, ""), loader: "js" };
        case "shell-stub":
          return { contents: "export const refreshNotificationBadge = async () => {};", loader: "js" };
        case "guard-stub":
          return { contents: "export const logoutEverywhere = async () => {};", loader: "js" };
        case "site-stub":
          return { contents: "export const rememberPublishedSite = () => {}; export const resolvePublishedSite = () => null;", loader: "js" };
        case "channel-stub":
          return {
            contents: `export const openLiveChannel = () => null;
              export const closeLiveChannel = () => {};
              export const releaseTopic = async () => false;`,
            loader: "js"
          };
        case "notify-stub":
          return {
            contents: `export const initNotifications = async () => ({});
              export const presentNotification = () => true;
              export const stopCallRinging = () => {};
              export const ringForCall = () => () => {};
              export const setActiveCallTopic = () => {};
              export const setCallAnswerer = () => {};
              export const bindNotificationSettings = () => {};
              export const loadPrefs = async () => ({});
              export const notificationSettingsMarkup = () => "";`,
            loader: "js"
          };
        default:
          return { contents: "export default {};", loader: "js" };
      }
    });
  }
};

/* Mount every view into one bundle: the harness asks for one by name, so the
   router's own dynamic imports are not needed here. */
const entry = `
${VIEWS.map((view, index) => `import v${index} from ${JSON.stringify(`./public/js/modules/dashboard/views/${view}.js`)};`).join("\n")}
window.__views = { ${VIEWS.map((view, index) => `${JSON.stringify(view)}: v${index}`).join(", ")} };
`;

fs.mkdirSync(OUT, { recursive: true });

const build = await esbuild.build({
  stdin: { contents: entry, resolveDir: repo, sourcefile: "mobile-entry.js", loader: "js" },
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
  plugins: [STUB_PLUGIN]
});
const bundle = build.outputFiles[0].text;

const CSS = ["tokens", "components", "app", "views", "theme-light"].map((name) => ({
  name,
  text: fs.readFileSync(path.join(repo, `public/css/${name}.css`), "utf8")
}));

/* The shell markup the views actually live in. */
const SHELL = `<!doctype html><html lang="en" data-theme="midnight"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${CSS.map((sheet) => `<style>${sheet.text}</style>`).join("\n")}
</head><body>
<div class="app-shell">
  <aside class="app-sidebar" id="app-sidebar" hidden></aside>
  <div class="app-main">
    <header class="app-topbar">
      <button class="topbar-toggle" data-sidebar-toggle aria-label="Menu"><span class="hamb-line"></span></button>
      <div class="topbar-search"><input type="search" placeholder="Search your workspace" /></div>
      <div class="topbar-actions">
        <button class="topbar-avatar"><span class="avatar avatar-sm">SZ</span></button>
      </div>
    </header>
    <main class="app-content" id="app-content"><div id="view-root"></div></main>
  </div>
</div>
<script type="module">
import "/views.js";
window.__mount = async (name) => {
  const root = document.getElementById("view-root");
  root.innerHTML = "";
  const fn = window.__views[name];
  if (!fn) throw new Error("no view " + name);
  await fn(root, { params: new URLSearchParams(location.search), navigate: () => {}, refresh: () => {} });
  return true;
};
window.__ready = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/views.js")) {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(bundle);
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(SHELL);
});
await new Promise((done) => server.listen(4316, "0.0.0.0", done));

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const failures = [];

/* What counts as broken on a phone: the page scrolls sideways, or something
   sits past the right edge, or a card clips its own text. */
const MEASURE = () => {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement;
  const overflow = doc.scrollWidth - doc.clientWidth;
  const wide = [];
  const inScroller = (node) => {
    for (let up = node.parentElement; up; up = up.parentElement) {
      if (getComputedStyle(up).overflowX === "auto" || getComputedStyle(up).overflowX === "scroll") return true;
    }
    return false;
  };
  for (const node of document.querySelectorAll("#view-root *")) {
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (inScroller(node)) continue;
    if (box.right > vw + 1.5) {
      wide.push({
        tag: node.tagName.toLowerCase(),
        cls: String(node.className || "").slice(0, 48),
        right: Math.round(box.right),
        width: Math.round(box.width),
        text: String(node.textContent || "").trim().slice(0, 40)
      });
    }
  }
  /* Scroll traps: a wrapper that scrolls sideways instead of wrapping, which is
     how a table silently hides its last column on a phone. */
  const scrollers = [];
  for (const node of document.querySelectorAll("#view-root *")) {
    const style = getComputedStyle(node);
    if (node.scrollWidth - node.clientWidth > 2 && style.overflowX !== "visible" && style.overflowX !== "hidden") {
      scrollers.push({ cls: String(node.className || "").slice(0, 40), over: node.scrollWidth - node.clientWidth });
    }
  }
  /* Buttons a thumb cannot hit. */
  const small = [];
  for (const node of document.querySelectorAll("#view-root button, #view-root a.btn")) {
    const box = node.getBoundingClientRect();
    if (box.width === 0) continue;
    if (box.height < 34 || box.width < 34) {
      small.push({ text: String(node.textContent || "").trim().slice(0, 24), h: Math.round(box.height), w: Math.round(box.width) });
    }
  }
  /* How much the view actually painted. A blank screen has no overflow, no
     tiny targets and no errors — it would pass every other check. */
  const root = document.getElementById("view-root");
  const painted = root ? Math.round(root.getBoundingClientRect().height) : 0;
  const cards = root ? root.querySelectorAll(".card, .stat, .kpi-card, .empty-state").length : 0;
  const words = root ? String(root.textContent || "").trim().length : 0;
  const emptyState = Boolean(root?.querySelector(".empty, .empty-state"));
  return { overflow, wide: wide.slice(0, 6), scrollers: scrollers.slice(0, 4), small: small.slice(0, 5), vw, painted, cards, words, emptyState };
};

async function run(browser, width) {
const ctx = await browser.newContext({
  viewport: { width, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36"
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("http://127.0.0.1:4316/", { waitUntil: "load" });
await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), THEME);
await page.waitForFunction(() => window.__ready);

for (const view of VIEWS) {
  if (only && !only.has(view)) continue;
  const before = errors.length;
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate((name) => window.__mount(name), view);
    await page.waitForTimeout(320);
    const result = await page.evaluate(MEASURE);
    await page.screenshot({ path: path.join(OUT, `${view}-${width}.png`), fullPage: true });
    /* A second shot of the scrolled-down part, because most of the broken
       layouts on these pages were below the fold. */
    await page.evaluate(() => window.scrollTo(0, 620));
    await page.waitForTimeout(140);
    await page.screenshot({ path: path.join(OUT, `${view}-${width}-mid.png`) });

    const problems = [];
    if (result.overflow > 1) problems.push(`page scrolls sideways by ${result.overflow}px`);
    if (result.wide.length) problems.push(`past the right edge: ${result.wide.map((w) => `${w.tag}.${w.cls}`).join(", ")}`);
    if (result.small.length)
      problems.push(`tap targets under 34px: ${result.small.map((s) => `"${s.text}" ${s.w}×${s.h}`).join(", ")}`);
    if (errors.length > before) problems.push(`page error: ${errors[errors.length - 1].slice(0, 70)}`);
    /* A real empty state is a rendered view; a blank one is not. */
    if (result.painted < 200 || result.words < 40) {
      if (!result.emptyState) problems.push(`nothing rendered (${result.painted}px tall, ${result.words} characters)`);
    }

    if (problems.length) {
      failures.push({ view, width, problems });
      console.log(`  ✗ ${view} @${width}px`);
      for (const problem of problems) console.log(`      ${problem}`);
      if (result.scrollers.length) console.log(`      inner scrollers: ${JSON.stringify(result.scrollers)}`);
    } else {
      console.log(`  ✓ ${view} @${width}px`);
    }
  } catch (error) {
    failures.push({ view, width, problems: [error.message] });
    console.log(`  ✗ ${view} @${width}px — ${error.message.slice(0, 120)}`);
  }
}

await ctx.close();
}

for (const width of WIDTHS) await run(browser, width);

await browser.close();
server.close();

console.log(
  failures.length
    ? `\n${failures.length} view/width combination(s) not fit for a phone\n`
    : `\nEvery view fits ${WIDTHS.join("px, ")}px in the ${THEME} theme\n`
);
if (failures.length) process.exit(1);
