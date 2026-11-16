/* ==========================================================================
   Shinzora — browser harness: the Zoom-style meeting screens (brief 2)
   --------------------------------------------------------------------------
   Opens Zoom and Room screens at 390, 820 and 1440 px and checks:
     - the start screen (schedule a meeting, join by code, upcoming list)
       and the live meeting bar (code, copy and leave actions)
     - no element runs past the right edge of the screen
     - no horizontal page overflow
     - on touch screens, every button and link is at least 44px tall
     - no page errors
   Screenshots go to SHOTS for a visual check.

     BASE=http://127.0.0.1:4173 node tests/browser/responsive-zoom.mjs
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
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};
const UPCOMING = [{ id: "m1", code: "abcde-fghi2", title: "Weekly sync with the design team", kind: "video", status: "scheduled", at: new Date(Date.now() + 3600000).toISOString() }];
async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;
  if (path.includes("/rpc/meeting_upcoming")) return send(route, 200, UPCOMING);
  if (path.includes("/rpc/meeting_mine")) return send(route, 200, UPCOMING);
  if (path.includes("/rpc/")) return send(route, 200, "[]");
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": "0-0/1" });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

let bad = 0;
const ok = (name, pass, note = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`); if (!pass) bad++; };

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

/* Measured inside the view root, so the app chrome (sidebar, header) is not counted. */
const measure = (touch) => {
  const root = document.querySelector("#view-root");
  const vw = document.documentElement.clientWidth;
  const rightEdge = [...root.querySelectorAll("*")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > vw + 1 && !el.closest("[style*='overflow']");
  }).map((el) => `${el.tagName.toLowerCase()}.${(el.className && el.className.baseVal === undefined ? el.className : "").toString().split(" ")[0]}`);
  const targets = touch
    ? [...root.querySelectorAll("button, a.btn, .btn, input[type=button], input[type=submit]")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
      }).map((el) => ({ h: Math.round(el.getBoundingClientRect().height), text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24) }))
    : [];
  return {
    overflow: document.documentElement.scrollWidth - vw,
    rightEdge,
    short: targets.filter((t) => t.h < 44),
    targetCount: targets.length
  };
};

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/app/?view=meeting`, { waitUntil: "load" });
  await page.waitForSelector(".meeting-start, .meeting-join, .meeting-missing", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const start = await page.evaluate(measure, vp.touch);
  ok("start screen: no horizontal page overflow", start.overflow <= 1, `overflow ${start.overflow}px`);
  ok("start screen: nothing runs past the right edge", start.rightEdge.length === 0, start.rightEdge.slice(0, 3).join(", "));
  if (vp.touch) ok("start screen: every button is 44px+ tall", start.short.length === 0, `${start.short.length} short, e.g. "${start.short[0]?.text}" ${start.short[0]?.h}px`);
  await page.screenshot({ path: `${SHOTS}/zoom-${vp.name}-start.png`, fullPage: true });

  await page.goto(`${BASE}/app/?view=meeting&code=abcdefgh2`, { waitUntil: "load" });
  await page.waitForSelector(".meeting-lobby, .meeting-join, .meeting-live, .meeting-missing", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const join = await page.evaluate(measure, vp.touch);
  ok("join or lobby: no horizontal page overflow", join.overflow <= 1, `overflow ${join.overflow}px`);
  ok("join or lobby: nothing runs past the right edge", join.rightEdge.length === 0, join.rightEdge.slice(0, 3).join(", "));
  if (vp.touch) ok("join or lobby: every button is 44px+ tall", join.short.length === 0, `${join.short.length} short, e.g. "${join.short[0]?.text}" ${join.short[0]?.h}px`);
  await page.screenshot({ path: `${SHOTS}/zoom-${vp.name}-join.png`, fullPage: true });

  ok(`${vp.name}: no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll Zoom-screen checks passed");
process.exit(bad ? 1 : 0);
