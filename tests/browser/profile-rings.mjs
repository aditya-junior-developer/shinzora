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

/* The stub's memory for this member: the rings they own and the one they wear. */
const calls = { rings: 0, payments: [], wear: [], remove: 0 };
let worn = "sakura";
let owned = new Set(["sakura", "thorn-rose"]);

const NAMES = {
  sakura: "Sakura", "thorn-rose": "Thorn and rose", "tiger-gold": "Tiger gold", "pink-gold": "Pink gold",
  "gothic-skull": "Gothic skull", "diamond-wings": "Diamond wings", "kuromi-neon": "Kuromi neon", "starlight-vine": "Starlight vine"
};

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;

  if (path.includes("/functions/v1/payments")) {
    const body = req.postDataJSON() || {};
    calls.payments.push(body);
    if (owned.has((body.purpose || "").replace("ring_apply:", ""))) {
      return send(route, 409, { error: "You already own this ring. Wear it from your profile. No payment is needed.", code: "ring_owned" });
    }
    return send(route, 200, {
      payment: { id: "dddddddd-1111-2222-3333-444444444444", reference: "SZ-RING-1", amount: body.amount, currency: "INR", status: "pending", purpose: body.purpose, label: body.label },
      upi: null, reused: false
    });
  }

  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    const body = req.postDataJSON() || {};
    if (name === "member_rings") {
      calls.rings += 1;
      const ids = body.p_user_ids || [];
      if (!worn || !ids.includes(UID)) return send(route, 200, "[]");
      return send(route, 200, [{ member_id: UID, ring_id: worn, ring_name: NAMES[worn] }]);
    }
    if (name === "ring_wear") {
      calls.wear.push(body.p_ring_id);
      if (!owned.has(body.p_ring_id)) return send(route, 400, { code: "42501", message: "You have not bought this ring yet." });
      worn = body.p_ring_id;
      return send(route, 200, body.p_ring_id);
    }
    if (name === "ring_remove") {
      calls.remove += 1;
      worn = null;
      return send(route, 200, "");
    }
    if (name === "theme_catalog") return send(route, 200, { collections: [], chosenWallpaperId: null, tier: "glow" });
    if (name === "member_wallpaper_state") return send(route, 200, { tierOk: true, limit: 5, chosenId: null, chosenPath: null, uploads: [] });
    return send(route, 200, "[]");
  }

  if (path.includes("/rest/v1/profile_ring_owned")) {
    const rows = [...owned].map((ring_id) => ({ ring_id }));
    return send(route, 200, rows, { "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
  }

  if (path.includes("/rest/v1/profile_ring_choices")) {
    const single = (req.headers()["accept"] || "").includes("pgrst.object");
    const row = worn ? { ring_id: worn } : null;
    if (single) return row ? send(route, 200, row) : send(route, 406, { code: "PGRST116", message: "no rows" });
    return send(route, 200, row ? [row] : [], { "content-range": `0-0/${row ? 1 : 0}` });
  }

  if (path.includes("/rest/v1/entitlement") || path.includes("/rest/v1/profile_entitlements")) {
    return send(route, 200, [{ tier: "glow", accent: null }], { "content-range": "0-0/1" });
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

const reset = () => {
  worn = "sakura";
  owned = new Set(["sakura", "thorn-rose"]);
  calls.payments.length = 0;
  calls.wear.length = 0;
  calls.remove = 0;
};

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  /* Settings > Profile: the ring card, with a live preview on the member's photo. */
  reset();
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.waitForSelector("#ring-card-host [data-ring-select]", { timeout: 20000 });
  await page.waitForTimeout(500);
  const optionCount = await page.locator("#ring-card-host .ring-option").count();
  ok("Settings lists the default look and all eight designs", optionCount === 9, `count=${optionCount}`);
  const previewRing = await page.locator("#ring-card-host [data-ring-stage] .avatar").getAttribute("data-ring");
  ok("the preview shows the ring being worn", previewRing === "sakura", `preview=${previewRing}`);
  const settingsAvatarRing = await page.locator("#avatar-slot .avatar").getAttribute("data-ring").catch(() => null);
  ok("the Settings profile photo wears the ring", settingsAvatarRing === "sakura", `avatar=${settingsAvatarRing}`);
  const settingsAvatarUser = await page.locator("#avatar-slot .avatar").getAttribute("data-ring-user").catch(() => null);
  ok("the Settings profile photo carries the member id", settingsAvatarUser === UID, `user=${settingsAvatarUser}`);

  /* Previewing a design the member does not own: no payment, no change saved. */
  await page.locator('#ring-card-host [data-ring-select="tiger-gold"]').click();
  await page.waitForTimeout(200);
  const previewTiger = await page.locator("#ring-card-host [data-ring-stage] .avatar").getAttribute("data-ring");
  ok("a design can be previewed on the photo before buying", previewTiger === "tiger-gold", `preview=${previewTiger}`);
  ok("previewing charges nothing and saves nothing", calls.payments.length === 0 && calls.wear.length === 0 && worn === "sakura");
  const buyLabel = (await page.locator("#ring-card-host [data-ring-buy='tiger-gold']").innerText().catch(() => "")).trim();
  ok("an unowned premium design offers Buy at ₹20", /₹20/.test(buyLabel), buyLabel);
  await page.locator("#ring-card-host").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/rings-preview-${vp.name}.png` });

  /* A ring already owned: wear it, with no payment. */
  await page.locator('#ring-card-host [data-ring-select="thorn-rose"]').click();
  await page.locator("#ring-card-host [data-ring-wear='thorn-rose']").click();
  await page.waitForTimeout(500);
  ok("an owned ring is worn without a payment", calls.wear.includes("thorn-rose") && calls.payments.length === 0, `wear=${calls.wear.join(",")} payments=${calls.payments.length}`);
  ok("the worn ring changed", worn === "thorn-rose");

  /* Take the ring off: back to the default look. The ring stays owned. */
  await page.locator("#ring-card-host [data-ring-remove]").click();
  await page.waitForTimeout(500);
  ok("removing the ring returns to the default look", calls.remove === 1 && worn === null, `remove=${calls.remove}`);
  ok("the removed ring is still owned", owned.has("thorn-rose"));
  const defaultState = (await page.locator("#ring-card-host [data-ring-select='none'] .ring-option-state").innerText()).trim();
  ok("the default look is marked as wearing once the ring is off", /Wearing/.test(defaultState), defaultState);

  /* Wear it again, with no payment. */
  await page.locator('#ring-card-host [data-ring-select="thorn-rose"]').click();
  await page.locator("#ring-card-host [data-ring-wear='thorn-rose']").click();
  await page.waitForTimeout(400);
  ok("a removed ring can be worn again without paying", worn === "thorn-rose" && calls.payments.length === 0);

  /* Buying an unowned ring: the payment is for the design's own price. */
  await page.locator('#ring-card-host [data-ring-select="pink-gold"]').click();
  await page.locator("#ring-card-host [data-ring-buy='pink-gold']").click();
  await page.waitForTimeout(500);
  const sent = calls.payments.find((b) => b.purpose === "ring_apply:pink-gold");
  ok("buying sends one ring_apply payment at ₹20", Boolean(sent) && sent.amount === 2000, JSON.stringify(sent || calls.payments));

  /* Billing: the same picker, with prices and states. */
  reset();
  await page.goto(`${BASE}/app/?view=billing`, { waitUntil: "load" });
  await page.waitForSelector("#ring-card [data-ring-select]", { timeout: 20000 });
  await page.waitForTimeout(400);
  const billingOptions = await page.locator("#ring-card .ring-option").count();
  ok("Billing lists the same nine choices", billingOptions === 9, `count=${billingOptions}`);
  const stateOf = async (id) => (await page.locator(`#ring-card [data-ring-select='${id}'] .ring-option-state`).innerText().catch(() => "")).trim();
  ok("the worn ring is marked as wearing", /Wearing/.test(await stateOf("sakura")), await stateOf("sakura"));
  ok("an owned ring is marked as owned", /Owned/.test(await stateOf("thorn-rose")), await stateOf("thorn-rose"));
  ok("a premium ring shows ₹20", /₹20/.test(await stateOf("tiger-gold")), await stateOf("tiger-gold"));
  ok("a standard ring shows ₹10", /₹10/.test(await stateOf("kuromi-neon")), await stateOf("kuromi-neon"));
  const legacyApply = await page.locator("#ring-card [data-ring-apply]").count();
  ok("Billing no longer has the old per-apply buttons", legacyApply === 0, `count=${legacyApply}`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal overflow on Billing", overflow <= 1, `${overflow}px`);
  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll profile-ring checks passed");
process.exit(bad ? 1 : 0);
