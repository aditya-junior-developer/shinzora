/* ==========================================================================
   Shinzora — browser harness: every theme and every wallpaper (brief 3)
   --------------------------------------------------------------------------
     - each theme, chosen through the real Settings control, changes the page
       (data-theme, data-tone, body background) and survives a reload
     - each catalogue wallpaper, chosen through the real catalogue, is painted:
       its image is fetched with status 200 and the layer is visible on the page
     - no page errors at 390, 820 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/themes-wallpapers.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-r10";
mkdirSync(SHOTS, { recursive: true });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-2222-3333-4444-555555555555";
const NOW = Math.floor(Date.now() / 1000);
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, aud: "authenticated", role: "authenticated", exp: NOW + 86400, iat: NOW, email: "harness@example.com" })}.sig`;
const SESSION = {
  access_token: JWT, token_type: "bearer", expires_in: 86400, expires_at: NOW + 86400, refresh_token: "harness",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "harness@example.com", email_confirmed_at: new Date(NOW * 1000).toISOString(), created_at: "2026-10-01T09:00:00Z" }
};
const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const send = (route, status, body, extra = {}) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });

const ROWS = {
  profiles: [{ id: UID, full_name: "Harness User", email: "harness@example.com", account_type: "owner", theme: null, created_at: "2026-10-01T09:00:00Z" }],
  businesses: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", owner_id: UID, name: "Harness Studio", created_at: "2026-10-02T09:00:00Z" }],
  subscriptions: [{ id: "bbbbbbbb-1111-2222-3333-444444444444", user_id: UID, plan: "pro", status: "active" }],
  onboarding_progress: [{ id: "cccccccc-1111-2222-3333-444444444444", user_id: UID, status: "completed", current_step: 6, draft: {} }]
};

/* The real catalogue (0059): four collections, two wallpapers each, all open to an Elite member. */
const WALLPAPERS = [
  ["anime", "Anime", "Glow", "Petal sky", "/assets/themes/anime-petal-sky.svg"],
  ["anime", "Anime", "Glow", "Speed lines", "/assets/themes/anime-speed-lines.svg"],
  ["ghibli-inspired", "Ghibli-inspired", "Glow", "Meadow wind", "/assets/themes/ghibli-meadow-wind.svg"],
  ["ghibli-inspired", "Ghibli-inspired", "Glow", "Lantern hills", "/assets/themes/ghibli-lantern-hills.svg"],
  ["cyberpunk", "Cyberpunk", "Elite", "Neon grid", "/assets/themes/cyber-neon-grid.svg"],
  ["cyberpunk", "Cyberpunk", "Elite", "Rain towers", "/assets/themes/cyber-rain-towers.svg"],
  ["trending-2026", "Trending 2026", "Elite", "Glass mesh", "/assets/themes/trend-glass-mesh.svg"],
  ["trending-2026", "Trending 2026", "Elite", "Quiet gradient", "/assets/themes/trend-quiet-gradient.svg"]
];
const wid = (i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
let chosen = null;
function catalog() {
  const map = new Map();
  WALLPAPERS.forEach(([cid, cname, tier, title, url], i) => {
    if (!map.has(cid)) map.set(cid, { id: cid, name: cname, description: "", requiredTier: tier === "Glow" ? "glow" : "elite", locked: false, wallpapers: [] });
    map.get(cid).wallpapers.push({ id: wid(i), title, imageUrl: url });
  });
  return { collections: [...map.values()], chosenWallpaperId: chosen, tier: "elite" };
}

const served = new Map();
async function stub(route) {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
  const path = new URL(req.url()).pathname;
  if (path.includes("/rpc/")) {
    const name = path.split("/rpc/")[1];
    const body = req.postDataJSON() || {};
    if (name === "theme_catalog") return send(route, 200, catalog());
    if (name === "theme_set_wallpaper") { chosen = body.p_wallpaper; return send(route, 200, { ok: true }); }
    if (name === "theme_clear_wallpaper") { chosen = null; return send(route, 200, { ok: true }); }
    if (name === "member_wallpaper_state") return send(route, 200, { tierOk: true, limit: 5, chosenId: null, chosenPath: null, uploads: [] });
    return send(route, 200, "[]");
  }
  if (path.includes("/auth/v1/")) return send(route, 200, SESSION.user);
  const table = Object.keys(ROWS).find((name) => path.includes(`/rest/v1/${name}`));
  if (table) return send(route, 200, ROWS[table], { "content-range": `0-${ROWS[table].length - 1}/${ROWS[table].length}` });
  if (path.includes("/rest/v1/")) return send(route, 200, "[]", { "content-range": "*/0" });
  return send(route, 503, { error: "not stubbed" });
}

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1440, height: 900, touch: false }
];

/* What the page actually shows: the computed page colours and whether the
   wallpaper layer is painted (its image, opacity and box). */
const probe = () => {
  const root = document.documentElement;
  const layer = document.getElementById("theme-wallpaper");
  const cs = layer ? getComputedStyle(layer) : null;
  const rect = layer ? layer.getBoundingClientRect() : null;
  return {
    theme: root.getAttribute("data-theme") || "midnight",
    tone: root.getAttribute("data-tone"),
    wallpaperAttr: root.getAttribute("data-wallpaper"),
    body: getComputedStyle(document.body).backgroundColor,
    layerImage: cs ? cs.backgroundImage : "",
    layerOpacity: cs ? Number(cs.opacity) : 0,
    layerBox: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
    layerDisplay: cs ? cs.display : ""
  };
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
let bad = 0;
const results = [];
const ok = (name, pass, note = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${note ? " — " + note : ""}`);
  if (!pass) bad++;
};

for (const vp of VIEWPORTS) {
  console.log(`${vp.name} (${vp.width}px)`);
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch });
  await ctx.addInitScript((s) => { try { localStorage.setItem("shinzora.auth", JSON.stringify(s)); } catch { /* sandboxed */ } }, SESSION);
  await ctx.route("**://*.supabase.co/**", stub);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("response", (r) => { if (r.url().includes("/assets/themes/")) served.set(new URL(r.url()).pathname, r.status()); });

  /* 1. Every theme, chosen through Settings. */
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.locator('[data-section="appearance"]').first().click();
  await page.waitForSelector("[data-theme-choice]", { timeout: 20000 });
  const before = await page.evaluate(probe);
  const themeIds = ["midnight", "blossom", "daylight", "nebula", "grove", "porcelain"];
  const bodies = new Set([before.body]);
  for (const id of themeIds) {
    await page.locator(`[data-theme-choice="${id}"]`).first().click();
    await page.waitForTimeout(250);
    const p = await page.evaluate(probe);
    bodies.add(p.body);
    ok(`theme ${id} applies`, p.theme === id, `data-theme=${p.theme} tone=${p.tone}`);
    results.push({ viewport: vp.name, kind: "theme", id, ...p });
  }
  ok("the six themes give six different page colours", bodies.size >= 6, `distinct=${bodies.size}`);
  await page.reload({ waitUntil: "load" });
  await page.locator('[data-section="appearance"]').first().click();
  await page.waitForSelector("[data-theme-choice]", { timeout: 20000 });
  await page.locator('[data-theme-choice="grove"]').first().click();
  await page.reload({ waitUntil: "load" });
  const kept = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  ok("the chosen theme survives a reload", kept === "grove", `data-theme=${kept}`);
  await page.locator('[data-theme-choice="midnight"]').first().click().catch(() => {});

  /* 2. Every wallpaper, chosen through the catalogue, shown on the dashboard. */
  for (let i = 0; i < WALLPAPERS.length; i++) {
    const [, , , title, url] = WALLPAPERS[i];
    chosen = wid(i);
    served.delete(url);
    await page.goto(`${BASE}/app/?view=overview`, { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("theme-wallpaper") !== null, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
    const p = await page.evaluate(probe);
    const fetched = served.get(url);
    const painted = p.layerImage.includes(url) && p.layerOpacity > 0 && (p.layerBox?.[0] || 0) > 0;
    ok(`wallpaper ${title} is painted`, painted, `image=${p.layerImage.slice(0, 60)} opacity=${p.layerOpacity} box=${p.layerBox}`);
    ok(`wallpaper ${title} image loads`, fetched === 200, `status=${fetched}`);
    await page.screenshot({ path: `${SHOTS}/wp-${vp.name}-${i}.png` });
    results.push({ viewport: vp.name, kind: "wallpaper", id: title, fetched, ...p });
  }

  /* 3. Without a wallpaper the layer is removed. */
  chosen = null;
  await page.goto(`${BASE}/app/?view=overview`, { waitUntil: "load" });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/wp-${vp.name}-none.png` });
  ok("no wallpaper chosen leaves the default page", (await page.evaluate(probe)).wallpaperAttr === null);
  ok("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(results.filter((r) => r.kind === "wallpaper" && r.viewport === "desktop").map((r) => [r.id, r.fetched, r.layerOpacity, r.layerBox])));
console.log(bad ? `FAILED ${bad}` : "PASSED");
process.exit(bad ? 1 : 0);
