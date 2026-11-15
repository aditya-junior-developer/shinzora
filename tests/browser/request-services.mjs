/* ==========================================================================
   Shinzora — browser harness: Request Services (P7)
   --------------------------------------------------------------------------
   Drives the real customer page with the network stubbed (same approach as
   shell.mjs). Checks what the browser sends, and when the confirmation shows:
     - the form starts empty, with no confirmation and no "Others" field
     - "Others" reveals the description field; other categories hide it
     - invalid input is refused in place, and nothing is sent
     - a valid submission sends status 'submitted', the category, the budget in
       rupees and the contact details, and never an amount or assignee
     - the confirmation text appears only after the save succeeds
     - a refused save shows the error and no confirmation
     - the page is usable on a phone width, with no horizontal scroll

     BASE=http://127.0.0.1:4173 node tests/browser/request-services.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-p7";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Harness User" }, app_metadata: { provider: "email" } }
};

const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", phone: "+91 90000 00000", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", category: "Design studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active", billing_cycle: "monthly" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

/* What the app asked the service_requests table to do, in order. */
const writes = [];
let requests = [];
let refuseNext = false;
let counter = 0;

async function stubSupabase(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;

  if (path.includes("/rest/v1/service_requests")) {
    if (req.method() === "POST") {
      writes.push({ method: "POST", body: JSON.parse(req.postData() || "{}") });
      if (refuseNext) {
        refuseNext = false;
        return send(route, 403, { code: "42501", message: "new row violates row-level security policy for table \"service_requests\"", details: null, hint: null });
      }
      counter += 1;
      const b = writes[writes.length - 1].body;
      const row = {
        id: `00000000-0000-4000-8000-00000000000${counter}`,
        reference: `SR-TEST00${String(counter).padStart(2, "0")}`,
        owner_id: UID, service_type: b.service_type, title: b.title, details: b.details ?? null,
        custom_description: b.custom_description ?? null, budget_inr: b.budget_inr ?? null,
        contact_name: b.contact_name ?? null, contact_email: b.contact_email ?? null, contact_phone: b.contact_phone ?? null,
        status: b.status, amount: 0, admin_note: null, assigned_to: null,
        created_at: new Date().toISOString(), respond_by: new Date(Date.now() + 86400000).toISOString()
      };
      requests = [row, ...requests];
      const wantsRow = /return=representation/.test(req.headers()["prefer"] || "") || url.searchParams.has("select");
      return send(route, 201, wantsRow ? [row] : [], { "content-range": "*/*" });
    }
    if (req.method() === "GET") return send(route, 200, requests, { "content-range": `0-${Math.max(0, requests.length - 1)}/${requests.length}` });
  }

  if (path.includes("/rest/v1/rpc/")) return send(route, 200, "false");
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": "0-0/1" });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "edge function not deployed in this environment" });
}

let bad = 0;
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((session) => {
    try { localStorage.setItem("shinzora.auth", JSON.stringify(session)); } catch { /* sandboxed frame */ }
  }, SESSION);
  await ctx.route("**://*.supabase.co/**", stubSupabase);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/app/?view=requests`, { waitUntil: "networkidle" });
  await page.waitForSelector("#svc-form", { timeout: 15000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

console.log("desktop");
{
  writes.length = 0;
  requests = [];
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });

  ok("the page shows ten service tiles", (await page.locator(".svc-tile").count()) === 10);
  ok("the tiles use the agreed labels", (await page.locator(".svc-tile-title").allInnerTexts()).join("|").includes("Export to Other Countries"));
  ok("no confirmation shows before a submit", await page.locator("#svc-confirm").isHidden());
  ok("the Others field is hidden until Others is chosen", await page.locator("#svc-others").isHidden());
  ok("the name is pre-filled from the account", (await page.inputValue("#svc-name")) === "Harness User");
  await page.screenshot({ path: `${SHOTS}/requests-desktop-empty.png`, fullPage: false });

  /* Refuse an empty submit: nothing is sent. */
  await page.click("#svc-submit");
  await page.waitForTimeout(200);
  ok("an empty submit sends nothing", writes.length === 0);
  ok("an empty submit names the missing service", /Choose one service/.test(await page.textContent('[data-error="category"]')));

  /* Others reveals the description and refuses a short one. */
  await page.click('label[data-tile="others"]');
  await page.waitForTimeout(150);
  ok("choosing Others reveals the description", await page.locator("#svc-others").isVisible());
  await page.fill("#svc-budget", "5000");
  await page.fill("#svc-description", "too short");
  await page.click("#svc-submit");
  await page.waitForTimeout(200);
  ok("a short Others description is refused in place", /at least 10 characters/.test(await page.textContent('[data-field="description"] .field-error')));
  ok("a short description sends nothing", writes.length === 0);

  /* Bad budget. */
  await page.click('label[data-tile="meta_ads"]');
  await page.fill("#svc-budget", "0");
  await page.click("#svc-submit");
  await page.waitForTimeout(200);
  ok("a zero budget is refused", /Enter your expected budget/.test(await page.textContent('[data-field="budget"] .field-error')));
  ok("the Others field hides again for Meta Ads", await page.locator("#svc-others").isHidden());

  /* Refused save: error, no confirmation. */
  refuseNext = true;
  await page.fill("#svc-budget", "12,500");
  await page.click("#svc-submit");
  await page.waitForTimeout(800);
  ok("a refused save sends one request", writes.length === 1, String(writes.length));
  ok("a refused save shows no confirmation", await page.locator("#svc-confirm").isHidden());
  ok("a refused save shows an error toast", (await page.locator(".toast, [role=alert]").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/requests-desktop-refused.png`, fullPage: false });

  /* Valid save: payload, confirmation, list. */
  await page.fill("#svc-budget", "12,500");
  await page.click("#svc-submit");
  await page.waitForTimeout(900);
  const last = writes[writes.length - 1]?.body || {};
  ok("a valid save sends a second request", writes.length === 2, String(writes.length));
  ok("the payload status is 'submitted'", last.status === "submitted", last.status);
  ok("the payload category is Meta Ads", last.service_type === "meta_ads", last.service_type);
  ok("the budget is sent as a number of rupees", last.budget_inr === 12500, String(last.budget_inr));
  ok("no custom description is sent for a standard category", last.custom_description === null);
  ok("the contact details are sent", last.contact_email === "harness@example.com" && last.contact_name === "Harness User");
  ok("no amount, payment or assignee is sent", !("amount" in last) && !("payment_id" in last) && !("assigned_to" in last) && !("admin_note" in last));
  const confirm = (await page.textContent("#svc-confirm")).replace(/\s+/g, " ").trim();
  ok("the confirmation shows the agreed wording", confirm === "Thank you for submitting your request! Our team or a dedicated specialist will connect with you within 24 hours to discuss your requirements and budget.", confirm.slice(0, 80));
  ok("the new request appears in the list", (await page.locator(".request-card").count()) === 1);
  ok("the new request shows the Submitted step", /Submitted/.test(await page.textContent(".request-card .badge.badge-info")));
  const openValue = await page.textContent("#svc-stats .stat:first-child .stat-value");
  ok("the Open count includes the new request", openValue.trim() === "1", `shows ${openValue.trim()}`);
  ok("the form is cleared after a save", (await page.inputValue("#svc-budget")) === "" && (await page.locator('input[name="service"]:checked').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/requests-desktop-submitted.png`, fullPage: true });
  await page.screenshot({ path: `${SHOTS}/requests-desktop-viewport.png`, fullPage: false });

  /* Others with a valid description sends the text. */
  await page.click('label[data-tile="others"]');
  await page.fill("#svc-budget", "9000");
  await page.fill("#svc-description", "Printed sleeves for 300 cups for a café launch.");
  await page.click("#svc-submit");
  await page.waitForTimeout(900);
  const other = writes[writes.length - 1]?.body || {};
  ok("Others sends its description", other.service_type === "others" && other.custom_description?.startsWith("Printed sleeves"));

  ok("no page errors on desktop", errors.length === 0, errors[0]?.slice(0, 120));
  await ctx.close();
}

console.log("phone");
{
  writes.length = 0;
  requests = [];
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal scroll at 390px", overflow <= 1, `overflow ${overflow}px`);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".svc-grid")).gridTemplateColumns.split(" ").length);
  ok("tiles stack to a single column on a phone", cols === 1, `${cols} column(s)`);
  await page.screenshot({ path: `${SHOTS}/requests-phone.png`, fullPage: true });
  ok("no page errors on a phone", errors.length === 0, errors[0]?.slice(0, 120));
  await ctx.close();
}

await browser.close();
console.log(`\n${bad ? `${bad} failed` : "all passed"}`);
process.exit(bad ? 1 : 0);
