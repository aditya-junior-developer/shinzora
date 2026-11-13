/* ==========================================================================
   Shinzora — the real app on a phone
   --------------------------------------------------------------------------
   `mobile-views.mjs` mounts the view modules into the shell markup. This goes
   one step further and drives the **real application**: the real router, the
   real shell, the real CSS, the real views, against a stubbed network (the
   project has no demo data, so Supabase REST is answered by the harness and
   nothing is written anywhere).

   It is the difference between "the components fit" and "the page a person
   opens on their phone fits". For every sidebar view at 360 and 390px it
   checks:

     • the document does not scroll sideways
     • nothing sits past the right edge, except inside a deliberate scroller
     • the view actually painted something
     • no page errors

   Screenshots land in /tmp/mobile-app/ so the result can be looked at.

     npm run dev                                    # separate terminal
     BASE=http://127.0.0.1:4173 node tests/browser/mobile-app.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const OUT = "/tmp/mobile-app";
const WIDTHS = (process.env.WIDTHS || "360,390").split(",").map(Number);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const ISO = new Date(NOW * 1000).toISOString();
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
  sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com"
})}.sig`;

const SESSION = {
  access_token: JWT,
  token_type: "bearer",
  expires_in: 86400,
  expires_at: NOW + 86400,
  refresh_token: "harness",
  user: {
    id: UID,
    aud: "authenticated",
    role: "authenticated",
    email: "harness@example.com",
    email_confirmed_at: ISO,
    created_at: "2026-10-01T09:00:00Z",
    user_metadata: { full_name: "Harness User" },
    app_metadata: { provider: "email" }
  }
};

/* One row per table, enough for every view to render its populated layout
   rather than its empty state — the layout is the thing under test. */
const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", username: "harness", email: "harness@example.com", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", category: "Design studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active", billing_cycle: "monthly", current_period_end: ISO }],
  projects: [{
    id: "dddddddd-1111-2222-3333-444444444444",
    user_id: UID,
    name: "Paper & Thread Bindery",
    description: "Purpose: A one-page site for a Delhi bookbinding studio that repairs and rebinds old books by hand. Visitors should be able to read the services and send an enquiry.",
    type: "website",
    status: "published",
    slug: "paper-thread-bindery-88ep",
    version_count: 4,
    created_at: ISO,
    updated_at: ISO
  }],
  payments: [
    { id: "eeeeeeee-1111-2222-3333-444444444444", user_id: UID, reference: "SZ-6D6757C8A6", purpose: "subscription:pro", amount: 2499, currency: "INR", status: "rejected", created_at: ISO },
    { id: "eeeeeeee-2222-2222-3333-444444444444", user_id: UID, reference: "SZ-8593B31642", purpose: "subscription:pro", amount: 2499, currency: "INR", status: "rejected", created_at: ISO }
  ],
  store_orders: [{
    id: "ffffffff-1111-2222-3333-444444444444", user_id: UID, customer_name: "Manglam Verma",
    reference: "ORD-2291", status: "pending", total: 1899, currency: "INR", created_at: ISO, updated_at: ISO
  }],
  store_products: [{
    id: "ffffffff-2222-2222-3333-444444444444", user_id: UID, name: "Hand-bound notebook",
    price: 899, currency: "INR", stock: 4, category: "Stationery", created_at: ISO, updated_at: ISO
  }],
  store_customers: [{
    id: "ffffffff-3333-2222-3333-444444444444", user_id: UID, name: "Manglam Verma",
    email: "manglam@example.com", phone: "+91 90000 11111", orders_count: 2, created_at: ISO
  }],
  support_tickets: [{
    id: "ffffffff-4444-2222-3333-444444444444", user_id: UID, subject: "website is not working",
    message: "website is not working", ticket_type: "customer", priority: "low", status: "open",
    created_at: ISO, updated_at: ISO
  }],
  notifications: [
    { id: "ffffffff-5555-2222-3333-444444444444", user_id: UID, title: "Call from Manglam", body: "Voice call", type: "call", read_at: null, created_at: ISO, meta: {} },
    { id: "ffffffff-6666-2222-3333-444444444444", user_id: UID, title: "Video call from Manglam", body: "Video call", type: "call", read_at: null, created_at: ISO, meta: {} }
  ],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "complete", current_step: 9, draft: {} }],
  customer_activity: [{ id: "ffffffff-7777-2222-3333-444444444444", user_id: UID, action: "payment_rejected", entity_type: "payment", created_at: ISO, meta: {} }],
  team_members: [], team_conversations: [], community_groups: [], domains: [], store_visits: []
};

const fulfill = (route, body, extra = {}) =>
  route.fulfill({
    status: 200,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range",
      "content-type": "application/json",
      ...extra
    },
    body
  });

async function stubSupabase(route) {
  const url = new URL(route.request().url());
  const file = url.pathname;
  if (file.includes("/rest/v1/rpc/")) return fulfill(route, "null");
  const table = Object.keys(ROWS).find((name) => file.includes(`/rest/v1/${name}`));
  if (table) return fulfill(route, JSON.stringify(ROWS[table]), { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (file.includes("/rest/v1/")) return fulfill(route, "[]", { "content-range": "*/0" });
  if (file.includes("/auth/v1/")) return fulfill(route, JSON.stringify(SESSION.user));
  return route.fulfill({
    status: 503,
    headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
    body: '{"error":"edge function not deployed in this environment"}'
  });
}

/* Every view the sidebar can open. */
const VIEWS = [
  "overview", "projects", "analytics", "billing", "messages", "meeting", "support",
  "notifications", "settings", "team", "community", "orders", "inventory", "customers",
  "store", "domains", "invitations", "freelancer", "portfolio", "find-team", "requests",
  "marketplace", "marketing", "assistant"
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const failures = [];

const MEASURE = () => {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const inScroller = (node) => {
    for (let up = node.parentElement; up; up = up.parentElement) {
      const ox = getComputedStyle(up).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };
  const wide = [];
  for (const node of document.querySelectorAll("#view-root *, .app-topbar *")) {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    if (inScroller(node)) continue;
    if (box.right > vw + 1.5) {
      wide.push(`${node.tagName.toLowerCase()}.${String(node.className || "").slice(0, 40)}`);
    }
  }
  const root = document.getElementById("view-root");
  return {
    overflow: doc.scrollWidth - doc.clientWidth,
    wide: [...new Set(wide)].slice(0, 6),
    painted: root ? Math.round(root.getBoundingClientRect().height) : 0,
    words: root ? String(root.textContent || "").trim().length : 0,
    empty: Boolean(root?.querySelector(".empty, .empty-state"))
  };
};

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript((session) => {
    try {
      localStorage.setItem("shinzora.auth", JSON.stringify(session));
    } catch {
      /* sandboxed frame */
    }
  }, SESSION);
  await ctx.route("**://*.supabase.co/**", stubSupabase);

  for (const view of VIEWS) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/Failed to load resource|503|ERR_/.test(message.text())) errors.push(message.text());
    });

    try {
      await page.goto(`${BASE}/app/?view=${view}`, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1100);
      const result = await page.evaluate(MEASURE);
      await page.screenshot({ path: path.join(OUT, `${view}-${width}.png`), fullPage: true });

      const problems = [];
      if (result.overflow > 1) problems.push(`scrolls sideways by ${result.overflow}px`);
      if (result.wide.length) problems.push(`past the right edge: ${result.wide.join(", ")}`);
      if (!result.empty && (result.painted < 200 || result.words < 30)) {
        problems.push(`barely rendered (${result.painted}px, ${result.words} chars)`);
      }
      if (errors.length) problems.push(`page error: ${errors[0].slice(0, 80)}`);

      if (problems.length) {
        failures.push(`${view}@${width}`);
        console.log(`  ✗ ${view} @${width}px`);
        for (const problem of problems) console.log(`      ${problem}`);
      } else {
        console.log(`  ✓ ${view} @${width}px`);
      }
    } catch (error) {
      failures.push(`${view}@${width}`);
      console.log(`  ✗ ${view} @${width}px — ${error.message.slice(0, 110)}`);
    }
    await page.close();
  }
  await ctx.close();
}

await browser.close();

console.log(
  failures.length
    ? `\n${failures.length} view/width combination(s) broken on a phone: ${failures.join(", ")}\n`
    : `\nEvery dashboard view fits a phone at ${WIDTHS.join("px and ")}px\n`
);
if (failures.length) process.exit(1);
