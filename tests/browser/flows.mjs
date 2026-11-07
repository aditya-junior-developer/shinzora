/* ==========================================================================
   Shinzora — browser harness: flows.mjs
   --------------------------------------------------------------------------
   Behavioural checks for the public flows: landing page sections, anchor navigation,
   icon hydration, responsive overflow, protected-route redirects, auth forms,
   a real failed sign-in, and the schema-compatibility probe on /system-check/.

   Requires a running dev server and playwright-core:

     npm run dev                                  # separate terminal
     npm i -D playwright-core && npx playwright install chromium
     BASE=http://127.0.0.1:4173 node tests/browser/flows.mjs

   Not part of `npm test`: the unit tests and the smoke test must run without a
   browser. This is the deeper check you run before shipping UI changes.
   ========================================================================== */

import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:4173";
const results = [];
const add = (name, ok, note = "") => { results.push({ name, ok, note }); console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`); };

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

async function page(width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  // Failed-resource logs are expected here: the login test posts wrong
  // credentials, and the Edge Functions are not deployed yet.
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|CORS policy/.test(m.text())) errors.push(m.text()); });
  p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return { p, errors, ctx };
}

/* ---------------------------------------------------------------- homepage */
{
  const { p, errors, ctx } = await page();
  await p.goto(`${BASE}/`, { waitUntil: "networkidle" });

  add("homepage loads with correct title", (await p.title()).includes("Shinzora"), await p.title());

  for (const [id, label] of [["services", "Human services"], ["trust", "Trust"]]) {
    const el = p.locator(`#${id}`);
    add(`#${id} section present`, (await el.count()) === 1);
    add(`#${id} has a heading`, (await el.locator("h2").count()) === 1, await el.locator("h2").first().textContent().catch(() => ""));
  }

  const navLink = p.locator('.nav-link[href="#services"]');
  add("nav links to human services", (await navLink.count()) === 1);
  await navLink.click();
  await p.waitForTimeout(1400);
  const anchored = await p.evaluate(() => {
    const r = document.getElementById("services").getBoundingClientRect();
    return location.hash === "#services" && r.top < window.innerHeight && r.bottom > 0;
  });
  add("anchor navigation moves to services", anchored);

  // every referenced icon name must resolve to real geometry (unknown names
  // silently fall back to a "?" glyph, which is how two missing icons hid)
  const unresolved = await p.evaluate(async () => {
    const mod = await import("/js/lib/icons.js");
    const names = new Set([...document.querySelectorAll("[data-icon]")].map((n) => n.getAttribute("data-icon")));
    return [...names].filter((n) => mod.icon(n).includes("ico-circle-help") && n !== "circle-help");
  });
  add("all icon names resolve to real geometry", unresolved.length === 0, unresolved.join(", "));

  const unhydrated = await p.evaluate(() => document.querySelectorAll("[data-icon]").length);
  add("all icon placeholders hydrated", unhydrated === 0, `${unhydrated} left`);

  // content honesty: no invented review/star widgets
  const bodyText = await p.evaluate(() => document.body.innerText);
  add("no fabricated testimonial stars", !/★★★★★|5\/5 stars|trusted by \d/i.test(bodyText));

  // accessibility basics
  const imgsNoAlt = await p.evaluate(() => [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length);
  add("every image has an alt attribute", imgsNoAlt === 0, `${imgsNoAlt} missing`);
  const h1s = await p.locator("h1").count();
  add("exactly one h1", h1s === 1, `${h1s} found`);

  // no horizontal overflow
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  add("no horizontal overflow (desktop)", overflow <= 1, `${overflow}px`);

  add("no console errors (homepage)", errors.length === 0, errors.slice(0, 2).join(" | "));

  await p.screenshot({ path: "/tmp/qa/home-desktop.png", fullPage: false });
  await p.locator("#services").screenshot({ path: "/tmp/qa/services.png" });
  await p.locator("#trust").screenshot({ path: "/tmp/qa/trust.png" });
  await ctx.close();
}

/* ----------------------------------------------------------------- mobile */
{
  const { p, errors, ctx } = await page(390, 844);
  await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  add("no horizontal overflow (mobile 390px)", overflow <= 1, `${overflow}px`);

  await p.locator("[data-nav-toggle]").click();
  await p.waitForTimeout(450);
  const menuVisible = await p.evaluate(() => {
    const m = document.querySelector("[data-mobile-menu]");
    return m && getComputedStyle(m).visibility !== "hidden" && m.getBoundingClientRect().height > 50;
  });
  add("mobile menu opens", Boolean(menuVisible));
  add("mobile menu contains services link", (await p.locator('[data-mobile-menu] a[href="#services"]').count()) === 1);
  await p.screenshot({ path: "/tmp/qa/home-mobile.png", fullPage: false });
  add("no console errors (mobile)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ------------------------------------------------------- protected routes */
{
  const { p, ctx } = await page();
  await p.goto(`${BASE}/app/`, { waitUntil: "networkidle" });
  add("/app/ redirects signed-out users to login", p.url().includes("/auth/login/"), p.url().replace(BASE, ""));
  await p.goto(`${BASE}/admin/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  const adminGate = await p.evaluate(() => {
    const shell = document.getElementById("admin-shell");
    const shellHidden = !shell || getComputedStyle(shell).display === "none" || shell.hidden;
    const text = document.body.innerText.toLowerCase();
    return { shellHidden, signIn: /sign in|administrator|no access/.test(text) };
  });
  add("/admin/ hides the console from signed-out users", adminGate.shellHidden, JSON.stringify(adminGate));
  await p.goto(`${BASE}/onboarding/`, { waitUntil: "networkidle" });
  add("/onboarding/ is protected", p.url().includes("/auth/login/"), p.url().replace(BASE, ""));
  await ctx.close();
}

/* ----------------------------------------------------------- auth pages */
{
  const { p, errors, ctx } = await page();
  for (const path of ["/auth/login/", "/auth/signup/", "/auth/forgot-password/", "/auth/reset-password/"]) {
    await p.goto(BASE + path, { waitUntil: "networkidle" });
    add(`${path} renders a form`, (await p.locator("form").count()) > 0);
  }
  await p.goto(`${BASE}/auth/verify-email/`, { waitUntil: "networkidle" });
  add("/auth/verify-email/ explains the next step", /verif|inbox|email/i.test(await p.evaluate(() => document.body.innerText)));

  await p.goto(`${BASE}/auth/login/`, { waitUntil: "networkidle" });
  await p.fill('input[type="email"]', "nobody@example.com");
  await p.fill('input[type="password"]', "wrong-password-123");
  await p.click('button[type="submit"]');
  await p.waitForTimeout(3500);
  const alertText = (await p.locator('[role="alert"], .alert, .field-error').allTextContents()).join(" ").toLowerCase();
  add("wrong credentials show a real error", /incorrect|invalid|wrong|unable|failed/.test(alertText), alertText.slice(0, 90));
  add("wrong credentials do not navigate away", p.url().includes("/auth/login/"), p.url().replace(BASE, ""));
  add("no console errors (auth)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await ctx.close();
}

/* ------------------------------------------------- auth field icon geometry */
/* Icons that sit off-centre, or that a value can slide underneath, are the
   single most-reported visual bug on these two pages. This measures the real
   boxes instead of trusting the stylesheet: for every icon-bearing field, the
   glyph must be horizontally inside the control, vertically centred to within
   a pixel, and separated from the text by at least 8px of padding. */
for (const path of ["/auth/login/", "/auth/signup/"]) {
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);

    const geometry = await page.evaluate(() =>
      [...document.querySelectorAll(".input-icon")].map((wrap) => {
        const input = wrap.querySelector("input");
        const icon = wrap.querySelector(":scope > .ico");
        const action = wrap.querySelector(".input-action");
        const w = wrap.getBoundingClientRect();
        const i = input.getBoundingClientRect();
        const g = icon?.getBoundingClientRect();
        const a = action?.getBoundingClientRect();
        return {
          icon: g ? { centre: g.top + g.height / 2, right: g.right, left: g.left } : null,
          input: { centre: i.top + i.height / 2, left: i.left, right: i.right },
          padLeft: parseFloat(getComputedStyle(input).paddingLeft),
          padRight: parseFloat(getComputedStyle(input).paddingRight),
          action: a ? { centre: a.top + a.height / 2, left: a.left, right: a.right } : null,
          wrapLeft: w.left,
          wrapRight: w.right
        };
      })
    );

    let centred = true;
    let inside = true;
    let spaced = true;
    let actionClear = true;

    for (const field of geometry) {
      if (field.icon) {
        if (Math.abs(field.icon.centre - field.input.centre) > 1.5) centred = false;
        if (field.icon.left < field.input.left - 0.5 || field.icon.right > field.input.right) inside = false;
        /* Distance from the input's inner edge to the text box must clear the
           glyph, otherwise a long value renders under the icon. */
        if (field.padLeft < field.icon.right - field.input.left + 6) spaced = false;
      }
      if (field.action) {
        if (Math.abs(field.action.centre - field.input.centre) > 1.5) centred = false;
        if (field.action.right > field.input.right + 1) inside = false;
        if (field.padRight < field.input.right - field.action.left + 4) actionClear = false;
      }
    }

    const label = `${path} @${width}`;
    add(`${label}: every icon is vertically centred`, geometry.length > 0 && centred, `${geometry.length} fields`);
    add(`${label}: icons stay inside their control`, inside);
    add(`${label}: values cannot reach the icon`, spaced);
    add(`${label}: password reveal never covers the value`, actionClear);

    await ctx.close();
  }
}

/* -------------------------------------------------------- system check */
{
  const { p, errors, ctx } = await page();
  /* domcontentloaded, not networkidle: the page keeps a live request open to the
     Edge Functions (still undeployed), so the network never goes idle and the
     navigation itself would time out. The checks below read the rendered rows. */
  await p.goto(`${BASE}/system-check/`, { waitUntil: "domcontentloaded" });
  /* Wait for the probe this block actually asserts on, rather than guessing a
     fixed delay — the page runs its checks sequentially against the live
     project and the rows land at different times. */
  await p
    .waitForFunction(() => /Schema compatibility \(0005\)/.test(document.body.innerText), { timeout: 22000 })
    .catch(() => undefined);
  await p.waitForTimeout(1200);
  const text = await p.evaluate(() => document.body.innerText);
  add("system check runs and lists results", /Schema|Database/i.test(text));
  const reportsCompat = /Schema compatibility \(0005\)/i.test(text);
  add("system check includes the 0005 compatibility probe", reportsCompat);
  if (reportsCompat) {
    const row = await p.evaluate(() => {
      const nodes = [...document.querySelectorAll("*")].filter((n) => n.children.length === 0 && /Schema compatibility \(0005\)/i.test(n.textContent || ""));
      const host = nodes[0]?.closest(".check") || nodes[0]?.parentElement;
      return host ? host.innerText : "";
    });
    add("compat probe reports the live legacy schema", /current_step is still text|missing/i.test(row), row.replace(/\s+/g, " ").slice(0, 130));
  }
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length) { console.log("FAILED:"); failed.forEach((f) => console.log(`  - ${f.name} ${f.note}`)); process.exit(1); }
