/* ==========================================================================
   Shinzora — browser harness: ring style and visibility (R8)
   --------------------------------------------------------------------------
     - a free member has no ring controls, and no ring settings are requested
     - a Glow member sees style and visibility, with the stored values
     - Elite sees the same controls plus the accent
     - saving "still" and "hidden" calls ring_prefs_set and changes their own ring
     - no horizontal overflow and no page errors at 390 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/ring-management.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-r8";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: {} }
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
let tier = "glow";
let accent = null;
let prefs = { animated: true, shown: true };
const calls = { prefsGets: 0, prefsSets: [] };

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;

  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    const body = req.postDataJSON() || {};
    if (name === "ring_prefs_get") {
      calls.prefsGets += 1;
      return send(route, 200, { tier: tier === "free" ? null : tier, tierOk: tier !== "free", animated: prefs.animated, shown: prefs.shown });
    }
    if (name === "ring_prefs_set") {
      calls.prefsSets.push({ animated: body.p_animated, shown: body.p_shown });
      prefs = { animated: body.p_animated, shown: body.p_shown };
      return send(route, 200, { ok: true, animated: prefs.animated, shown: prefs.shown });
    }
    if (name === "member_rings") {
      const ids = body.p_user_ids || [];
      if (tier === "free" || !ids.includes(UID)) return send(route, 200, "[]");
      return send(route, 200, [{ member_id: UID, ring_tier: tier, ring_accent: tier === "elite" ? accent : null, ring_animated: prefs.animated }]);
    }
    if (name === "theme_catalog") return send(route, 200, { collections: [], chosenWallpaperId: null, tier: tier === "free" ? null : tier });
    if (name === "member_wallpaper_state") return send(route, 200, { tierOk: tier !== "free", limit: 5, chosenId: null, chosenPath: null, uploads: [] });
    return send(route, 200, "[]");
  }

  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (path.includes("/rest/v1/entitlement") || path.includes("/rest/v1/profile_entitlements")) {
    const row = tier === "free" ? [] : [{ tier, accent: tier === "elite" ? accent : null }];
    return send(route, 200, row, { "content-range": `0-${Math.max(0, row.length - 1)}/${row.length}` });
  }
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

let bad = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};
const reset = (mode) => {
  tier = mode;
  accent = mode === "elite" ? "teal" : null;
  prefs = { animated: true, shown: true };
  calls.prefsGets = 0;
  calls.prefsSets.length = 0;
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

async function open(page) {
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.waitForSelector("#profile-form", { timeout: 20000 });
  await page.waitForTimeout(400);
}

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  /* A free member: no controls, no request. */
  reset("free");
  await open(page);
  await page.waitForTimeout(400);
  ok("a free member has no ring style control", (await page.locator("#ring-style").count()) === 0);
  ok("a free member has no ring visibility control", (await page.locator("#ring-shown").count()) === 0);
  ok("a free member does not request ring settings", calls.prefsGets === 0, `gets=${calls.prefsGets}`);

  /* A Glow member: style and visibility, stored values shown. */
  reset("glow");
  prefs = { animated: false, shown: true };
  await open(page);
  await page.waitForSelector("#ring-style", { timeout: 10000 });
  ok("a Glow member sees the ring style", (await page.locator("#ring-style").count()) === 1);
  ok("the stored still style is selected", (await page.locator("#ring-style").inputValue()) === "still");
  ok("the stored visibility is shown", (await page.locator("#ring-shown").isChecked()) === true);
  ok("a Glow member has no accent control", (await page.locator("#premium-accent").count()) === 0);
  await page.locator("#premium-settings").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/ring-glow-${vp.name}.png` });

  /* Save still and hidden. */
  await page.locator("#ring-style").selectOption("still");
  await page.locator("#ring-shown").uncheck();
  await page.locator("#save-ring").click();
  await page.waitForTimeout(600);
  const set = calls.prefsSets.at(-1);
  ok("saving sends still and hidden to ring_prefs_set", set && set.animated === false && set.shown === false, JSON.stringify(set));
  const selfRing = await page.locator("#account-avatar").getAttribute("data-animated");
  ok("the owner's own ring shows as still", selfRing === "false", `data-animated=${selfRing}`);
  ok("the owner's own ring still has its tier", (await page.locator("#account-avatar").getAttribute("data-tier")) === "glow");

  /* Elite: the same controls and the accent. */
  reset("elite");
  await open(page);
  await page.waitForSelector("#ring-style", { timeout: 10000 });
  ok("an Elite member sees the ring style", (await page.locator("#ring-style").count()) === 1);
  ok("an Elite member sees the accent control", (await page.locator("#premium-accent").count()) === 1);
  ok("an Elite ring animates by default", (await page.locator("#account-avatar").getAttribute("data-animated")) === "true");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal overflow", overflow <= 1, `${overflow}px`);
  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} failed` : "\nall passed");
process.exit(bad ? 1 : 0);
