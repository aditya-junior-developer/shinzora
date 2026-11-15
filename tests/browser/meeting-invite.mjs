/* ==========================================================================
   Shinzora — browser harness: meeting invitations (brief item 3)
   --------------------------------------------------------------------------
   Drives the real pages with the Supabase network stubbed (same approach as
   request-services.mjs). Checks where people land:
     - a signed-out visitor is sent to sign-in and keeps the meeting path
     - a signed-in visitor who opens sign-in with that path lands in the room
       (the old guard sent them to the dashboard)
     - the Meetings page joins with a typed code, and refuses a bad one in place
     - a missing or ended meeting shows a clear message

     BASE=http://127.0.0.1:4173 node tests/browser/meeting-invite.mjs
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

/* meeting_lookup answers per code, so each case can be exercised. */
const MEETINGS = {
  abcdefgh2: { found: true, id: "dddddddd-1111-2222-3333-444444444444", code: "abcdefgh2", title: "Design review", kind: "video", hostId: "99999999-1111-2222-3333-444444444444", hostName: "Priya", locked: false, youAreHost: false, participants: 1, topic: "call-meeting:dddddddd" },
  endedmeet: { found: true, ended: true, title: "Old standup" }
};
const rpcCalls = [];

async function stubSupabase(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  const path = url.pathname;
  if (path.includes("/rest/v1/rpc/")) {
    const name = path.split("/rest/v1/rpc/")[1];
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch { /* no body */ }
    rpcCalls.push({ name, body });
    if (name === "meeting_lookup") {
      const hit = MEETINGS[String(body.p_code || "").toLowerCase()];
      return send(route, 200, hit || { found: false });
    }
    if (name === "meeting_mine") return send(route, 200, []);
    return send(route, 200, "false");
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

async function open({ signedIn, viewport = { width: 390, height: 844 } }) {
  const ctx = await browser.newContext({ viewport });
  if (signedIn) {
    await ctx.addInitScript((session) => {
      try { localStorage.setItem("shinzora.auth", JSON.stringify(session)); } catch { /* sandboxed frame */ }
    }, SESSION);
  }
  await ctx.route("**://*.supabase.co/**", stubSupabase);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}

const INVITE = "/app/?view=meeting&code=abcdefgh2";

/* 1. Signed out: the invite goes to sign-in, and the path survives. */
{
  console.log("1. signed-out visitor");
  const { ctx, page } = await open({ signedIn: false });
  await page.goto(BASE + INVITE, { waitUntil: "load" });
  await page.waitForURL(/\/auth\/login\/\?next=/, { timeout: 15000 }).catch(() => undefined);
  const url = new URL(page.url());
  ok("sent to sign-in", url.pathname === "/auth/login/");
  ok("the meeting path is kept in next", url.searchParams.get("next") === INVITE, url.searchParams.get("next") || "(none)");
  await ctx.close();
}

/* 2. Signed in, arriving at sign-in with the invite: lands in the room. */
{
  console.log("2. signed-in visitor opens sign-in with the invite");
  const { ctx, page, errors } = await open({ signedIn: true });
  await page.goto(`${BASE}/auth/login/?next=${encodeURIComponent(INVITE)}`, { waitUntil: "load" });
  await page.waitForURL((u) => u.pathname === "/app/" && u.search.includes("code=abcdefgh2"), { timeout: 20000 }).catch(() => undefined);
  await page.waitForSelector(".meeting-lobby", { timeout: 15000 }).catch(() => undefined);
  const url = new URL(page.url());
  ok("ends on the meeting room, not the dashboard", url.searchParams.get("view") === "meeting" && url.searchParams.get("code") === "abcdefgh2", page.url());
  ok("the lobby shows the meeting title", (await page.textContent("body")).includes("Design review"));
  await page.screenshot({ path: `${SHOTS}/invite-lobby-390.png`, fullPage: false });
  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* 3. Join with a code on the Meetings page. */
{
  console.log("3. join with a code");
  const { ctx, page, errors } = await open({ signedIn: true });
  await page.goto(BASE + "/app/?view=meeting", { waitUntil: "load" });
  await page.waitForSelector("#meeting-join-form", { timeout: 20000 });

  await page.fill("#meeting-join-code", "xx");
  await page.click("#meeting-join-form button[type=submit]");
  const shown = await page.isVisible("#meeting-join-error");
  ok("a short code is refused in place", shown && page.url().includes("view=meeting") && !page.url().includes("code="), await page.textContent("#meeting-join-error"));
  await page.screenshot({ path: `${SHOTS}/join-invalid-390.png`, fullPage: false });

  await page.fill("#meeting-join-code", "ABCD-EFGH2");
  await page.click("#meeting-join-form button[type=submit]");
  await page.waitForSelector(".meeting-lobby", { timeout: 15000 }).catch(() => undefined);
  ok("a valid code (any case, with a dash) opens the lobby", new URL(page.url()).searchParams.get("code") === "abcdefgh2", page.url());
  await ctx.close();
}

/* 4. Missing and ended meetings. */
{
  console.log("4. invalid and ended links");
  const { ctx, page } = await open({ signedIn: true });
  await page.goto(`${BASE}/app/?view=meeting&code=zzzzzzzz9`, { waitUntil: "load" });
  await page.waitForSelector(".meeting-missing", { timeout: 15000 }).catch(() => undefined);
  ok("an unknown code says no meeting has it", (await page.textContent("body")).includes("No meeting with that code"));
  await page.goto(`${BASE}/app/?view=meeting&code=endedmeet`, { waitUntil: "load" });
  await page.waitForSelector(".meeting-missing", { timeout: 15000 }).catch(() => undefined);
  ok("an ended meeting says it has ended", (await page.textContent("body")).includes("This meeting has ended"));
  await ctx.close();
}

/* 5. Phone, tablet, desktop: the join form has no horizontal scroll. */
for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["tablet", { width: 820, height: 1180 }], ["desktop", { width: 1440, height: 900 }]]) {
  console.log(`5. layout: ${name}`);
  const { ctx, page } = await open({ signedIn: true, viewport });
  await page.goto(BASE + "/app/?view=meeting", { waitUntil: "load" });
  await page.waitForSelector("#meeting-join-form", { timeout: 20000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`${name}: no horizontal overflow`, overflow <= 1, `overflow ${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/meetings-${name}.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll meeting-invite checks passed");
process.exit(bad ? 1 : 0);
