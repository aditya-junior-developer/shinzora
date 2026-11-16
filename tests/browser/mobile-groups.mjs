/* ==========================================================================
   Shinzora — browser harness: Groups separate from Channels on a phone (brief 5)
   --------------------------------------------------------------------------
     - phone (390) and tablet (820): a segmented control shows Groups or
       Channels, never both; the active segment is marked and announced
     - the phone list scrolls inside the rail; nothing runs off the screen
     - desktop (1440): both lists stay in the rail and the control is hidden
     - no page errors at any size

     BASE=http://127.0.0.1:4173 node tests/browser/mobile-groups.mjs
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
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }],
  community_channels: [
    { slug: "general", name: "General", description: "Open chat for everyone" },
    { slug: "design", name: "Design", description: "Show your work" }
  ]
};
const GROUPS = [
  { id: "g1", name: "Design crew", unread: 2, lastMessage: "See you at 5", lastMessageAt: new Date(Date.now() - 600000).toISOString() },
  { id: "g2", name: "Founders", unread: 0, lastMessage: "Deck is ready", lastMessageAt: new Date(Date.now() - 3600000).toISOString() },
  { id: "g3", name: "Marketing", unread: 0, lastMessage: "", lastMessageAt: null }
];
async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;
  if (path.includes("/rpc/group_my_groups")) return send(route, 200, GROUPS);
  if (path.includes("/rpc/")) return send(route, 200, "[]");
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  return send(route, 503, { error: "not stubbed" });
}

let bad = 0;
const ok = (name, pass, note = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`); if (!pass) bad++; };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true, split: true },
  { name: "tablet", width: 820, height: 1180, touch: true, split: true },
  { name: "desktop", width: 1440, height: 900, touch: false, split: false }
];

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${BASE}/app/?view=messages&tab=groups`, { waitUntil: "load" });
  await page.waitForSelector("#grp-list .chat-item", { timeout: 20000 });
  await page.waitForSelector("#grp-channels .chat-item", { state: "attached", timeout: 20000 });
  await page.waitForTimeout(300);

  const groupsShown = await page.locator("#grp-list").isVisible();
  const channelsShown = await page.locator("#grp-channels").isVisible();
  const seg = page.locator(".hub-rail-seg");
  const segShown = await seg.isVisible().catch(() => false);

  /* Groups and Channels are separate pages (brief 8). This page is groups only:
     no Groups / Channels control, and the channels rail stays hidden. */
  ok("the Groups page has no Groups / Channels control", !segShown && (await page.locator("#grp-seg-groups").count()) === 0 && (await page.locator("#grp-seg-channels").count()) === 0);
  ok("the channels rail is hidden on the Groups page", !channelsShown);
  ok("Groups is the list shown", groupsShown, `groups ${groupsShown}`);
  ok("only the group entries are listed (no channel names)", (await page.locator("#grp-list .chat-item").count()) === GROUPS.length
    && (await page.locator("#grp-list").innerText()).includes("Design crew"));
  if (vp.split) {
    const listBox = await page.locator("#grp-list").boundingBox();
    ok("the group list fits inside the rail (scrolls, does not spill)", listBox && listBox.width > 0 && listBox.height > 0 && listBox.height <= vp.height * 0.45 + 2, `list height ${Math.round(listBox?.height || 0)}`);
    await page.screenshot({ path: `${SHOTS}/groups-${vp.name}-groups.png` });
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("no horizontal page overflow", overflow <= 1, `overflow ${overflow}px`);
  ok("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll mobile-groups checks passed");
process.exit(bad ? 1 : 0);
