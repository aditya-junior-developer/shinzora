/**
 * Shinzora — accessibility audit
 * ---------------------------------------------------------------------------
 * Runs axe-core against the pages that carry real content, at desktop width,
 * and prints violations grouped by rule with the number of nodes and a sample
 * target. Exits non-zero when a Critical or Serious violation remains, so the
 * check can gate a release.
 *
 * Usage:
 *   node scripts/a11y-audit.mjs                       # http://localhost:4173
 *   BASE=https://shinzora.vercel.app node scripts/a11y-audit.mjs
 *   ONLY=/ node scripts/a11y-audit.mjs                # one route
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:4173";
const ROUTES = (process.env.ONLY || "/").split(",").filter(Boolean);
const axeSource = fs.readFileSync("node_modules/axe-core/axe.min.js", "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const browser = await chromium.launch({ args: ["--no-sandbox"] });
let critical = 0, serious = 0, moderate = 0, minor = 0, nodes = 0;

for (const route of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  /* Some pages (system-check) poll a backend forever and never reach
     networkidle — wait for the document, then let scripts settle. */
  await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  /* Let the reveal-on-scroll and typing animations settle so nothing is judged
     in a half-painted state. */
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  });
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: (n.failureSummary || "").split("\n")[0] }))
    }));
  }, TAGS);

  console.log(`\n=== ${route} — ${results.length} rule(s) failing ===`);
  for (const v of results.sort((a, b) => a.id.localeCompare(b.id))) {
    const n = v.nodes.length;
    nodes += n;
    if (v.impact === "critical") critical += n;
    else if (v.impact === "serious") serious += n;
    else if (v.impact === "moderate") moderate += n;
    else minor += n;
    console.log(`  ${String(n).padStart(3)}× ${v.id} [${v.impact}] — ${v.help}`);
    for (const node of v.nodes.slice(0, 3)) console.log(`        ${node.target}`);
    if (n > 3) console.log(`        … and ${n - 3} more`);
  }
  await page.close();
}

await browser.close();
console.log(`\nTOTAL nodes: critical ${critical} · serious ${serious} · moderate ${moderate} · minor ${minor} · all ${nodes}`);
process.exit(critical + serious > 0 ? 1 : 0);
