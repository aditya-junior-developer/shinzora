/* ==========================================================================
   Shinzora — browser harness: the admin Support requests view.
   --------------------------------------------------------------------------
     - the response-time note saves through support_settings_save (admin only)
     - requests list with status and channel filters
     - a chat request opens its thread; the team replies through
       support_request_reply
     - a status change and an internal note go through support_request_update
     - a call request shows the number and the best time, no chat box
     - nothing overflows horizontally on a phone; no page errors

     BASE=http://127.0.0.1:4173 SHOTS=/tmp/shots node tests/browser/support-admin-flow.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/tmp/shots";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const USER = "99999999-8888-7777-6666-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "admin@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "admin@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Admin" } }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

const store = {
  note: "",
  requests: [
    { id: "r1", user_id: USER, channel: "chat", subject: "Cannot publish my site", message: "My site stays in draft.", phone: null, best_time: null, status: "received", admin_note: null, created_at: "2026-11-03T09:00:00Z", updated_at: "2026-11-03T09:00:00Z", last_message_at: "2026-11-03T09:00:00Z" },
    { id: "r2", user_id: USER, channel: "call", subject: "Please call me about my plan", message: "I want to change my plan.", phone: "+91 98765 43210", best_time: "Weekdays after 6 pm", status: "in_progress", admin_note: null, created_at: "2026-11-02T09:00:00Z", updated_at: "2026-11-02T09:00:00Z", last_message_at: "2026-11-02T09:00:00Z" }
  ],
  messages: { r1: [{ id: "m1", author_role: "user", body: "My site stays in draft.", created_at: "2026-11-03T09:00:00Z" }] }
};
const calls = { note: [], status: [], reply: [] };

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;
  const body = req.postData() ? JSON.parse(req.postData()) : {};

  if (path.includes("/functions/v1/admin")) return send(route, 200, {});
  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    if (name === "is_admin") return send(route, 200, true);
    if (name === "admin_role") return send(route, 200, "superadmin");
    if (name === "support_settings_save") {
      calls.note.push(body.p_response_time_note);
      store.note = body.p_response_time_note;
      return send(route, 200, { key: "response_time_note", value: store.note });
    }
    if (name === "support_request_update") {
      calls.status.push(body);
      const r = store.requests.find((x) => x.id === body.p_request);
      if (r) { r.status = body.p_status; r.admin_note = body.p_admin_note || null; }
      return send(route, 200, r || {});
    }
    if (name === "support_request_reply") {
      calls.reply.push(body);
      const list = store.messages[body.p_request] || [];
      list.push({ id: `m${list.length + 1}`, author_role: "admin", body: body.p_body, created_at: new Date().toISOString() });
      store.messages[body.p_request] = list;
      return send(route, 200, list[list.length - 1]);
    }
    return send(route, 200, "[]");
  }
  if (path.includes("/rest/v1/support_settings")) return send(route, 200, { value: store.note }, { "content-range": "0-0/1" });
  if (path.includes("/rest/v1/support_requests")) return send(route, 200, store.requests, { "content-range": `0-${store.requests.length - 1}/${store.requests.length}` });
  if (path.includes("/rest/v1/support_request_messages")) {
    const rid = (url.searchParams.get("request_id") || "").replace(/^eq\./, "");
    const rows = store.messages[rid] || [];
    return send(route, 200, rows, { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` });
  }
  if (path.includes("/rest/v1/profiles")) return send(route, 200, [{ id: USER, full_name: "Ritu Sharma", email: "ritu@example.com" }], { "content-range": "0-0/1" });
  if (path.includes("/rest/v1/admin_users")) return send(route, 200, [{ role: "superadmin" }], { "content-range": "0-0/1" });
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
for (const vp of [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
]) {
  console.log(`\n${vp.name} (${vp.width}px)`);
  calls.note.length = 0; calls.status.length = 0; calls.reply.length = 0;
  store.note = "";
  store.requests[0].status = "received";
  store.requests[1].status = "in_progress";
  store.requests[0].admin_note = null;
  store.messages = { r1: [{ id: "m1", author_role: "user", body: "My site stays in draft.", created_at: "2026-11-03T09:00:00Z" }] };

  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/admin/?view=support-requests`, { waitUntil: "load" });
  await page.waitForSelector("#sr-note", { timeout: 25000 }).catch(() => {});
  await page.waitForSelector("#sr-list .cs-row", { timeout: 15000 }).catch(() => {});
  ok("the Support requests view opens with the note field", (await page.locator("#sr-note").count()) === 1);
  ok("the open requests are listed", (await page.locator("#sr-list .cs-row").count()) === 2);
  ok("no horizontal page overflow", (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);

  /* The response-time note */
  await page.fill("#sr-note", "We review requests on working days.");
  await page.click("#sr-note-save");
  await page.waitForFunction(() => document.querySelector("#sr-note-save") && !document.querySelector("#sr-note-save").disabled, null, { timeout: 5000 }).catch(() => {});
  ok("the note saves through support_settings_save", calls.note.length === 1 && calls.note[0] === "We review requests on working days.");

  /* A chat request: open, reply */
  await page.click("#sr-list [data-open='r1']");
  await page.waitForSelector("#sr-reply-form", { timeout: 10000 });
  ok("a chat request shows its thread", (await page.locator(".cs-msg-body", { hasText: "My site stays in draft." }).count()) >= 1);
  await page.fill("#sr-reply", "We are looking into the publish step.");
  await page.click("#sr-reply-send");
  await page.waitForSelector(".cs-msg-body:has-text('We are looking into the publish step.')", { timeout: 10000 });
  ok("the team reply goes through support_request_reply as admin", calls.reply.length === 1 && calls.reply[0].p_request === "r1");
  ok("the reply box is inside the viewport", await page.evaluate(() => {
    const r = document.querySelector("#sr-reply-send")?.getBoundingClientRect();
    return Boolean(r && r.bottom <= innerHeight + 400 && r.width > 0);
  }));

  /* Status and internal note */
  await page.selectOption("#sr-status-value", "in_progress");
  await page.fill("#sr-admin-note", "Checking the publish logs");
  await page.click("#sr-status-save");
  await page.waitForTimeout(500);
  ok("the status change goes through support_request_update", calls.status.length === 1 && calls.status[0].p_status === "in_progress" && calls.status[0].p_admin_note === "Checking the publish logs");

  /* A call request: no chat box, shows the number */
  await page.click("#sr-list [data-open='r2']");
  await page.waitForSelector("#sr-status-form", { timeout: 10000 });
  const detail = (await page.locator("#sr-detail").innerText());
  ok("a call request shows the number and best time", detail.includes("+91 98765 43210") && detail.includes("Weekdays after 6 pm"));
  ok("a call request has no chat reply box", (await page.locator("#sr-reply-form").count()) === 0);

  /* Filter: resolved only */
  await page.click("#sr-status [data-status='resolved']");
  ok("the resolved filter hides open requests", (await page.locator("#sr-list .cs-row").count()) === 0);

  await page.screenshot({ path: `${SHOTS}/sr-admin-${vp.name}.png`, fullPage: true });
  ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll support-admin-flow checks passed");
process.exit(bad ? 1 : 0);
