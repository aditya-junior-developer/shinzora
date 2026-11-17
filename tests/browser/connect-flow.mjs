/* ==========================================================================
   Shinzora — browser harness: SHINZORA CONNECT (Daily meetings) screens.
   --------------------------------------------------------------------------
   What it checks, at 390, 820 and 1440 px:
     - the start screen offers Create link, Start now, Join with a code, and
       the meeting history; nothing overflows horizontally
     - Create link sends ONE request even on a double tap, then shows the
       invite link and an enabled Join button
     - an expired link shows why and disables Join; a locked room shows the
       host's message and disables Join
     - Join loads the real vendored SDK (/js/vendor/daily-js.js) and moves out
       of the "Joining" state: into the room, or into a clear error. It never
       hangs on "Joining" silently.
     - no uncaught page errors

   The Edge Function `daily` and the Supabase REST API are stubbed in memory,
   using the same action contract as supabase/functions/daily/index.ts. Calls
   to *.daily.co are aborted, because this sandbox has no outbound network. So
   this harness proves the screens, the request shapes and the error states;
   it does NOT prove a live media call. That needs two real sessions and a
   DAILY_API_KEY (see the report).

     BASE=http://127.0.0.1:4173 SHOTS=/tmp/shots node tests/browser/connect-flow.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/tmp/shots";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z" }
};
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-range",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS"
};
const send = (route, status, body) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

let passed = 0;
let failed = 0;
const ok = (label, cond, detail = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/* ----- in-memory Daily backend (stub of the Edge Function contract) ---------- */
const CODE = "abcdefgh1";
const calls = { create: [], open: 0, join: 0 };
const scenario = { expired: false, locked: false };

function meetingRow(overrides = {}) {
  return {
    id: "m-0001", code: CODE, title: "Design review", kind: "video", provider: "daily",
    status: "waiting", locked: scenario.locked, hostId: UID, scheduledFor: null,
    startedAt: null, endedAt: null, expiresAt: null, createdAt: new Date().toISOString(),
    ...overrides
  };
}

async function daily(route, body) {
  const action = body.action;
  if (action === "create") {
    calls.create.push(body);
    const meeting = meetingRow({ title: body.title || "Meeting", kind: body.kind || "video" });
    const reply = { ok: true, meeting };
    if (body.instant) {
      Object.assign(reply, {
        provider: "daily",
        url: `https://shinzora.daily.co/shz${CODE}s1`,
        token: "stub-token",
        youAreHost: true,
        canManage: true,
        user: { id: UID, name: "Harness User" }
      });
    }
    return send(route, 200, reply);
  }
  if (action === "open") {
    calls.open++;
    if (scenario.expired) {
      return send(route, 200, {
        ok: true, provider: "daily", meeting: meetingRow({ status: "expired", endedAt: "2026-11-01T10:00:00Z", expiresAt: "2026-11-02T10:00:00Z" }),
        hostName: "Asha", youAreHost: false, canManage: false, canJoin: false, canReturn: false, liveCount: 0,
        reason: "This meeting ended more than 24 hours ago, so its link has expired. Ask the host for a new meeting.",
        expiresAt: "2026-11-02T10:00:00Z"
      });
    }
    return send(route, 200, {
      ok: true, provider: "daily", meeting: meetingRow(), hostName: "Harness User", youAreHost: true, canManage: true,
      canJoin: !scenario.locked, reason: scenario.locked ? "The host has locked this meeting. Ask them to unlock it, then open the link again." : "",
      expiresAt: null, liveCount: 0, canReturn: false
    });
  }
  if (action === "join") {
    calls.join++;
    return send(route, 200, {
      ok: true, provider: "daily", url: `https://shinzora.daily.co/shz${CODE}s1`, token: "stub-token",
      meeting: meetingRow({ status: "live" }), youAreHost: true, canManage: true, user: { id: UID, name: "Harness User" }
    });
  }
  if (action === "history") return send(route, 200, { ok: true, meetings: [] });
  if (action === "admin_overview") return send(route, 403, { code: "forbidden", error: "Administrators only." });
  return send(route, 200, { ok: true });
}

async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const url = new URL(req.url());
  if (url.pathname.includes("/functions/v1/daily")) {
    return daily(route, req.postData() ? JSON.parse(req.postData()) : {});
  }
  if (url.pathname.includes("/rest/v1/profiles")) {
    return send(route, 200, [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }]);
  }
  if (url.pathname.includes("/rpc/")) return send(route, 200, []);
  if (url.pathname.includes("/rest/v1/")) return send(route, 200, []);
  return send(route, 200, {});
}

/* ----- run ----------------------------------------------------------------- */
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name} (${vp.width}px)`);
  calls.create.length = 0; calls.open = 0; calls.join = 0;
  scenario.expired = false; scenario.locked = false;

  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  await ctx.route("**://*.daily.co/**", (route) => route.abort());
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1);

  /* 1. Start screen */
  await page.goto(`${BASE}/app/?view=meeting`, { waitUntil: "load" });
  await page.waitForSelector("#meeting-create", { timeout: 20000 });
  ok("start screen shows Create link and Start now", (await page.locator('[data-create-mode="create"]').count()) === 1 && (await page.locator('[data-create-mode="instant"]').count()) === 1);
  ok("start screen shows Join with a code and meeting history", (await page.locator("#meeting-join-code").count()) === 1 && (await page.locator("#meeting-history").count()) === 1);
  ok("no horizontal overflow on the start screen", await noOverflow());
  await page.screenshot({ path: `${SHOTS}/connect-${vp.name}-start.png`, fullPage: true });

  /* 2. Join with a bad code is refused before any server call */
  await page.fill("#meeting-join-code", "abc");
  await page.click("#meeting-join-form button[type=submit]");
  await page.waitForTimeout(250);
  ok("a malformed code is refused locally", (await page.locator("#meeting-join-field.invalid").count()) === 1 && calls.open === 0);

  /* 3. Create link: double tap sends one request */
  await page.fill("#meeting-title", "Design review");
  await page.dblclick('[data-create-mode="create"]');
  await page.waitForSelector("#meeting-link", { timeout: 15000 });
  ok("a double tap creates exactly one meeting", calls.create.length === 1, `requests=${calls.create.length}`);
  ok("the create request carries a request identity", /^[0-9a-f-]{36}$/i.test(calls.create[0]?.requestId || ""));
  const link = await page.inputValue("#meeting-link");
  ok("the lobby shows the invite link", link.includes(`code=${CODE}`), link);
  ok("Join is enabled in the lobby", await page.locator("[data-meeting-join]").isEnabled());
  await page.screenshot({ path: `${SHOTS}/connect-${vp.name}-lobby.png`, fullPage: true });
  ok("no horizontal overflow in the lobby", await noOverflow());

  /* 4. Join: the SDK loads and the screen leaves "Joining" */
  await page.click("[data-meeting-join]");
  await page.waitForFunction(() => !document.querySelector(".connect-state") || !/Joining the meeting/.test(document.querySelector(".connect-state")?.textContent || ""), null, { timeout: 25000 }).catch(() => {});
  const sdkLoaded = await page.evaluate(() => Boolean(window.DailyIframe?.createCallObject));
  ok("the vendored Daily SDK loads in the browser", sdkLoaded);
  const stuck = await page.evaluate(() => /Joining the meeting/.test(document.body.textContent || "") && !document.querySelector(".connect-room"));
  ok("join does not hang on \"Joining\"", !stuck);
  await page.screenshot({ path: `${SHOTS}/connect-${vp.name}-join.png`, fullPage: true });

  /* 5. Expired link */
  scenario.expired = true;
  await page.goto(`${BASE}/app/?view=meeting&code=${CODE}`, { waitUntil: "load" });
  await page.waitForSelector("#meeting-link", { timeout: 15000 });
  ok("an expired link explains why", (await page.locator(".connect-notice-danger").innerText()).includes("expired"));
  ok("an expired link disables Join", (await page.locator("[data-meeting-join]").isDisabled()) === true);
  await page.screenshot({ path: `${SHOTS}/connect-${vp.name}-expired.png`, fullPage: true });
  scenario.expired = false;

  /* 6. Locked room */
  scenario.locked = true;
  await page.goto(`${BASE}/app/?view=meeting&code=${CODE}`, { waitUntil: "load" });
  await page.waitForSelector("#meeting-link", { timeout: 15000 });
  ok("a locked room shows the host's message", (await page.locator(".connect-notice").innerText()).includes("locked"));
  ok("a locked room disables Join for a guest", (await page.locator("[data-meeting-join]").isDisabled()) === true);
  scenario.locked = false;

  ok("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
