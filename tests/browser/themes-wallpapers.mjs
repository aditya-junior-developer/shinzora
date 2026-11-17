/* ==========================================================================
   Shinzora — browser harness: every theme and every wallpaper (brief 3)
   --------------------------------------------------------------------------
     - the six palettes are gone: no picker, and the default design is what shows
     - each Glow and Elite wallpaper, chosen by an Elite member, is painted:
       its image is fetched with status 200 and the layer is visible on the page
   - a Glow member sees Elite as previews only: they open, and they cannot be applied
   - a free member sees both collections locked, with previews and no applied design
   - a saved choice on a retired design falls back to the default background
     - no page errors at 390, 820 and 1440 px

     BASE=http://127.0.0.1:4173 node tests/browser/themes-wallpapers.mjs
   ========================================================================== */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/home/user/shots-themes";
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

/* The real catalogue (0078): two collections, four designs each. The tier of the
   signed-in member decides what is locked; locked designs keep their preview URL,
   as theme_catalog() returns them. */
const WALLPAPERS = [
  ["glow", "Glow", "glow", "Glow I · Glass home", "/assets/themes/glow-01.jpg"],
  ["glow", "Glow", "glow", "Glow II · Smart home", "/assets/themes/glow-02.jpg"],
  ["glow", "Glow", "glow", "Glow III · Stormy skies", "/assets/themes/glow-03.jpg"],
  ["glow", "Glow", "glow", "Glow IV · Golden weather", "/assets/themes/glow-04.jpg"],
  ["elite", "Elite", "elite", "Elite I · Violet analytics", "/assets/themes/elite-01.jpg"],
  ["elite", "Elite", "elite", "Elite II · Ember games", "/assets/themes/elite-02.jpg"],
  ["elite", "Elite", "elite", "Elite III · Amber finance", "/assets/themes/elite-03.jpg"],
  ["elite", "Elite", "elite", "Elite IV · Plum investing", "/assets/themes/elite-04.jpg"]
];
const RANK = { glow: 1, elite: 2 };
const wid = (i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
let chosen = null;
let tier = "elite"; // the signed-in member's tier: "elite", "glow" or null
let retiredChoice = null; // a saved id that no longer exists in the catalogue
function catalog() {
  const rank = tier === "elite" ? 2 : tier === "glow" ? 1 : 0;
  const map = new Map();
  WALLPAPERS.forEach(([cid, cname, required, title, url], i) => {
    if (!map.has(cid)) map.set(cid, { id: cid, name: cname, description: "", requiredTier: required, locked: RANK[required] > rank, wallpapers: [] });
    map.get(cid).wallpapers.push({ id: wid(i), title, imageUrl: url, previewOnly: RANK[required] > rank });
  });
  return { collections: [...map.values()], chosenWallpaperId: chosen ?? retiredChoice, tier };
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

  /* 1. The six palettes and their picker are gone: Settings offers no colour
     choice, and the page keeps the purple-and-black default. */
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.locator('[data-section="appearance"]').first().click();
  await page.waitForSelector("#wallpaper-body", { timeout: 20000 });
  const picker = await page.evaluate(() => ({
    choices: document.querySelectorAll("[data-theme-choice]").length,
    palettesText: /Midnight|Blossom|Daylight|Nebula|Grove|Porcelain/.test(document.querySelector("#settings-body")?.textContent || "")
  }));
  ok("no palette picker in Settings", picker.choices === 0, `choices=${picker.choices}`);
  ok("no palette names shown in Settings", picker.palettesText === false);
  const defaultLook = await page.evaluate(probe);
  ok("the page keeps the default design (no palette attribute)", defaultLook.theme === "midnight" && defaultLook.tone === null, `theme=${defaultLook.theme} tone=${defaultLook.tone}`);
  ok("the default page background is dark purple-black", /rgb\((\d+), (\d+), (\d+)\)/.test(defaultLook.body) && (() => {
    const [r, g, b] = defaultLook.body.match(/\d+/g).map(Number);
    return r + g + b < 120;
  })(), `body=${defaultLook.body}`);
  results.push({ viewport: vp.name, kind: "default", ...defaultLook });

  /* 2. An Elite member applies every design; each one is painted on the dashboard. */
  tier = "elite";
  for (let i = 0; i < WALLPAPERS.length; i++) {
    const [, , , title, url] = WALLPAPERS[i];
    chosen = wid(i);
    retiredChoice = null;
    served.delete(url);
    await page.goto(`${BASE}/app/?view=overview`, { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("theme-wallpaper") !== null, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(700);
    const p = await page.evaluate(probe);
    const fetched = served.get(url);
    const painted = p.layerImage.includes(url) && p.layerOpacity > 0 && (p.layerBox?.[0] || 0) > 0;
    ok(`Elite applies ${title}: painted`, painted, `image=${p.layerImage.slice(0, 60)} opacity=${p.layerOpacity} box=${p.layerBox}`);
    ok(`Elite applies ${title}: image loads`, fetched === 200, `status=${fetched}`);
    await page.screenshot({ path: `${SHOTS}/wp-${vp.name}-${i}.png` });
    results.push({ viewport: vp.name, kind: "wallpaper", id: title, fetched, ...p });
  }

  /* 3. A Glow member: Glow applies, Elite is preview-only. */
  tier = "glow";
  chosen = null;
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.locator('[data-section="appearance"]').first().click();
  await page.waitForSelector("#wallpaper-body .wallpaper-collection", { timeout: 20000 });
  const glowState = await page.evaluate(() => {
    const sections = [...document.querySelectorAll("#wallpaper-body .wallpaper-collection")];
    const elite = sections.find((s) => s.querySelector("#wc-elite"));
    const glow = sections.find((s) => s.querySelector("#wc-glow"));
    return {
      eliteLocked: elite?.classList.contains("is-locked") === true,
      glowOpen: glow ? !glow.classList.contains("is-locked") : false,
      eliteApplyButtons: elite ? elite.querySelectorAll("[data-wallpaper-choice]").length : -1,
      elitePreviews: elite ? elite.querySelectorAll("[data-wallpaper-preview]").length : -1,
      glowApplyButtons: glow ? glow.querySelectorAll("[data-wallpaper-choice]").length : -1
    };
  });
  ok("Glow: the Elite section is locked", glowState.eliteLocked);
  ok("Glow: the Glow section is open", glowState.glowOpen);
  ok("Glow: no Elite design can be applied", glowState.eliteApplyButtons === 0, `buttons=${glowState.eliteApplyButtons}`);
  ok("Glow: all four Elite designs have a preview", glowState.elitePreviews === 4, `previews=${glowState.elitePreviews}`);
  ok("Glow: all four Glow designs can be applied", glowState.glowApplyButtons === 4, `buttons=${glowState.glowApplyButtons}`);
  await page.locator('[data-wallpaper-preview]').first().click();
  await page.waitForSelector("dialog.wallpaper-preview[open]", { timeout: 5000 });
  const dialogInfo = await page.evaluate(() => {
    const d = document.querySelector("dialog.wallpaper-preview");
    const img = d?.querySelector("img");
    return {
      src: img?.getAttribute("src") || "",
      loaded: img ? img.complete && img.naturalWidth > 0 : false,
      unlockHref: d?.querySelector("a")?.getAttribute("href") || "",
      sameProportion: img ? Math.abs(img.getBoundingClientRect().width / img.getBoundingClientRect().height - img.naturalWidth / img.naturalHeight) < 0.02 : false
    };
  });
  ok("Glow: the Elite preview opens with its artwork", dialogInfo.src.startsWith("/assets/themes/elite-") && dialogInfo.loaded, JSON.stringify(dialogInfo));
  ok("Glow: the preview keeps the artwork's proportions", dialogInfo.sameProportion);
  ok("Glow: the preview offers the Billing route", dialogInfo.unlockHref === "/app/?view=billing");
  await page.screenshot({ path: `${SHOTS}/wp-${vp.name}-preview.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  ok("Glow: Escape closes the preview", (await page.locator("dialog.wallpaper-preview[open]").count()) === 0);
  ok("Glow: a preview does not apply a design", (await page.evaluate(probe)).wallpaperAttr === null);

  /* 4. A free member: both sections locked, previews only, nothing applied. */
  tier = null;
  await page.goto(`${BASE}/app/?view=settings`, { waitUntil: "load" });
  await page.locator('[data-section="appearance"]').first().click();
  await page.waitForSelector("#wallpaper-body .wallpaper-collection", { timeout: 20000 });
  const freeState = await page.evaluate(() => ({
    locked: [...document.querySelectorAll("#wallpaper-body .wallpaper-collection:has([id^=\"wc-\"])")].length === 2 && [...document.querySelectorAll("#wallpaper-body .wallpaper-collection:has([id^=\"wc-\"])")].every((s) => s.classList.contains("is-locked")),
    applies: document.querySelectorAll("#wallpaper-body [data-wallpaper-choice]").length,
    previews: document.querySelectorAll("#wallpaper-body [data-wallpaper-preview]").length
  }));
  ok("free member: both collections locked", freeState.locked);
  ok("free member: no design can be applied", freeState.applies === 0, `applies=${freeState.applies}`);
  ok("free member: all eight designs have a preview", freeState.previews === 8, `previews=${freeState.previews}`);

  /* 5. A saved choice on a design that no longer exists falls back to the default. */
  tier = "elite";
  retiredChoice = "00000000-0000-4000-8000-0000000000ff";
  chosen = null;
  await page.goto(`${BASE}/app/?view=overview`, { waitUntil: "load" });
  await page.waitForTimeout(700);
  ok("a retired saved choice shows the default background", (await page.evaluate(probe)).wallpaperAttr === null);
  retiredChoice = null;

  /* 6. No wallpaper: the layer is removed and the page stays usable. */
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
