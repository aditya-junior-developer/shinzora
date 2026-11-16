/* ==========================================================================
   Shinzora — browser harness: profile rings and the channel room (brief 6)
   --------------------------------------------------------------------------
     - each member's ring is asked for once, for the ids on screen only (the viewer's own included)
     - a Glow member wears the Glow ring; an Elite member wears their accent
     - a member with no tier wears no ring
     - the channel room is flat: the first line of each run has the avatar and
       name, the lines under it sit flush with that name
     - the channel rail heading and open-row mark are present
     - no horizontal overflow and no page errors at 390, 820 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/discord-ui.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-r6";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const GLOW = "aaaaaaaa-0000-4000-8000-00000000a001";
const ELITE = "bbbbbbbb-0000-4000-8000-00000000b002";
const PLAIN = "cccccccc-0000-4000-8000-00000000c003";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z", user_metadata: {} }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

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
const TIMES = [600000, 540000, 480000, 420000];
const CHANNEL_MESSAGES = [
  { id: "m1", body: "Morning all", createdAt: new Date(Date.now() - TIMES[0]).toISOString(), authorId: GLOW, authorName: "Gita Glow", username: "gita", avatarUrl: null },
  { id: "m2", body: "Second line from the same person", createdAt: new Date(Date.now() - TIMES[1]).toISOString(), authorId: GLOW, authorName: "Gita Glow", username: "gita", avatarUrl: null },
  { id: "m3", body: "Elite here, with a rose ring", createdAt: new Date(Date.now() - TIMES[2]).toISOString(), authorId: ELITE, authorName: "Elan Elite", username: "elan", avatarUrl: null },
  { id: "m4", body: "A plain member", createdAt: new Date(Date.now() - TIMES[3]).toISOString(), authorId: PLAIN, authorName: "Pia Plain", username: "pia", avatarUrl: null }
];
const RING_OF = {
  [GLOW]: { member_id: GLOW, ring_id: "sakura", ring_name: "Sakura" },
  [ELITE]: { member_id: ELITE, ring_id: "tiger-gold", ring_name: "Tiger gold" }
};

const ringCalls = [];
async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;
  if (path.includes("/rpc/member_rings")) {
    const ids = (req.postDataJSON() || {}).p_user_ids || [];
    ringCalls.push(ids);
    return send(route, 200, ids.filter((id) => RING_OF[id]).map((id) => RING_OF[id]));
  }
  if (path.includes("/rpc/community_messages_list")) return send(route, 200, CHANNEL_MESSAGES);
  if (path.includes("/rpc/group_my_groups")) return send(route, 200, []);
  if (path.includes("/rpc/")) return send(route, 200, "[]");
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
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
  console.log(`${vp.name} (${vp.width}px)`);
  ringCalls.length = 0;
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => {
    try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ }
  }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  await page.goto(`${BASE}/app/?view=community`, { waitUntil: "load" });
  await page.waitForSelector('#grp-channels [data-channel="general"]', { state: "attached", timeout: 20000 });
  /* If no room is open yet (a phone shows the rail first), a member taps the channel. */
  const opened = await page.locator("#grp-messages .chan-line").count();
  if (!opened) {
    await page.locator('#grp-channels [data-channel="general"]').first().click();
  }
  await page.waitForSelector("#grp-messages.is-channel .chan-line", { state: "attached", timeout: 20000 });
  await page.waitForSelector("#grp-messages .chan-line", { state: "visible", timeout: 20000 });
  await page.waitForTimeout(600);

  /* Each member's ring is asked for once, for the members on screen. The viewer's
     own avatar (UID) is on screen too, so it may be asked for, but never twice. */
  const ids = ringCalls.flat();
  const onScreen = new Set([GLOW, ELITE, PLAIN, UID]);
  ok("each ring is asked for once, only for the members on screen",
    ringCalls.length >= 1 && new Set(ids).size === ids.length && ids.every((id) => onScreen.has(id)) && [GLOW, ELITE, PLAIN].every((id) => ids.includes(id)),
    `calls=${ringCalls.length}, ids=${ids.length}`);

  const glow = await page.$eval(`[data-ring-user="${GLOW}"]`, (el) => ({ ring: el.getAttribute("data-ring"), art: el.style.getPropertyValue("--ring-art") })).catch(() => null);
  ok("a member who applied a design wears it", glow?.ring === "sakura" && (glow.art || "").includes("/assets/rings/sakura.png"), JSON.stringify(glow));

  const elite = await page.$eval(`[data-ring-user="${ELITE}"]`, (el) => ({ ring: el.getAttribute("data-ring"), art: el.style.getPropertyValue("--ring-art") })).catch(() => null);
  ok("another member wears their own design", elite?.ring === "tiger-gold" && (elite.art || "").includes("tiger-gold.png"), JSON.stringify(elite));

  const plain = await page.$eval(`[data-ring-user="${PLAIN}"]`, (el) => el.hasAttribute("data-ring")).catch(() => null);
  ok("a member with no ring wears none", plain === false);

  const layout = await page.evaluate(() => ({
    room: document.querySelector("#grp-messages")?.classList.contains("is-channel"),
    lines: document.querySelectorAll("#grp-messages .chan-line").length,
    firsts: document.querySelectorAll("#grp-messages .chan-line.is-first").length,
    gutters: document.querySelectorAll("#grp-messages .chan-gutter").length,
    whoNames: [...document.querySelectorAll("#grp-messages .chan-line.is-first .bubble-who")].map((el) => el.textContent.trim())
  }));
  ok("the channel room is flat", layout.room === true);
  ok("each run from one author shows the name once", layout.lines === 4 && layout.firsts === 3 && layout.gutters === 1, JSON.stringify(layout));
  ok("the names read in order", layout.whoNames.join("|") === "Gita Glow|Elan Elite|Pia Plain", layout.whoNames.join("|"));

  const rail = await page.evaluate(() => {
    const head = document.querySelector(".hub-rail-channels > .hub-rail-head");
    const active = document.querySelector("#grp-channels .chat-item.is-active");
    return { headTransform: head ? getComputedStyle(head).textTransform : null, activeShadow: active ? getComputedStyle(active).boxShadow : null };
  });
  ok("the channel heading reads as a category", rail.headTransform === "uppercase", String(rail.headTransform));
  ok("the open channel is marked", rail.activeShadow && rail.activeShadow !== "none", String(rail.activeShadow));

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok("no horizontal overflow", overflow <= 1, `${overflow}px`);

  await page.screenshot({ path: `${SHOTS}/after-community-${vp.name}.png` });
  const timeAlign = await page.$eval("#grp-messages .chan-line .bubble-time", (el) => getComputedStyle(el).textAlign).catch(() => "missing");
  ok("timestamps sit left under the line", timeAlign === "left", timeAlign);
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : "\nAll discord-ui checks passed");
process.exit(bad ? 1 : 0);
