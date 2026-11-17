#!/usr/bin/env node
/* ==========================================================================
   Writes public/css/themes.css from public/js/config/theme-presets.js.
   The presets are defined once, in JavaScript (so the Settings previews and the
   stylesheet agree). Run after editing a preset:  node scripts/gen-theme-css.mjs
   tests/theme-presets.test.mjs fails if the committed stylesheet is stale.
   ========================================================================== */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "../public/js/config/theme-presets.js";

/* Every custom property in tokens.css's :root block, as declarations. */
function violetDeclarations() {
  const tokens = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "css", "tokens.css"), "utf8");
  const root = tokens.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!root) throw new Error("tokens.css has no :root block");
  const decls = [];
  for (const [, name, value] of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) decls.push(`  ${name}: ${value.trim()};`);
  return decls;
}

export function buildThemeCss() {
  const out = [
    "/* ==========================================================================",
    "   Theme presets — GENERATED. Do not edit by hand.",
    "   Source: public/js/config/theme-presets.js. Regenerate with",
    "   `node scripts/gen-theme-css.mjs`. Violet is the default in tokens.css and",
    "   has no block here.",
    "   ========================================================================== */",
    ""
  ];
  for (const preset of PRESETS) {
    /* Violet's values live in tokens.css. Its Settings preview tile needs them
       scoped too, or it would draw in whichever look the page is wearing. The
       page itself keeps Violet from :root (applyPreset removes the attribute). */
    if (preset.id === "violet") {
      out.push(`[data-preset="violet"] {`, ...violetDeclarations(), "}", "");
      continue;
    }
    const decls = Object.entries(preset.tokens).map(([name, value]) => `  --${name}: ${value};`);
    decls.push(`  --accent-rgb: ${preset.accentRgb};`);
    decls.push(`  --violet-rgb: ${preset.violetRgb};`);
    out.push(`[data-preset="${preset.id}"] {`, ...decls, "}", "");
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "css", "themes.css");
  writeFileSync(target, buildThemeCss());
  console.log(`wrote ${path.relative(process.cwd(), target)}`);
}
