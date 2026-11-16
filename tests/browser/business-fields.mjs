/* ==========================================================================
   Shinzora — browser harness: AI profile fields in Settings (brief item 8)
   --------------------------------------------------------------------------
     - ticking fields shows the count, the running total and the pay button
     - Pay sends only the ticked keys; no amount is sent from the browser
     - already-active fields are shown as active and cannot be ticked again
     - no horizontal overflow at 390 and 1440 px, and no page errors

     BASE=http://127.0.0.1:4173 node tests/browser/business-fields.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-p12";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const BIZ = "aaaaaaaa-1111-2222-3333-444444444444";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Harness User" } }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", phone: "+91 90000 00000", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: BIZ, owner_id: UID, name: "Harness Studio", category: "Design studio", location: "Faridabad", description: "Studio", email: "hi@example.com", ai_fields: ["location"], created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active", billing_cycle: "monthly" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};

const payCalls = [];
async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;
  if (path.includes("/functions/v1/payments")) {
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch { /* none */ }
    payCalls.push(body);
    return send(route, 200, {
      reused: false,
      payment: { id: "pay-1", reference: "SZ-BIZFIELDS", amount: 2000, status: "pending", purpose: "business_fields", label: "Business profile fields" },
      upi: { configured: true, upi_id: "shinzora@upi", payee_name: "Shinzora", intent: "upi://pay?pa=shinzora@upi", amount_rupees: 20 },
      razorpay: { configured: false }
    });
  }
  if (path.includes("/rpc/")) return send(route, 200, "[]");
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": "0-0/1" });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

let bad = 0;
const ok = (name, pass, note = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`); if (!pass) bad++; };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 800, isMobile: viewport.width < 800 });
  await ctx.addInitScript((session) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(session)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.waitForSelector('[data-section="business"]', { timeout: 20000 });
  await page.click('[data-section="business"]');
  await page.waitForSelector("#ai-fields", { timeout: 10000 });
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

console.log("1. Settings → Business → AI profile fields (desktop, 1440px)");
{
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  await page.locator("#ai-fields").scrollIntoViewIfNeeded();

  ok("the granted field shows as active and is ticked", await page.locator('input[name="ai-field"][value="location"]').isChecked() && await page.locator('input[name="ai-field"][value="location"]').isDisabled());
  ok("the pay button is off until a new field is ticked", await page.locator("#ai-fields-pay").isDisabled());

  await page.check('input[name="ai-field"][value="name"]');
  await page.check('input[name="ai-field"][value="email"]');
  ok("ticked count follows the ticks", (await page.textContent("#ai-fields-count")).trim() === "2");
  ok("running total is ticked count × ₹10", (await page.textContent("#ai-fields-total")).trim() === "₹20");
  ok("the amount to pay matches the total", (await page.textContent("#ai-fields-due")).trim() === "₹20");
  ok("the button states the amount and count", (await page.textContent("#ai-fields-pay")).includes("Pay ₹20 for 2 fields"));
  await page.locator("#ai-fields").screenshot({ path: `${SHOTS}/ai-fields-desktop.png` });

  await page.click("#ai-fields-pay");
  await page.waitForTimeout(800);
  const sent = payCalls[payCalls.length - 1] || {};
  ok("pay sends the purpose and the ticked keys only", sent.purpose === "business_fields" && JSON.stringify([...sent.fields].sort()) === JSON.stringify(["email", "name"]), JSON.stringify(sent));
  ok("pay sends no amount from the browser", !("amount" in sent) && !("price" in sent) && !("total" in sent), JSON.stringify(sent));

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal overflow at 1440 px", overflow <= 1, `overflow ${overflow}px`);
  ok("no page errors at 1440 px", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

console.log("2. phone (390px)");
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await page.locator("#ai-fields").scrollIntoViewIfNeeded();
  await page.check('input[name="ai-field"][value="phone"]');
  ok("phone: the total updates", (await page.textContent("#ai-fields-total")).trim() === "₹10");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("phone: no horizontal overflow", overflow <= 1, `overflow ${overflow}px`);
  await page.locator("#ai-fields").screenshot({ path: `${SHOTS}/ai-fields-phone.png` });
  ok("phone: no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll business-field checks passed");
process.exit(bad ? 1 : 0);
