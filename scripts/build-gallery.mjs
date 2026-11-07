/* ==========================================================================
   Shinzora — review gallery
   --------------------------------------------------------------------------
   Captures the states that changed in this update straight from the running
   dev server and writes a single self-contained HTML file (every image is a
   base64 JPEG data URI, so it opens from disk with no server and no assets).

     npm run dev                                  # separate terminal
     BASE=http://127.0.0.1:4173 node scripts/build-gallery.mjs

   Output: /home/user/preview/gallery.html (override with OUT).
   ========================================================================== */

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const OUT = process.env.OUT || "/home/user/preview/gallery.html";
const QUALITY = 72;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

const shots = [];
async function capture(group, caption, width, height, run, options = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ...options });
  const page = await ctx.newPage();
  try {
    await run(page);
    const buffer = await page.screenshot({ type: "jpeg", quality: QUALITY, fullPage: options.fullPage === true });
    shots.push({ group, caption, width, height, data: buffer.toString("base64") });
    console.log(`  ✓ ${group} — ${caption}`);
  } catch (error) {
    console.log(`  ✗ ${group} — ${caption}: ${error.message}`);
  }
  await ctx.close();
}

const goto = (page, route) => page.goto(BASE + route, { waitUntil: "networkidle", timeout: 45000 });

/* ---------------------------------------------------------- aurora motion */
for (const [label, wait] of [["frame 1", 1200], ["frame 2", 2600]]) {
  await capture(
    "Landing hero — purple flame aurora",
    `Five violet ribbons on canvas · ${label} (captured ${(wait / 1000).toFixed(1)} s after load)`,
    1440,
    900,
    async (page) => {
      await goto(page, "/");
      await page.waitForTimeout(wait);
    }
  );
}

/* ------------------------------------------------------- logo alignment */
await capture(
  "Auth — logo alignment",
  "Signup, 1440×900: the wordmark sits at a constant 24 px from the top and its left edge lines up with the headline.",
  1440,
  900,
  async (page) => {
    await goto(page, "/auth/signup/");
    await page.waitForTimeout(1200);
  }
);
await capture(
  "Auth — logo alignment",
  "Signup, 1280×700: the tallest-content breakpoint. The aside is pinned to the viewport instead of scrolling the mark off screen.",
  1280,
  700,
  async (page) => {
    await goto(page, "/auth/signup/");
    await page.waitForTimeout(1200);
  }
);

/* -------------------------------------------------------- download centre */
const openPanel = async (page) => {
  await goto(page, "/");
  await page.click(".site-nav [data-install-open]");
  await page.waitForSelector(".ip-backdrop.is-open");
  await page.waitForTimeout(700);
};
const openMobilePanel = async (page) => {
  await goto(page, "/");
  await page.click("[data-nav-toggle]");
  await page.waitForTimeout(350);
  await page.click("#mobile-menu [data-install-open]");
  await page.waitForSelector(".ip-backdrop.is-open");
  await page.waitForTimeout(700);
};

await capture("Get app — download centre", "Screen 1 — device choice: Phone or Computer.", 1440, 900, openPanel);
await capture("Get app — download centre", "Screen 2 — Phone: Android and iOS, each marked with its real install route.", 1440, 900, async (page) => {
  await openPanel(page);
  await page.click('[data-ip-family="phone"]');
  await page.waitForTimeout(650);
});
await capture("Get app — download centre", "Screen 3 — Android: no APK is published, so the panel says so and shows the Chrome route instead of a dead download button.", 1440, 900, async (page) => {
  await openPanel(page);
  await page.click('[data-ip-family="phone"]');
  await page.waitForTimeout(600);
  await page.click('[data-ip-platform="android"]');
  await page.waitForTimeout(650);
});
await capture("Get app — download centre", "Screen 2 — Computer: Windows, macOS and Linux, each with the format it would ship as.", 1440, 900, async (page) => {
  await openPanel(page);
  await page.click('[data-ip-family="computer"]');
  await page.waitForTimeout(650);
});
await capture("Get app — download centre", "Screen 3 — macOS: the guide sentence sits directly under the options, only the word “link” is clickable, and it opens in a new tab.", 390, 844, async (page) => {
  await openMobilePanel(page);
  await page.click('[data-ip-family="computer"]');
  await page.waitForTimeout(600);
  await page.click('[data-ip-platform="macos"]');
  await page.waitForTimeout(650);
}, { isMobile: true, hasTouch: true });
await capture("Get app — download centre", "Tablet width — the same flow at 768 px.", 768, 1024, async (page) => {
  await openPanel(page);
  await page.click('[data-ip-family="phone"]');
  await page.waitForTimeout(650);
});

/* ------------------------------------------------------------ setup guide */
await capture("Setup guide — /install-guide/", "The standalone guide: sticky platform nav, five sections, numbered steps, honest callouts where no native package exists.", 1440, 900, async (page) => {
  await goto(page, "/install-guide/");
  await page.waitForTimeout(1400);
});
await capture("Setup guide — /install-guide/", "The same page on a phone: single column, nav collapses to the wordmark and a back link.", 390, 844, async (page) => {
  await goto(page, "/install-guide/");
  await page.waitForTimeout(1400);
}, { isMobile: true, hasTouch: true, fullPage: true });

await browser.close();

const groups = [...new Set(shots.map((s) => s.group))];
const body = groups
  .map((group) => {
    const items = shots.filter((s) => s.group === group);
    return `  <section>
    <header><h2>${group}</h2></header>
${items
  .map(
    (s) => `    <figure>
      <img alt="${s.caption.replace(/"/g, "&quot;")}" src="data:image/jpeg;base64,${s.data}">
      <figcaption>${s.caption} <span class="dim">${s.width}×${s.height}</span></figcaption>
    </figure>`
  )
  .join("\n")}
  </section>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shinzora — Get app redesign, in pictures</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#08060d; color:#f4f1fb; font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:48px 24px 80px; }
  .eyebrow { font-size:11px; letter-spacing:.22em; text-transform:uppercase; color:#b9a6ff; margin:0 0 10px; }
  h1 { font-size:clamp(26px,4vw,40px); line-height:1.15; margin:0 0 12px; font-weight:650; letter-spacing:-.02em; }
  .lede { color:#b6aecb; max-width:74ch; margin:0 0 36px; }
  section { margin:0 0 56px; }
  h2 { font-size:19px; margin:0 0 16px; font-weight:600; letter-spacing:-.01em; }
  figure { margin:0 0 22px; border-radius:14px; overflow:hidden; border:1px solid rgba(150,120,255,.22);
            background:linear-gradient(180deg,rgba(124,58,237,.10),rgba(8,6,13,0)); box-shadow:0 24px 60px -30px rgba(124,58,237,.55); }
  img { display:block; width:100%; height:auto; }
  figcaption { padding:12px 16px; font-size:13px; color:#cfc6e4; border-top:1px solid rgba(150,120,255,.16); }
  .dim { color:#8a8199; font-variant-numeric:tabular-nums; }
  code { background:rgba(255,255,255,.07); padding:1px 5px; border-radius:5px; font-size:12.5px; }
</style></head>
<body><div class="wrap">
  <p class="eyebrow">Shinzora · November 2026</p>
  <h1>Get app, rebuilt — and the setup guide that goes with it</h1>
  <p class="lede">Every frame below is a screenshot of the running site, taken by <code>scripts/build-gallery.mjs</code>.
  The behaviour behind them is asserted in <code>tests/browser/install-flow.mjs</code>: the flow, the Back and Escape order,
  the guide opening in a new tab, the absence of fake download buttons, a real streamed download against a seeded build
  registry, and the 390 / 768 / 1440 layouts.</p>
${body}
</div></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`\n  ✓ ${OUT}  (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB, ${shots.length} frames)`);
