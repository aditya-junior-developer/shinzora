/* ==========================================================================
   Shinzora — browser harness: Customer Support for Shinzora users.
   --------------------------------------------------------------------------
     - the first screen offers "Talk to AI" and "Talk to a Human Representative"
     - Talk to AI: a question gets an answer from the support assistant
       (its own endpoint), and an unresolved answer offers a human
     - Talk to a Human: "Via Chat" and "Via Call" both submit a real request, and
       the confirmation shows the exact text
     - "My requests" lists the request with its status; a chat thread takes a reply
     - nothing overflows horizontally, and no page errors occur

     Runs at 390, 820 and 1440 px. The database is stubbed in memory, so this
     checks the screens and the request payloads; the RPCs themselves are tested
     in tests/support-requests-db.test.mjs.

     BASE=http://127.0.0.1:4173 SHOTS=/tmp/shots node tests/browser/customer-support-flow.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/tmp/shots";
mkdirSync(SHOTS, { recursive: true });

const RECEIVED =
  "Your support request has been received! Our human support representative will connect with you as soon as possible and help resolve your issue.";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Harness User" } }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};

/* In-memory support store, shaped like the real tables and RPCs. */
const store = { requests: [], messages: new Map(), ai: [], note: "" };
const calls = { create: 0, reply: 0, aiAsk: 0, lastCreate: null };

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;
  const body = req.postData() ? JSON.parse(req.postData()) : {};

  if (path.includes("/functions/v1/support-ai")) {
    calls.aiAsk += 1;
    const reply = `Open Groups from the sidebar, then use "New" to create a group. (stub reply ${calls.aiAsk})`;
    store.ai.push({ id: `a${store.ai.length + 1}`, role: "user", body: body.message, created_at: new Date().toISOString() });
    store.ai.push({ id: `a${store.ai.length + 1}`, role: "assistant", body: reply, created_at: new Date().toISOString() });
    return send(route, 200, { reply });
  }

  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    if (name === "support_request_create") {
      calls.create += 1;
      calls.lastCreate = body;
      const id = `r${store.requests.length + 1}`;
      const row = {
        id, user_id: UID, channel: body.p_channel, subject: body.p_subject, message: body.p_message,
        phone: body.p_phone || null, best_time: body.p_best_time || null, status: "received", admin_note: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_message_at: new Date().toISOString()
      };
      store.requests.unshift(row);
      if (row.channel === "chat") store.messages.set(id, [{ id: `${id}-m1`, author_role: "user", body: row.message, created_at: row.created_at }]);
      return send(route, 200, row);
    }
    if (name === "support_request_reply") {
      calls.reply += 1;
      const list = store.messages.get(body.p_request) || [];
      const row = { id: `${body.p_request}-m${list.length + 1}`, author_role: "user", body: body.p_body, created_at: new Date().toISOString() };
      list.push(row);
      store.messages.set(body.p_request, list);
      return send(route, 200, row);
    }
    return send(route, 200, "[]");
  }

  if (path.includes("/rest/v1/support_requests")) return send(route, 200, store.requests, { "content-range": `0-${Math.max(0, store.requests.length - 1)}/${store.requests.length}` });
  if (path.includes("/rest/v1/support_request_messages")) {
    const rid = (url.searchParams.get("request_id") || "").replace(/^eq\./, "");
    const rows = store.messages.get(rid) || [];
    return send(route, 200, rows, { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` });
  }
  if (path.includes("/rest/v1/support_ai_messages")) return send(route, 200, store.ai, { "content-range": `0-${Math.max(0, store.ai.length - 1)}/${store.ai.length}` });
  if (path.includes("/rest/v1/support_settings")) {
    if (url.searchParams.get("key") === "eq.response_time_note" || path.includes("support_settings")) {
      return send(route, 200, { value: store.note }, { "content-range": "0-0/1" });
    }
  }
  const table = Object.keys(ROWS).find((n) => path.includes(`/rest/v1/${n}`));
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
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name} (${vp.width}px)`);
  store.requests.length = 0;
  store.messages.clear();
  store.ai.length = 0;
  store.note = "";
  calls.create = 0; calls.reply = 0; calls.aiAsk = 0; calls.lastCreate = null;

  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${BASE}/app/?view=support`, { waitUntil: "load" });
  await page.waitForSelector("#cs-to-ai", { timeout: 20000 });
  await page.waitForTimeout(400);

  const inViewport = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1;
  }, sel);

  ok("the first screen offers Talk to AI", (await page.locator("#cs-to-ai").innerText()).includes("Talk to AI"));
  ok("the first screen offers Talk to a Human Representative", (await page.locator("#cs-to-human").innerText()).includes("Talk to a Human Representative"));
  ok("both choices are inside the viewport", (await inViewport("#cs-to-ai")) === true && (await inViewport("#cs-to-human")) === true);
  ok("no horizontal page overflow", (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
  await page.screenshot({ path: `${SHOTS}/cs-${vp.name}-home.png`, fullPage: true });

  /* Talk to AI */
  await page.click("#cs-to-ai");
  await page.waitForSelector("#cs-ai-input", { timeout: 10000 });
  await page.fill("#cs-ai-input", "How do I create a group?");
  await page.click("#cs-ai-send");
  await page.waitForSelector(".cs-msg.is-bot:has-text('stub reply')", { timeout: 10000 });
  ok("a question gets an answer from the support assistant", calls.aiAsk === 1);
  ok("the answer offers a human when it does not solve the problem", (await page.locator("[data-escalate]").count()) >= 1);
  ok("the AI screen is inside the viewport", (await inViewport("#cs-ai-input")) === true && (await inViewport("#cs-ai-send")) === true);
  await page.screenshot({ path: `${SHOTS}/cs-${vp.name}-ai.png`, fullPage: true });

  /* Human: Via Chat */
  await page.click("[data-escalate]");
  await page.waitForSelector("#cs-via-chat", { timeout: 10000 });
  ok("Talk to a human offers Via Call and Via Chat", (await page.locator("#cs-via-call").count()) === 1 && (await page.locator("#cs-via-chat").count()) === 1);
  await page.click("#cs-via-chat");
  await page.waitForSelector("#cs-form", { timeout: 10000 });
  await page.fill("#cs-form [name=subject]", "Cannot publish my site");
  await page.fill("#cs-form [name=message]", "My site stays in draft after Publish.");
  await page.click("#cs-submit");
  await page.waitForSelector("#cs-received-text", { timeout: 10000 });
  const text = (await page.locator("#cs-received-text").innerText()).trim();
  ok("a chat request is submitted to the store", calls.create === 1 && calls.lastCreate?.p_channel === "chat", JSON.stringify({ create: calls.create }));
  ok("the confirmation shows the exact text", text === RECEIVED, `"${text.slice(0, 60)}…"`);
  ok("no response time is promised when the team has not set one", (await page.locator(".cs-received-note").count()) === 0);
  ok("the confirmation is inside the viewport", (await inViewport("#cs-received-text")) === true);
  await page.screenshot({ path: `${SHOTS}/cs-${vp.name}-received.png`, fullPage: true });

  /* My requests: status, then a reply in the chat thread */
  await page.click("#cs-see-requests");
  await page.waitForSelector(".cs-row", { timeout: 10000 });
  const row = (await page.locator(".cs-row").first().innerText());
  ok("My requests lists the request with its status", row.includes("Cannot publish my site") && row.includes("Received"), row.replace(/\s+/g, " ").slice(0, 80));
  await page.click(".cs-row");
  await page.waitForSelector("#cs-reply-form", { timeout: 10000 });
  ok("the chat thread shows the first message", (await page.locator(".cs-msg-body", { hasText: "My site stays in draft" }).count()) >= 1);
  await page.fill("#cs-reply", "Here is the error I see.");
  await page.click("#cs-reply-send");
  await page.waitForSelector(".cs-msg-body:has-text('Here is the error I see.')", { timeout: 10000 });
  ok("a reply is sent in the thread", calls.reply === 1);
  ok("the reply box is inside the viewport", (await inViewport("#cs-reply")) === true && (await inViewport("#cs-reply-send")) === true);
  await page.screenshot({ path: `${SHOTS}/cs-${vp.name}-thread.png`, fullPage: true });

  /* Talk to a human: Via Call. The team's note is set first, so it must appear
     under the confirmation (and nothing else is promised). */
  store.note = "We review requests on working days.";
  await page.click(".cs-back");
  await page.waitForSelector("#cs-tabs", { timeout: 5000 });
  await page.click("#cs-tabs [data-tab=help]");
  await page.waitForSelector("#cs-to-human", { timeout: 5000 });
  await page.click("#cs-to-human");
  await page.waitForSelector("#cs-via-call", { timeout: 5000 });
  await page.click("#cs-via-call");
  await page.waitForSelector("#cs-form [name=phone]", { timeout: 5000 });
  await page.fill("#cs-form [name=subject]", "Please call me about my plan");
  await page.fill("#cs-form [name=message]", "I want to change my plan.");
  await page.fill("#cs-form [name=phone]", "+91 98765 43210");
  await page.fill("#cs-form [name=best_time]", "Weekdays after 6 pm");
  await page.click("#cs-submit");
  await page.waitForSelector("#cs-received-text", { timeout: 10000 });
  ok("a call request is submitted with the phone and best time", calls.create === 2 && calls.lastCreate?.p_channel === "call" && calls.lastCreate?.p_phone === "+91 98765 43210" && calls.lastCreate?.p_best_time === "Weekdays after 6 pm");
  ok("the call confirmation shows the exact text", (await page.locator("#cs-received-text").innerText()).trim() === RECEIVED);
  ok("the team's own note is shown under the confirmation", (await page.locator(".cs-received-note").innerText()).includes("We review requests on working days."));

  ok("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll customer-support-flow checks passed");
process.exit(bad ? 1 : 0);
