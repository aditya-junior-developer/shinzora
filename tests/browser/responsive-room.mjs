/* ==========================================================================
   Shinzora — browser harness: the call room (brief 2, "Room")
   --------------------------------------------------------------------------
   Opens the real call surface (openCallSurface) with a fake call object, so
   no media devices or signalling are needed. Checks at 390, 820 and 1440 px:
     - no horizontal page overflow
     - every control button is inside the screen and can be tapped (44px)
     - the video tiles fit the stage; no tile is cut off
     - the header, timer and close button fit on one row
   Screenshots go to SHOTS for a visual check.

     BASE=http://127.0.0.1:4173 node tests/browser/responsive-room.mjs
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
async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;
  if (path.includes("/rpc/")) return send(route, 200, "[]");
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": "0-0/1" });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

/* A call object with the surface the call panel reads. Peers are fake tiles
   with no media, so the tile markup is the only thing measured. */
const fakeCall = (kind, peerCount) => `(() => {
  const peers = Array.from({ length: ${peerCount} }, (_, i) => ({
    userId: "p" + i, name: "Person " + (i + 1), stream: null, state: "connected", muted: i % 2 === 1, cameraOn: ${kind === "video"} }));
  const state = { kind: ${JSON.stringify(kind)}, title: "Design review with a long meeting title", topic: "t-" + Math.random(), status: "connected", peers };
  let listener = () => {};
  return {
    state,
    getLocalStream: () => null,
    setListener(fn) { if (typeof fn !== "function") { listener = () => {}; return; } listener = fn; fn(); },
    join: async () => {}, leave: async () => {},
    ownLevel: () => 0,
    toggleMute() {}, toggleCamera() {}, switchCamera() {}, toggleScreenShare() {}
  };
})()`;

let bad = 0;
const ok = (name, pass, note = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`); if (!pass) bad++; };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900 }
];
const CASES = [
  { kind: "voice", people: 1 },
  { kind: "video", people: 1 },
  { kind: "video", people: 4 }
];

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: !!vp.touch, isMobile: !!vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/app/?view=overview`, { waitUntil: "load" });
  await page.waitForSelector("#view-root", { timeout: 20000 });
  await page.waitForTimeout(300);

  for (const c of CASES) {
    await page.evaluate(async ({ call, fake }) => {
      const mod = await import("/js/modules/messaging/call-ui.js");
      document.querySelectorAll(".call-surface").forEach((n) => n.remove());
      mod.openCallSurface({ call: eval(fake), self: { userId: "me", name: "Harness" }, subtitle: "Design team", onClose: () => {} });
    }, { call: null, fake: fakeCall(c.kind, c.people) });
    await page.waitForSelector(".call-surface", { timeout: 5000 });
    await page.waitForTimeout(250);
    const label = `${c.kind}, ${c.people + 1} in the room`;

    const m = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const surface = document.querySelector(".call-surface").getBoundingClientRect();
      const controls = [...document.querySelectorAll(".call-surface .call-controls button, .call-surface .call-controls a")].map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.width > 0 && r.height > 0 };
      });
      const tiles = [...document.querySelectorAll(".call-surface .call-tile")].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const stage = document.querySelector(".call-surface .call-stage")?.getBoundingClientRect();
      const head = document.querySelector(".call-surface .call-head");
      const headRect = head?.getBoundingClientRect();
      const headHeight = headRect ? Math.round(headRect.height) : 0;
      return {
        overflow: document.documentElement.scrollWidth - vw,
        vw, vh,
        surfaceWidth: Math.round(surface.width),
        surfaceHeight: Math.round(surface.height),
        controls,
        tiles,
        stage: stage ? { left: Math.round(stage.left), right: Math.round(stage.right), top: Math.round(stage.top), bottom: Math.round(stage.bottom) } : null,
        headHeight,
        closeVisible: !!document.querySelector(".call-surface .call-close")?.getBoundingClientRect().width
      };
    });

    ok(`${label}: no horizontal page overflow`, m.overflow <= 1, `overflow ${m.overflow}px`);
    const offscreen = m.controls.filter((b) => !b.visible || b.left < 0 || b.right > m.vw + 1);
    ok(`${label}: every control is on screen`, m.controls.length > 0 && offscreen.length === 0, `${offscreen.length} off screen of ${m.controls.length}`);
    if (vp.touch) {
      const short = m.controls.filter((b) => b.h < 44);
      ok(`${label}: every control is a 44px+ tap target`, short.length === 0, `${short.length} shorter, e.g. ${short[0] ? short[0].w + "x" + short[0].h : "-"}`);
    }
    const outside = m.tiles.filter((t) => t.left < -1 || t.right > m.vw + 1);
    ok(`${label}: every tile is inside the screen`, outside.length === 0, `${outside.length} cut off`);
    ok(`${label}: the header is one line tall`, m.headHeight > 0 && m.headHeight <= 64, `${m.headHeight}px`);
    ok(`${label}: the close button is shown`, m.closeVisible);
    await page.screenshot({ path: `${SHOTS}/room-${vp.name}-${c.kind}-${c.people + 1}.png` });
    console.log(`    · ${label}: ${m.controls.length} controls, ${m.tiles.length} tiles, surface ${m.surfaceWidth}×${m.surfaceHeight}`);
  }

  ok(`${vp.name}: no page errors`, errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll room checks passed");
process.exit(bad ? 1 : 0);
