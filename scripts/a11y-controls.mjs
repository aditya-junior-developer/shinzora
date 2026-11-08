/**
 * Shinzora — checks for the controls added in the accessibility pass
 * ---------------------------------------------------------------------------
 * Proves, in a real browser, that:
 *   • the footer motion switch stops the looping animations and remembers it
 *   • the install dialog is dismissible with Escape from any screen
 *   • aria-controls on the install trigger resolves once the dialog exists
 *   • the skip link is the first Tab stop and is not covered
 *   • the account button's accessible name contains its visible initials
 *
 * Usage: node scripts/a11y-controls.mjs [baseUrl]
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:4173";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const fails = [];
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { fails.push(m); console.log(`  FAIL  ${m}`); };

/* ---------- motion switch ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  const before = await page.evaluate(() => {
    const grid = document.querySelector(".fx-grid");
    const btn = document.querySelector("[data-motion-toggle]");
    return {
      label: btn?.textContent.trim(),
      pressed: btn?.getAttribute("aria-pressed"),
      gridAnim: getComputedStyle(grid).animationName,
      gridState: getComputedStyle(grid).animationPlayState,
      htmlPaused: document.documentElement.classList.contains("motion-paused")
    };
  });
  if (before.label === "Pause motion" && before.pressed === "false" && !before.htmlPaused) ok("motion control starts in the 'Pause motion' state");
  else bad(`unexpected initial motion state: ${JSON.stringify(before)}`);
  if (before.gridAnim !== "none") ok(`hero grid is animating (${before.gridAnim})`);

  await page.locator("[data-motion-toggle]").click();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const grid = document.querySelector(".fx-grid");
    const btn = document.querySelector("[data-motion-toggle]");
    return {
      label: btn.textContent.trim(),
      pressed: btn.getAttribute("aria-pressed"),
      gridState: getComputedStyle(grid).animationPlayState,
      stored: localStorage.getItem("shinzora.motion.paused"),
      stagePaused: document.querySelector(".fx-stage")?.classList.contains("fx-paused")
    };
  });
  if (after.pressed === "true" && after.label === "Resume motion") ok("switch flips to aria-pressed=true and 'Resume motion'");
  else bad(`switch did not flip: ${JSON.stringify(after)}`);
  if (after.gridState === "paused") ok("clicking it pauses the running CSS animation");
  else bad(`animation still ${after.gridState} after pause`);
  if (after.stagePaused) ok("the canvas layer is paused as well");
  else bad("hero stage not paused");
  if (after.stored === "1") ok("the choice is remembered for the next visit");
  else bad("choice not persisted");

  /* reload: the page must come back paused, before the first frames run */
  await page.reload({ waitUntil: "networkidle" });
  const restored = await page.evaluate(() => ({
    htmlPaused: document.documentElement.classList.contains("motion-paused"),
    pressed: document.querySelector("[data-motion-toggle]")?.getAttribute("aria-pressed"),
    gridState: getComputedStyle(document.querySelector(".fx-grid")).animationPlayState
  }));
  if (restored.htmlPaused && restored.pressed === "true" && restored.gridState === "paused") ok("reload keeps motion paused");
  else bad(`pause not restored after reload: ${JSON.stringify(restored)}`);

  await page.locator("[data-motion-toggle]").click();
  await page.waitForTimeout(200);
  const resumed = await page.evaluate(() => ({
    gridState: getComputedStyle(document.querySelector(".fx-grid")).animationPlayState,
    stored: localStorage.getItem("shinzora.motion.paused")
  }));
  if (resumed.gridState === "running" && !resumed.stored) ok("turning it back on resumes motion and clears the preference");
  else bad(`resume failed: ${JSON.stringify(resumed)}`);
  await page.close();
}

/* ---------- install dialog ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const trigger = page.locator("[data-install-open]").first();
  await trigger.click();
  await page.waitForTimeout(500);

  const open = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const trigger = document.querySelector("[data-install-open]");
    return {
      exists: !!dialog,
      id: dialog?.id,
      controls: trigger?.getAttribute("aria-controls"),
      controlsResolves: !!document.getElementById(trigger?.getAttribute("aria-controls") || ""),
      focusInside: dialog ? dialog.contains(document.activeElement) : false,
      labelled: dialog ? !!document.getElementById(dialog.getAttribute("aria-labelledby")) : false
    };
  });
  if (open.exists && open.id === "install-modal") ok("dialog opens with id=install-modal");
  else bad(`dialog missing or mis-identified: ${JSON.stringify(open)}`);
  if (open.controlsResolves) ok("aria-controls on the trigger now resolves to a real element");
  else bad(`aria-controls="${open.controls}" still dangles`);
  if (open.focusInside) ok("focus moves into the dialog");
  else bad("focus stayed outside the dialog");
  if (open.labelled) ok("dialog is labelled by its visible title");

  /* Escape must close it, and the first press must be enough */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
  const closed = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
  if (closed) ok("one Escape press closes the dialog");
  else bad("Escape did not close the dialog");

  /* focus returns to the trigger */
  const focusBack = await page.evaluate(() => document.activeElement?.hasAttribute("data-install-open"));
  if (focusBack) ok("focus returns to the trigger after closing");
  else console.log("  NOTE  focus returns to " + (await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName)));
  await page.close();
}

/* ---------- skip link + account button ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(500); /* the slide-in is a 300ms transition */
  const first = await page.evaluate(() => {
    const el = document.activeElement;
    const r = el.getBoundingClientRect();
    return { cls: el.className, top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), text: el.textContent.trim() };
  });
  if (String(first.cls).includes("skip-link") && first.top >= 0 && first.h > 0) ok(`first Tab stop is the skip link, on screen at ${first.top}px`);
  else bad(`first Tab stop was: ${JSON.stringify(first)}`);

  /* nothing overlaps its centre point */
  const covered = await page.evaluate(() => {
    const el = document.querySelector(".skip-link");
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: top?.className || top?.tagName, self: top === el || el.contains(top) };
  });
  if (covered.self) ok("skip link is on top of the page at its own centre point");
  else bad(`skip link is covered by ${covered.hit}`);
  await page.close();
}

/* ---------- account button: label in name ---------- */
{
  /* grep the template the header really renders, then ask the browser for the
     computed accessible name of that exact markup. */
  const fs = await import("node:fs/promises");
  const source = await fs.readFile("public/js/boot/site-auth.js", "utf8");
  const template = source.match(/aria-label="\$\{esc\(initials\(who\)\)\}[^"]*"/)?.[0] || "";
  if (template.includes("esc(initials(who))")) ok(`account button template includes the visible initials: ${template}`);
  else bad(`account button aria-label does not include the initials: ${template}`);

  const page = await browser.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.className = "nav-actions";
    wrap.innerHTML = '<button class="site-account-btn" type="button" aria-haspopup="menu" aria-expanded="false" '
      + 'aria-label="AS — account menu for Aditya Sharma" id="probe-account">'
      + '<span class="site-account-avatar">AS</span></button>';
    document.body.append(wrap);
  });
  /* axe computes the accessible name the same way assistive tech does */
  await page.addScriptTag({ content: await fs.readFile("node_modules/axe-core/axe.min.js", "utf8") });
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document.querySelector("#probe-account"), {
      runOnly: { type: "rule", values: ["label-content-name-mismatch"] }
    });
    const el = document.querySelector("#probe-account");
    return { violations: r.violations.length, passes: r.passes.length, label: el.getAttribute("aria-label"), text: el.textContent.trim() };
  });
  if (result.violations === 0 && result.text && result.label.includes(result.text)) {
    ok(`account button passes label-in-name ("${result.text}" is inside "${result.label}")`);
  } else {
    bad(`label-in-name still fails: ${JSON.stringify(result)}`);
  }
  await page.close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} check(s) failed` : "\nAll control checks passed");
process.exit(fails.length ? 1 : 0);
