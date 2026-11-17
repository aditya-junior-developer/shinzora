#!/usr/bin/env node
/* ==========================================================================
   Writes public/css/themes.css from public/js/config/theme-presets.js.
   The presets are defined once, in JavaScript (so the Settings previews and the
   stylesheet agree). Run after editing a preset:  node scripts/gen-theme-css.mjs
   tests/theme-presets.test.mjs fails if the committed stylesheet is stale.
   ========================================================================== */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "../public/js/config/theme-presets.js";

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
    if (preset.id === "violet") continue;
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
