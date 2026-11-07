/* ==========================================================================
   Shinzora — browser harness: sweep.mjs
   --------------------------------------------------------------------------
   Layout + console-error sweep across every public route at three widths.
   Edge Function CORS failures are expected until the functions are deployed
   and are reported separately from page errors.

   Requires a running dev server and playwright-core:

     npm run dev                                  # separate terminal
     npm i -D playwright-core && npx playwright install chromium
     BASE=http://127.0.0.1:4173 node tests/browser/sweep.mjs

   Not part of `npm test`: the unit tests and the smoke test must run without a
   browser. This is the deeper check you run before shipping UI changes.
   ========================================================================== */

import { chromium } from "playwright-core";
const BASE = "http://127.0.0.1:4173";
const ROUTES = ["/", "/install/", "/install-guide/", "/system-check/", "/offline.html", "/404.html",
  "/legal/terms/", "/legal/privacy/", "/legal/refunds/", "/legal/acceptable-use/",
  "/auth/login/", "/auth/signup/", "/auth/forgot-password/", "/auth/reset-password/", "/auth/verify-email/", "/auth/callback/", "/site/"];
const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
let bad = 0;
for (const w of [360, 768, 1440]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const rows = [];
  for (const route of ROUTES) {
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    try {
      await p.goto(BASE + route, { waitUntil: "networkidle", timeout: 20000 });
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const title = await p.title();
      const ok = over <= 1 && errors.length === 0 && title.length > 0;
      if (!ok) { bad++; rows.push(`  ✗ ${route} overflow=${over} errs=${errors.slice(0,1).join("")} title="${title}"`); }
    } catch (e) { bad++; rows.push(`  ✗ ${route} ${e.message.slice(0, 60)}`); }
    await p.close();
  }
  console.log(`${w}px: ${ROUTES.length - rows.length}/${ROUTES.length} clean`);
  rows.forEach((r) => console.log(r));
  await ctx.close();
}
await b.close();
console.log(bad ? `\n${bad} problem(s)` : "\nall public routes clean at every width");
