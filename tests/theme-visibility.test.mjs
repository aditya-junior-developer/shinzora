/* ==========================================================================
   "This is not visible in every theme"
   --------------------------------------------------------------------------
   Reported from three screenshots: the admin overview's stat values, the
   business overview's revenue and customer numbers, and the freelancer
   dashboard's figures were blank in the light themes. They were not blank —
   they were `color: #fff` on a near-white page.

   `--white` in tokens.css is not "the colour white", it is *the strongest ink*
   for the current tone: white in the dark themes, near-black in the light ones.
   Any text painted a literal white is invisible in half the app.

   These tests hold three things:
     1. every theme's strongest ink is readable on its own page (4.5:1)
     2. the two selectors that caused the report read that token, not a literal
     3. no stylesheet paints text with a literal white except on a brand fill
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (file) => readFile(path.join(repo, file), "utf8");

function rgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `--token: #hex` pairs from a block of CSS. */
function tokens(css) {
  const found = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})(?=\s*;)/g)) {
    found[match[1]] = match[2];
  }
  return found;
}

/** Every palette the app can paint: the default plus each [data-theme] block. */
async function palettes() {
  const theme = await import("../public/js/ui/theme.js");
  const css = (await read("public/css/tokens.css")) + (await read("public/css/theme-light.css"));
  const blocks = {};
  for (const match of css.matchAll(/:root\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\n\}/g)) {
    blocks[match[1]] = tokens(match[2]);
  }
  const baseStart = css.indexOf(":root {");
  const defaults = tokens(css.slice(baseStart, css.indexOf("\n}", baseStart)));
  const out = [];
  for (const entry of theme.THEMES) {
    const palette = entry.id === "midnight" ? defaults : blocks[entry.id];
    assert.ok(palette && palette["--base"], `${entry.id} has a palette`);
    out.push({ id: entry.id, tone: theme.toneOf(entry.id), palette });
  }
  return out;
}

test("the strongest ink is readable on its own page, in all six themes", async () => {
  for (const { id, tone, palette } of await palettes()) {
    assert.ok(palette["--white"], `${id} defines --white`);
    const ratio = contrast(palette["--white"], palette["--base"]);
    assert.ok(ratio >= 4.5, `${id}: --white on --base is ${ratio.toFixed(2)}:1, below 4.5:1`);
    /* And it must actually be the strongest ink of that tone: dark ink in a
       light theme, light ink in a dark one. A light theme that kept a white
       --white is the exact bug that was reported. */
    const inkIsDark = luminance(palette["--white"]) < 0.2;
    assert.equal(inkIsDark, tone === "light", `${id} (${tone}) --white points the right way`);
  }
});

test("the stat figures that were invisible read the themed ink token", async () => {
  const app = await read("public/css/app.css");
  const admin = await read("public/css/admin.css");
  for (const [file, css, selector] of [
    ["app.css", app, ".stat-value"],
    ["admin.css", admin, ".admin-stat-value"]
  ]) {
    const rule = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`));
    assert.ok(rule, `${file} still styles ${selector}`);
    assert.match(rule[0], /color:\s*var\(--white\)/, `${file} ${selector} uses var(--white)`);
    assert.equal(/color:\s*#fff/i.test(rule[0]), false, `${file} ${selector} has no literal white`);
  }
});

/* Literal white is correct — and only correct — on a solid brand fill, where
   the background is a fixed purple/green/blue in every theme. Each exception is
   named with the fill behind it so a new one cannot slip in unnoticed. */
const ON_BRAND_FILL = [
  ".btn-primary",                       // background: var(--grad-brand)
  ":root[data-tone=\"light\"] .btn-primary", // colour override for the same fill
  ".choice:has(input:checked) .choice-mark",
  ".avatar",
  ".grp-head-avatar",
  ".call-avatar",
  ".ob-step.is-active .obs-marker",
  ".goal-chip[aria-pressed=\"true\"] .gc-check",
  ".plan-pick .pp-badge",
  ".check .box svg",                    // the tick inside a var(--grad-brand) box
  ".track-step.is-done .track-dot",     // background: var(--violet)
  ".cm-send",                           // background: var(--accent, #7c3aed)
  ".skip-link"                          // background: var(--purple-500)
];

test("no stylesheet paints text a literal white outside a brand fill", async () => {
  const files = (await readdir(path.join(repo, "public/css"))).filter((name) => name.endsWith(".css"));
  const offenders = [];
  for (const name of files) {
    const css = await readFile(path.join(repo, "public/css", name), "utf8");
    const lines = css.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!/(^|[;{\s])color:\s*#fff(?:fff)?\s*;/i.test(lines[index])) continue;
      /* Walk back to the rule this declaration belongs to, and look at what it
         paints behind the text. A brand fill guarantees white stays readable;
         anything else is the reported defect waiting to happen. */
      let start = index;
      while (start > 0 && !/^[.#:@\[a-z*]/i.test(lines[start])) start -= 1;
      const selector = lines[start].trim();
      const body = lines.slice(start, index + 1).join(" ");
      const onBrandFill = /(var\(--grad-brand|var\(--violet\b|var\(--purple-[0-9]|--purple-500|--grad-brand-soft)/.test(body);
      /* The public marketing, legal and auth pages are one fixed dark surface
         and never render inside the themed app shell. */
      const fixedDarkPage = ["marketing", "marketing-sections", "legal", "auth", "guide", "fx"].some((prefix) =>
        name.startsWith(prefix)
      );
      const allowlisted = ON_BRAND_FILL.some((allowed) => selector.includes(allowed));
      if (!onBrandFill && !allowlisted && !fixedDarkPage) offenders.push(`${name}: ${selector}`);
    }
  }
  assert.deepEqual(offenders, [], `literal white text on a themed surface: ${offenders.join(", ")}`);
});

test("app code never paints text with an inline literal white", async () => {
  const root = path.join(repo, "public/js");
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  };
  const offenders = [];
  for (const file of await walk(root)) {
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((line, index) => {
      if (/color:\s*['"]?#fff(?:fff)?\b/i.test(line) || /color:\s*['"]?white\b/i.test(line)) {
        offenders.push(`${path.relative(repo, file)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `inline white text: ${offenders.join(", ")}`);
});

test("no view links to a hash route the router cannot serve", async () => {
  /* The freelancer dashboard's "Add skills" and every other button on it used
     `#/app/?view=…`. This router never handled hash paths, so the click changed
     the address fragment and nothing else — "no button is working". */
  const root = path.join(repo, "public/js");
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  };
  const offenders = [];
  for (const file of await walk(root)) {
    const source = await readFile(file, "utf8");
    if (source.includes("#/app/")) offenders.push(path.relative(repo, file));
  }
  assert.deepEqual(offenders, [], `dead hash links in: ${offenders.join(", ")}`);
});
