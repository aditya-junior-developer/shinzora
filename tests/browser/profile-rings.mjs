/* ==========================================================================
   Shinzora — browser harness: profile rings (0069, 0070)
   --------------------------------------------------------------------------
     - Settings no longer shows a Premium profile card or any ring controls
     - Billing lists the eight designs, marks the one worn, and each Apply
       button creates a ring_apply:<id> payment (the server sets the price)
     - the owner's avatar wears the design the database returns (data-ring and
       --ring-art), and nothing else about the ring is read from the browser
     - no horizontal overflow and no page errors at 390 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/profile-rings.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-r9";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Harness User" } }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};

/* The stub's memory for this member. */
const calls = { rings: 0, payments: [] };
let worn = "sakura";

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;

  if (path.includes("/functions/v1/payments")) {
    const body = req.postDataJSON() || {};
    calls.payments.push(body);
    return send(route, 200, {
      payment: { id: "dddddddd-1111-2222-3333-444444444444", reference: "SZ-RING-1", amount: 1000, currency: "INR", status: "pending", purpose: body.purpose, label: body.label },
      upi: null, reused: false
    });
  }

  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    if (name === "member_rings") {
      calls.rings += 1;
      const ids = req.postDataJSON()?.p_user_ids || [];
      if (!worn || !ids.includes(UID)) return send(route, 200, "[]");
      return send(route, 200, [{ member_id: UID, ring_id: worn, ring_name: "Sakura" }]);
    }
    if (name === "theme_catalog") return send(route, 200, { collections: [], chosenWallpaperId: null, tier: "glow" });
    if (name === "member_wallpaper_state") return send(route, 200, { tierOk: true, limit: 5, chosenId: null, chosenPath: null, uploads: [] });
    return send(route, 200, "[]");
  }

  if (path.includes("/rest/v1/profile_ring_choices")) {
    const single = (req.headers()["accept"] || "").includes("pgrst.object");
    const row = worn ? { ring_id: worn } : null;
    if (single) return row ? send(route, 200, row) : send(route, 406, { code: "PGRST116", message: "no rows" });
    return send(route, 200, row ? [row] : [], { "content-range": `0-0/${row ? 1 : 0}` });
  }

  if (path.includes("/rest/v1/entitlement") || path.includes("/rest/v1/profile_entitlements")) {
    const row = [{ tier: "glow", accent: null }];
    return send(route, 200, row, { "content-range": "0-0/1" });
  }

  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

let bad = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  /* Settings: the Premium card and its ring controls are gone. */
  worn = "sakura";
  calls.payments.length = 0;
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.waitForSelector("#profile-form", { timeout: 20000 });
  await page.waitForTimeout(400);
  ok("Settings has no Premium profile card", (await page.locator("#premium-settings").count()) === 0);
  ok("Settings has no ring style or visibility control", (await page.locator("#ring-style, #ring-shown, #save-ring").count()) === 0);
  ok("Settings has no accent control", (await page.locator("#premium-accent, #save-accent").count()) === 0);

  /* The owner's own ring comes from the database. */
  await page.waitForFunction(() => document.querySelector("#account-avatar")?.hasAttribute("data-ring"), null, { timeout: 10000 }).catch(() => {});
  const avatar = await page.locator("#account-avatar").evaluate((el) => ({ ring: el.getAttribute("data-ring"), art: el.style.getPropertyValue("--ring-art") })).catch(() => null);
  ok("the owner's avatar wears the design the database returns", avatar?.ring === "sakura", JSON.stringify(avatar));
  ok("the avatar points at that design's artwork", (avatar?.art || "").includes("/assets/rings/sakura.png"), avatar?.art || "");

  /* Billing: the picker, the worn design, and the ₹10 payment. */
  await page.goto(`${BASE}/app/?view=billing`, { waitUntil: "load" });
  await page.waitForSelector("#ring-card", { timeout: 20000 });
  await page.waitForTimeout(300);
  const options = await page.locator("#ring-card .ring-option").count();
  ok("Billing lists the eight ring designs", options === 8, `count=${options}`);
  const current = await page.locator("#ring-card .ring-option[aria-current='true'] strong").textContent().catch(() => "");
  ok("the worn design is marked", current.trim() === "Sakura", `marked=${current.trim()}`);
  const prices = await page.locator("#ring-card [data-ring-apply]").allTextContents();
  ok("every design costs ₹10", prices.length === 8 && prices.every((t) => t.includes("₹10")), prices.join(" | "));
  const kuromi = await page.locator("#ring-card .ring-option-art[data-blend='screen']").count();
  ok("the Kuromi art blends with screen", kuromi === 1, `count=${kuromi}`);
  await page.locator("#ring-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/rings-billing-${vp.name}.png` });

  await page.locator("[data-ring-apply='tiger-gold']").click();
  await page.waitForTimeout(600);
  const sent = calls.payments.find((b) => b.purpose === "ring_apply:tiger-gold");
  ok("Apply sends a ring_apply:<id> payment", Boolean(sent), JSON.stringify(calls.payments));
  ok("the browser asks for the same ₹10 the server charges", sent?.amount === 1000, `amount=${sent?.amount}`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal overflow on Billing", overflow <= 1, `${overflow}px`);
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
