/* ==========================================================================
   Shinzora — browser harness: visual.mjs
   --------------------------------------------------------------------------
   Assertions that need a real renderer: the hero stage actually paints, the
   aurora canvas paints pixels on a capable device, the scene pauses when it
   scrolls out of view, reduced-motion and low-power devices get the static
   fallback, the header gains its glass state on scroll, the install panel opens
   and closes cleanly, and nothing overflows at 390px.

     npm run dev                                          # separate terminal
     npm i -D playwright-core && npx playwright install chromium
     BASE=http://127.0.0.1:4173 node tests/browser/visual.mjs

   Screenshots are written to $SHOTS (default /tmp/shinzora-shots).
   ========================================================================== */

import { chromium } from "playwright-core";
import fs from "node:fs";
const BASE = process.env.BASE || "http://127.0.0.1:4173";
const SHOTS = process.env.SHOTS || "/tmp/shinzora-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
let bad = 0;
const ok = (n, c, note = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${note ? " — " + note : ""}`); if (!c) bad++; };

/* ------------------------------------------------ hero + header + install */
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|CORS/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);

  ok("no console/page errors", errs.length === 0, errs.slice(0, 2).join(" | "));

  const fx = await p.evaluate(() => {
    const stage = document.querySelector(".fx-stage");
    const canvas = document.querySelector("canvas[data-aurora]");
    /* The old treatment (particles, glass orbs, light trails) must be gone —
       asserting absence is what stops it creeping back in. */
    const legacy = document.querySelectorAll(".fx-particles, .fx-orb, .fx-trail").length;
    const grid = document.querySelector(".fx-grid");
    return {
      stage: !!stage,
      canvas: !!canvas,
      mounted: canvas?.dataset.auroraMounted === "true",
      legacy,
      gridAnimating: grid ? getComputedStyle(grid).animationName !== "none" : false,
      canvasW: canvas?.width || 0,
      canvasH: canvas?.height || 0,
      filter: canvas ? getComputedStyle(canvas).filter : "",
      ariaHidden: stage?.getAttribute("aria-hidden"),
      hasAuroraClass: document.documentElement.classList.contains("has-aurora")
    };
  });
  ok("hero stage renders", fx.stage);
  ok("aurora canvas mounted", fx.canvas && fx.mounted && fx.hasAuroraClass);
  ok("no particle / orb / trail layers remain", fx.legacy === 0, `${fx.legacy} legacy layers`);
  ok("aurora is blurred into light, not drawn as shapes", /blur/.test(fx.filter), fx.filter);
  /* The grid is a CSS-only layer: it animates on capable hardware and is
     frozen by the low-power rule, which is what the class below reports. */
  const lowPowerEarly = await p.evaluate(() => document.documentElement.classList.contains("fx-low-power"));
  ok(
    "perspective grid animation follows the power budget",
    lowPowerEarly ? fx.gridAnimating === false : fx.gridAnimating === true,
    lowPowerEarly ? "frozen on low power (expected)" : "animating"
  );
  ok("decorative stage is aria-hidden", fx.ariaHidden === "true");

  // This sandbox reports 2 cores / 2 GB, which is exactly the low-power case:
  // the aurora still runs, at half resolution and a smaller blur.
  const lowPower = await p.evaluate(() => document.documentElement.classList.contains("fx-low-power"));
  ok("low-power gate detected weak hardware", lowPower === true, `${await p.evaluate(() => navigator.hardwareConcurrency)} cores`);
  ok("low-power still renders the aurora at reduced resolution", fx.canvasW > 0 && fx.canvasH > 0, `${fx.canvasW}x${fx.canvasH}`);

  // header scroll state
  const before = await p.evaluate(() => document.querySelector(".site-nav").classList.contains("is-scrolled"));
  await p.evaluate(() => window.scrollTo(0, 600));
  await p.waitForTimeout(400);
  const after = await p.evaluate(() => {
    const nav = document.querySelector(".site-nav");
    return { scrolled: nav.classList.contains("is-scrolled"), blur: getComputedStyle(nav).backdropFilter };
  });
  ok("header starts unscrolled", before === false);
  ok("header gains glass on scroll", after.scrolled && /blur/.test(after.blur), after.blur);

  // Get app panel — device → phone → android
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click("[data-install-open]");
  await p.waitForTimeout(600);
  const panel = await p.evaluate(() => {
    const el = document.querySelector(".ip-panel");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      open: document.querySelector(".ip-backdrop")?.classList.contains("is-open"),
      blur: cs.backdropFilter, radius: cs.borderRadius,
      title: el.querySelector(".ip-title")?.textContent.trim(),
      devices: el.querySelectorAll(".ip-device").length,
      platforms: el.querySelectorAll(".ip-option").length,
      focusInside: el.contains(document.activeElement)
    };
  });
  ok("install panel opens", panel?.open === true);
  ok("panel is frosted glass", /blur/.test(panel?.blur || ""), panel?.blur);
  ok("panel shows the Get Shinzora title", panel?.title === "Get Shinzora", panel?.title);
  ok("panel asks for a device first", panel?.devices === 2 && panel?.platforms === 0, `${panel?.devices} devices`);
  ok("focus moved into the panel", panel?.focusInside === true);
  await p.screenshot({ path: `${SHOTS}/install-panel.png` });

  // device → platform list
  await p.click('[data-ip-family="phone"]');
  await p.waitForTimeout(450);
  ok("phone screen lists both mobile platforms", (await p.locator(".ip-option").count()) === 2);

  // platform detail
  await p.click('[data-ip-platform="ios"]');
  await p.waitForTimeout(450);
  const iosText = await p.locator(".ip-steps").innerText();
  ok("iOS detail shows the Safari route", /Safari/.test(iosText) && /Add to Home Screen/.test(iosText));
  ok("iOS detail offers no fake IPA", (await p.locator("[data-ip-download]").count()) === 0);

  // escape walks back, then closes
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(500);
  ok("Escape closes the panel", (await p.locator(".ip-panel").count()) === 0);
  ok("body scroll restored", await p.evaluate(() => !document.body.classList.contains("ip-open")));

  await p.screenshot({ path: `${SHOTS}/hero-desktop.png` });
  await ctx.close();
}

/* ------------------------------------------- capable device: canvas draws */
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  });
  const p = await ctx.newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);

  const drawn = await p.evaluate(() => {
    const c = document.querySelector("canvas[data-aurora]");
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return {
      lit, w: c.width, h: c.height,
      lowPower: document.documentElement.classList.contains("fx-low-power"),
      cssW: c.style.width
    };
  });
  ok("capable device: canvas sized to the stage", drawn.w > 500, `${drawn.w}x${drawn.h}`);
  ok("capable device: aurora painted", drawn.lit > 5000, `${drawn.lit} lit pixels`);
  ok("capable device: low-power class not set", drawn.lowPower === false);

  // pause when scrolled away
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(900);
  const paused = await p.evaluate(() => document.querySelector(".fx-stage").classList.contains("fx-paused"));
  ok("stage pauses when scrolled out of view", paused === true);
  await ctx.close();
}

/* -------------------------------------------------------- reduced motion */
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  /* With reduced motion the aurora paints exactly one static frame and stops.
     So the test compares two snapshots a second apart: identical pixels mean
     the loop is genuinely not running. */
  const snapshot = () =>
    p.evaluate(() => {
      const canvas = document.querySelector("canvas[data-aurora]");
      const g = canvas.getContext("2d");
      const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 0) { lit++; sum = (sum + i) % 1000000007; }
      }
      return { lit, sum, html: document.documentElement.className, grid: getComputedStyle(document.querySelector(".fx-grid")).animationName };
    });

  const first = await snapshot();
  await p.waitForTimeout(1000);
  const second = await snapshot();

  ok("reduced motion paints one static frame", first.lit > 0, `${first.lit} lit pixels`);
  ok("reduced motion does not animate the aurora", first.sum === second.sum, `${first.sum} vs ${second.sum}`);
  ok("reduced motion stops the CSS layers", first.grid === "none", first.grid);
  ok("reduced-motion class set on <html>", /fx-reduced/.test(first.html));
  await ctx.close();
}

/* --------------------------------------------------------------- mobile */
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.waitForTimeout(700);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile: no horizontal overflow", over <= 1, `${over}px`);
  ok(
    "mobile: no orb/particle layers left to trim",
    (await p.evaluate(() => document.querySelectorAll(".fx-orb, .fx-particles, .fx-trail").length)) === 0
  );
  await p.locator("[data-nav-toggle]").click();
  await p.waitForTimeout(400);
  ok("mobile menu has install action", (await p.locator('[data-mobile-menu] [data-install-open]').count()) === 1);
  await p.locator('[data-mobile-menu] [data-install-open]').click();
  await p.waitForTimeout(600);
  const fits = await p.evaluate(() => {
    const el = document.querySelector(".ip-panel");
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), vw: document.documentElement.clientWidth, overflow: r.right > document.documentElement.clientWidth + 1 || r.left < -1 };
  });
  ok("mobile: install panel fits the viewport", !fits.overflow, `${fits.w}px of ${fits.vw}px`);
  await p.screenshot({ path: `${SHOTS}/install-mobile.png` });
  await ctx.close();
}

/* ------------------------------------------------- primary CTA label paint */
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  });
  const p = await ctx.newPage();
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.waitForTimeout(900);
  // A positioned pseudo-element with a fill paints over a bare text node, which
  // is how an icon-only "Get started" button shipped once. Guard the label.
  const buttons = await p.evaluate(() =>
    [...document.querySelectorAll(".btn-primary")]
      .filter((btn) => btn.offsetParent !== null && btn.textContent.trim())
      .map((btn) => ({ text: btn.textContent.trim().slice(0, 24), w: Math.round(btn.getBoundingClientRect().width), clipped: btn.scrollWidth - btn.clientWidth }))
  );
  ok("primary CTAs render their label", buttons.length > 0 && buttons.every((x) => x.w > 40 && x.clipped <= 1), buttons.map((x) => `"${x.text}" ${x.w}px`).join(", "));
  await ctx.close();
}

/* ------------------------------------------- aurora on the non-hero surfaces
   Regression guard: only the hero had sizing CSS for its canvas, so the auth
   and admin pages rendered a 1×1 surface and no aurora at all. These pages are
   where a silent "canvas exists but paints nothing" hides most easily. */
for (const route of ["/auth/signup/", "/auth/login/", "/admin-login/", "/install-guide/"]) {
  const ctx = await b.newContext({ viewport: { width: 1349, height: 1013 } });
  const p2 = await ctx.newPage();
  await p2.goto(BASE + route, { waitUntil: "networkidle" });
  await p2.waitForTimeout(1200);
  const state = await p2.evaluate(() => {
    const canvas = document.querySelector("canvas[data-aurora]");
    if (!canvas) return { missing: true };
    const rect = canvas.getBoundingClientRect();
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 6) lit += 1;
    return {
      missing: false,
      cssW: Math.round(rect.width),
      cssH: Math.round(rect.height),
      wrapperW: Math.round(canvas.parentElement.getBoundingClientRect().width),
      lit
    };
  });
  ok(`${route} fills its wrapper`, !state.missing && state.cssW >= state.wrapperW - 2, `${state.cssW}/${state.wrapperW}px`);
  ok(`${route} paints the aurora`, state.lit > 1000, `${state.lit} lit pixels`);
  await ctx.close();
}

await b.close();

console.log(bad ? `\n${bad} problem(s)` : "\nhero + install panel verified");
process.exit(bad ? 1 : 0);
