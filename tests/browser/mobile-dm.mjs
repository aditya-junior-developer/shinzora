/* ==========================================================================
   Shinzora — browser harness: mobile direct messages (brief 4)
   --------------------------------------------------------------------------
   Phone (390px): the conversation list fills the screen. Opening one hides the
   list and shows only that conversation, with a back arrow. The arrow, and the
   phone's back gesture, return to the full list with its rows still there and
   the view not rebuilt. Desktop keeps both panes and adds no history entries.

     BASE=http://127.0.0.1:4173 node tests/browser/mobile-dm.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-p12";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: { full_name: "Harness User" } }
};
const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", phone: "+91 90000 00000", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", category: "Design studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active", billing_cycle: "monthly" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

const INBOX = [
  { conversationId: "c-priya", kind: "personal", title: "Priya", unread: 2, lastMessage: "See you at 5", lastMessageAt: new Date(Date.now() - 600000).toISOString(), peer: { username: "priya", lastSeenAt: null } },
  { conversationId: "c-rahul", kind: "personal", title: "Rahul", unread: 0, lastMessage: "Thanks!", lastMessageAt: new Date(Date.now() - 3600000).toISOString(), peer: { username: "rahul", lastSeenAt: null } }
];
const THREADS = {
  "c-priya": { kind: "personal", participants: [{ userId: UID, name: "Harness User" }, { userId: "u-priya", name: "Priya", username: "priya" }], messages: [{ id: "m1", senderId: "u-priya", body: "See you at 5", createdAt: new Date().toISOString(), attachments: [] }] },
  "c-rahul": { kind: "personal", participants: [{ userId: UID, name: "Harness User" }, { userId: "u-rahul", name: "Rahul", username: "rahul" }], messages: [] }
};

async function stubSupabase(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;
  if (path.includes("/rest/v1/rpc/")) {
    const name = path.split("/rest/v1/rpc/")[1];
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch { /* no body */ }
    if (name === "dm_inbox") return send(route, 200, INBOX);
    if (name === "team_chat_thread") return send(route, 200, THREADS[body.p_conversation] || { kind: "personal", participants: [], messages: [] });
    return send(route, 200, "[]");
  }
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": "0-0/1" });
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

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 800, isMobile: viewport.width < 800 });
  await ctx.addInitScript((session) => {
    try { localStorage.setItem("shinzora.auth", JSON.stringify(session)); } catch { /* sandboxed frame */ }
  }, SESSION);
  await ctx.route("**://*.supabase.co/**", stubSupabase);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/app/?view=messages`, { waitUntil: "load" });
  await page.waitForSelector(".team-chat [data-conversation]", { timeout: 20000 });
  await page.waitForTimeout(400);
  return { ctx, page, errors };
}

const visible = (page, sel) => page.locator(sel).first().isVisible();

/* ------------------------------------------------------------- phone */
{
  console.log("1. phone (390px)");
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await page.evaluate(() => { document.querySelector(".team-chat").dataset.probe = "same-view"; });

  ok("the list is shown first", await visible(page, ".team-chat .chat-pane-list"));
  ok("no conversation is open yet", !(await visible(page, ".team-chat .chat-pane-thread")));
  await page.screenshot({ path: `${SHOTS}/dm-phone-list.png` });

  await page.click('[data-conversation="c-priya"]');
  await page.waitForSelector(".team-chat.is-thread-open", { timeout: 5000 }).catch(() => undefined);
  ok("opening a conversation shows only that thread", (await visible(page, ".team-chat .chat-pane-thread")) && !(await visible(page, ".team-chat .chat-pane-list")));
  ok("the back arrow is visible in the thread", await visible(page, "#dm-back"));
  ok("the thread names the conversation", (await page.textContent(".team-chat #dm-head")).includes("Priya"));
  await page.screenshot({ path: `${SHOTS}/dm-phone-thread.png` });

  await page.click("#dm-back");
  await page.waitForTimeout(250);
  ok("the back arrow returns to the full list", (await visible(page, ".team-chat .chat-pane-list")) && !(await visible(page, ".team-chat .chat-pane-thread")));
  ok("every conversation is listed again", (await page.locator('[data-conversation]').count()) === 2);
  ok("unread count survives the round trip", (await page.textContent('[data-conversation="c-priya"] .chat-unread').catch(() => "")) === "2");

  await page.click('[data-conversation="c-rahul"]');
  await page.waitForSelector(".team-chat.is-thread-open", { timeout: 5000 }).catch(() => undefined);
  await page.goBack();
  await page.waitForTimeout(300);
  ok("the phone's back gesture also returns to the list", (await visible(page, ".team-chat .chat-pane-list")) && !(await page.evaluate(() => document.querySelector(".team-chat").classList.contains("is-thread-open"))));
  ok("the view is not rebuilt on back (same element)", (await page.evaluate(() => document.querySelector(".team-chat")?.dataset.probe)) === "same-view");
  ok("the address is still the messages view", new URL(page.url()).searchParams.get("view") === "messages");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal overflow on the phone", overflow <= 1, `overflow ${overflow}px`);
  ok("no page errors on the phone", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ------------------------------------------------------------ desktop */
{
  console.log("2. desktop (1440px)");
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  ok("both panes are visible side by side", (await visible(page, ".team-chat .chat-pane-list")) && (await visible(page, ".team-chat .chat-pane-thread")));
  ok("the back arrow stays hidden", !(await visible(page, "#dm-back")));
  const before = await page.evaluate(() => history.length);
  await page.click('[data-conversation="c-priya"]');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => history.length);
  ok("opening a conversation adds no history entry on desktop", before === after, `${before} → ${after}`);
  ok("the list stays beside the thread on desktop", await visible(page, ".team-chat .chat-pane-list"));
  await page.screenshot({ path: `${SHOTS}/dm-desktop.png` });
  ok("no page errors on desktop", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll mobile-DM checks passed");
process.exit(bad ? 1 : 0);
