/* ==========================================================================
   The whole site in one file — route sweep, in a real browser.
   --------------------------------------------------------------------------
   Opens shinzora-full.html over file:// and visits all 22 routes. Each must
   mount real content, keep the router inside the file, and raise no page
   error. Protected routes (/app/, /admin/, /onboarding/) are expected to land
   on #/auth/login/ — that is the guard doing its job, not a failure.

       node scripts/build-single-file-app.mjs --out ../shinzora-full.html
       cd shinzora && npx playwright-core install chromium
       node tests/browser/single-file-app.mjs
   ========================================================================== */
import { chromium } from "playwright-core";
const routes = ["/", "/404.html", "/admin-login/", "/admin/", "/app/", "/auth/callback/", "/auth/forgot-password/", "/auth/login/", "/auth/reset-password/", "/auth/signup/", "/auth/verify-email/", "/docs/", "/download/", "/install-guide/", "/install/", "/legal/acceptable-use/", "/legal/privacy/", "/legal/refunds/", "/legal/terms/", "/onboarding/", "/site/", "/system-check/"];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
let ok = 0, bad = 0;
for (const route of routes) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message.split("\n")[0].slice(0, 90)));
  page.on("requestfailed", (r) => { if (!r.url().startsWith("http")) errs.push("net:" + r.url().slice(0, 60)); });
  await page.goto("file:///home/user/shinzora-full.html#" + route, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    root: !!document.getElementById("sf-root"),
    nodes: document.getElementById("sf-root") ? document.getElementById("sf-root").children.length : -1,
    len: (document.body.innerText || "").length,
    where: location.hash.slice(0, 34),
    title: document.title.slice(0, 34)
  }));
  const pass = r.root && r.nodes > 0 && r.len > 40 && errs.length === 0;
  pass ? ok++ : bad++;
  console.log(`${pass ? "PASS" : "FAIL"} ${route.padEnd(24)} nodes=${r.nodes} text=${String(r.len).padEnd(4)} at=${r.where.padEnd(24)} err=${errs.length ? errs[0] : "-"}`);
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed of ${routes.length}`);
await browser.close();
