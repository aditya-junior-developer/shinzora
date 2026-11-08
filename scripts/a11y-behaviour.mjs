/**
 * Shinzora — accessibility behaviour probe
 * ---------------------------------------------------------------------------
 * axe checks structure; this checks the things axe cannot see: that the FAQ
 * accordion really opens and closes for mouse *and* keyboard, that the page
 * reflows at 320px and at 200% text without sideways scrolling, that no
 * visible text renders below 12px, and that focusing a link inside a
 * scroll-reveal block actually brings it into view.
 *
 * Usage: node scripts/a11y-behaviour.mjs [baseUrl]
 */
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:4173";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const fails = [];
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { fails.push(m); console.log(`  FAIL  ${m}`); };

/* ---------- 1. accordion, mouse + keyboard ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const state = () => page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-acc-item]")];
    return items.slice(0, 3).map((item) => {
      const b = item.querySelector("[data-acc-trigger]");
      const p = item.querySelector("[data-acc-panel]");
      return {
        btnExpanded: b.getAttribute("aria-expanded"),
        controls: b.getAttribute("aria-controls"),
        panelId: p.id,
        hidden: p.hidden,
        height: p.getBoundingClientRect().height,
        itemHasAria: item.hasAttribute("aria-expanded")
      };
    });
  });

  let s = await state();
  if (s.every((i) => i.hidden && i.height === 0 && i.btnExpanded === "false")) ok("all FAQ panels start collapsed and hidden");
  else bad(`FAQ initial state wrong: ${JSON.stringify(s)}`);
  if (s.every((i) => i.controls && i.controls === i.panelId)) ok("every trigger aria-controls resolves to its own panel id");
  else bad(`aria-controls/id mismatch: ${JSON.stringify(s.map((i) => [i.controls, i.panelId]))}`);
  if (s.every((i) => !i.itemHasAria)) ok("no aria-expanded left on the wrapper div");
  else bad("wrapper div still carries aria-expanded");

  await page.locator("[data-acc-trigger]").first().click();
  await page.waitForTimeout(450);
  s = await state();
  if (s[0].btnExpanded === "true" && !s[0].hidden && s[0].height > 0) ok(`click opens panel 1 (height ${Math.round(s[0].height)}px, aria-expanded=true)`);
  else bad(`click did not open panel 1: ${JSON.stringify(s[0])}`);

  /* keyboard: Tab to second trigger and press Enter */
  await page.locator("[data-acc-trigger]").nth(1).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(450);
  s = await state();
  if (s[1].btnExpanded === "true" && !s[1].hidden) ok("Enter on a focused trigger opens panel 2");
  else bad(`Enter did not open panel 2: ${JSON.stringify(s[1])}`);
  if (s[0].btnExpanded === "false" && s[0].hidden && s[0].height === 0) ok("opening panel 2 closes and re-hides panel 1");
  else bad(`panel 1 did not close: ${JSON.stringify(s[0])}`);

  /* the answer text must be in the accessibility tree only while open */
  const closedText = await page.evaluate(() => {
    const p = document.querySelectorAll("[data-acc-panel]")[2];
    const r = p.getBoundingClientRect();
    return { hidden: p.hidden, height: Math.round(r.height), text: p.textContent.trim().slice(0, 20) };
  });
  if (closedText.hidden && closedText.height === 0) ok("untouched panels stay out of layout and the accessibility tree");
  else bad(`untouched panel is exposed: ${JSON.stringify(closedText)}`);
  await page.close();
}

/* ---------- 2. reflow at 320px and 200% text ---------- */
for (const [label, viewport, fontPx] of [
  ["320px reflow", { width: 320, height: 720 }, null],
  ["200% text", { width: 1280, height: 900 }, 32]
]) {
  const page = await browser.newPage({ viewport });
  if (fontPx) await page.addInitScript((px) => {
    addEventListener("DOMContentLoaded", () => { document.documentElement.style.fontSize = `${px}px`; });
  }, fontPx);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const r = await page.evaluate(() => {
    const de = document.documentElement;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        if (!b.width || b.height === 0) return false;
        if (getComputedStyle(el).position === "fixed") return false;
        return b.right > de.clientWidth + 2 || b.left < -2;
      })
      .slice(0, 6)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} → ${Math.round(el.getBoundingClientRect().right)}px`);
    return { scrollW: de.scrollWidth, clientW: de.clientWidth, wide };
  });
  if (r.scrollW <= r.clientW + 2) ok(`${label}: no horizontal scrolling (${r.scrollW}px ≤ ${r.clientW}px)`);
  else bad(`${label}: page scrolls sideways ${r.scrollW}px vs ${r.clientW}px; widest: ${r.wide.join(", ")}`);
  await page.close();
}

/* ---------- 3. nothing below 12px ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const small = await page.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest("[aria-hidden='true']")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const px = parseFloat(cs.fontSize);
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (px < 12) out.push(`${px}px ${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} "${n.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  if (!small.length) ok("no visible text under 12px");
  else bad(`${small.length} text node(s) under 12px, e.g. ${small.slice(0, 5).join(" | ")}`);
  await page.close();
}

/* ---------- 4. keyboard focus reaches every revealed link ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const review = await page.evaluate(async () => {
    const off = [];
    const links = [...document.querySelectorAll("a[href], button, input, select, textarea")];
    for (const el of links) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (parseFloat(getComputedStyle(el).opacity) < 0.05) {
        off.push(`${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 20)}" opacity ${getComputedStyle(el).opacity}`);
      }
    }
    return off.slice(0, 8);
  });
  if (!review.length) ok("no control sits at zero opacity");
  else console.log(`  NOTE  ${review.length} control(s) start transparent before reveal: ${review.join(", ")}`);

  /* focusing one of them should reveal it */
  const focusResult = await page.evaluate(() => {
    const el = document.querySelector("[data-reveal] a, [data-reveal] button, .reveal a, .reveal button");
    if (!el) return "no reveal-wrapped control found";
    el.focus();
    return { opacity: getComputedStyle(el.closest("[data-reveal], .reveal")).opacity, focused: document.activeElement === el };
  });
  if (focusResult === "no reveal-wrapped control found") console.log("  NOTE  " + focusResult);
  else if (focusResult.focused && parseFloat(focusResult.opacity) > 0.9) ok("focusing a control inside a reveal block makes it visible");
  else bad(`focus on a revealed control leaves opacity ${focusResult.opacity}`);
  await page.close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} check(s) failed` : "\nAll behaviour checks passed");
process.exit(fails.length ? 1 : 0);
