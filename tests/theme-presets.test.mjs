/* ==========================================================================
   Theme presets — the four whole-dashboard looks
   --------------------------------------------------------------------------
   Holds the rules for real themes (not wallpapers):
     1. the presets are Violet (default), Cocoa, Ember and Plum, and none of
        the six retired palettes comes back
     2. every token a preset overrides exists in tokens.css, so a typo cannot
        silently do nothing
     3. the text inks read on each look's surfaces (WCAG AA, 4.5:1)
     4. themes.css is the generated output of theme-presets.js (no drift)
     5. no preset carries an image, so a theme is never a wallpaper
     6. the look is applied at first paint, after boot, and saved on the profile
     7. the stylesheets use the accent tokens, so a look reaches every surface
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS, DEFAULT_PRESET, presetById, normalizePreset } from "../public/js/config/theme-presets.js";
import { buildThemeCss } from "../scripts/gen-theme-css.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (file) => readFile(path.join(repo, file), "utf8");

/* Midnight was the original default and is now Violet. Every other old
   palette has been restored as a look. */
const RETIRED = ["midnight"];

/* Default token values from tokens.css :root, to compute the Violet look. */
function defaultTokens(css) {
  const root = css.match(/:root \{([\s\S]*?)\n\}/);
  const out = {};
  for (const [, name, value] of root[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

function hex(value) {
  const full = value.replace("#", "");
  const six = full.length === 3 ? full.split("").map((c) => c + c).join("") : full;
  return [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16));
}

function luminance(value) {
  const [r, g, b] = hex(value).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("the fifteen looks: four presets, five restored palettes, six new designs; Violet is the default", () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ["violet", "cocoa", "ember", "plum", "nebula", "grove", "blossom", "daylight", "porcelain", "aurora", "orchid", "gilt", "rose-dusk", "sand", "mint"]);
  const light = PRESETS.filter((p) => p.tone === "light").map((p) => p.id);
  assert.deepEqual(light, ["blossom", "daylight", "porcelain", "sand", "mint"], "light looks are marked");
  assert.equal(DEFAULT_PRESET, "violet");
  for (const preset of PRESETS) {
    assert.ok(preset.name && preset.blurb, `${preset.id} has a name and a blurb`);
    assert.equal(preset.swatches.length, 4, `${preset.id} has four swatches`);
    for (const swatch of preset.swatches) assert.match(swatch, /^#[0-9a-f]{6}$/i, `${preset.id} swatch ${swatch}`);
  }
});

test("retired names resolve to Violet, and restored palettes are selectable", () => {
  for (const id of RETIRED) {
    assert.equal(normalizePreset(id), "violet", `${id} resolves to the default`);
    assert.equal(presetById(id).id, "violet", `${id} is not a preset`);
  }
  for (const id of ["nebula", "grove", "blossom", "daylight", "porcelain", "aurora", "orchid", "gilt", "rose-dusk", "sand", "mint"]) {
    assert.equal(normalizePreset(id), id, `${id} is a look again`);
  }
  assert.equal(normalizePreset(undefined), "violet");
  assert.equal(normalizePreset(""), "violet");
  assert.equal(normalizePreset("cocoa"), "cocoa");
});

test("every overridden token exists in tokens.css or the light rules (no silent typos)", async () => {
  const known = defaultTokens(await read("public/css/tokens.css"));
  const lightRules = await read("public/css/theme-light.css");
  for (const preset of PRESETS) {
    for (const name of Object.keys(preset.tokens)) {
      const used = lightRules.includes(`var(--${name})`);
      assert.ok(name in known || used, `${preset.id} overrides --${name}, which nothing defines or uses`);
    }
  }
});

test("the text inks read on every look's surfaces (WCAG AA 4.5:1)", async () => {
  const base = defaultTokens(await read("public/css/tokens.css"));
  for (const preset of PRESETS) {
    const t = { ...base, ...preset.tokens };
    for (const surface of ["base", "panel", "panel-2"]) {
      for (const ink of ["text", "text-2", "text-3", "text-4"]) {
        const ratio = contrast(t[ink], t[surface]);
        assert.ok(ratio >= 4.5, `${preset.id}: --${ink} ${t[ink]} on --${surface} ${t[surface]} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("themes.css is the generated output of theme-presets.js", async () => {
  assert.equal(await read("public/css/themes.css"), buildThemeCss(), "run: node scripts/gen-theme-css.mjs");
});

test("no look carries an image or a url, so a theme is never a wallpaper", () => {
  for (const preset of PRESETS) {
    for (const value of Object.values(preset.tokens)) {
      assert.doesNotMatch(value, /url\(|\/assets\//, `${preset.id} has no image`);
    }
  }
  assert.doesNotMatch(buildThemeCss(), /url\(/, "the generated stylesheet has no image");
});

test("the stylesheets read the accent tokens, not the violet literals", async () => {
  for (const file of ["views.css", "components.css", "app.css", "fx.css", "auth.css", "marketing.css", "onboarding.css"]) {
    const css = await read(`public/css/${file}`);
    assert.doesNotMatch(css, /rgba\(124,\s*58,\s*237/, `${file} uses --accent-rgb`);
    assert.doesNotMatch(css, /rgba\(168,\s*85,\s*247/, `${file} uses --violet-rgb`);
    assert.doesNotMatch(css, /#7c3aed|#a855f7/i, `${file} uses the purple tokens`);
  }
  assert.match(await read("public/css/tokens.css"), /--accent-rgb: 124, 58, 237;/, "the default accent is defined");
});

test("the looks load after the tokens, and the saved look is set before first paint", async () => {
  const html = await read("public/app/index.html");
  const tokensAt = html.indexOf('href="/css/tokens.css');
  const themesAt = html.indexOf('href="/css/themes.css');
  assert.ok(tokensAt > 0 && themesAt > tokensAt, "themes.css follows tokens.css");
  assert.match(html, /localStorage\.getItem\("shinzora:look"\)/, "the device cache is read before paint");
  assert.doesNotMatch(html, /shinzora:theme\b/, "the retired palette key is not read");
});

test("theme.js exposes the look API and keeps the wallpaper helper", async () => {
  const theme = await read("public/js/ui/theme.js");
  for (const name of ["currentPreset", "applyPreset", "presetFromProfile", "clearRetiredPalette", "applyWallpaper"]) {
    assert.match(theme, new RegExp(`export function ${name}\\b`), `${name} is exported`);
  }
  for (const gone of ["applyTheme", "themePicker", "currentTheme", "saveThemeToProfile", "adoptProfileTheme"]) {
    assert.doesNotMatch(theme, new RegExp(`export (const|function) ${gone}\\b`), `${gone} is gone`);
  }
});

test("the boot path applies the saved look, after the retired-palette clean-up", async () => {
  const store = await read("public/js/lib/store.js");
  const retired = store.indexOf("clearRetiredPalette();");
  const applied = store.indexOf("applyPreset(presetFromProfile(state.profile))");
  assert.ok(retired > 0 && applied > retired, "the saved look is applied after the clean-up");
});

test("Settings shows the four looks and saves the choice to the profile", async () => {
  const settings = await read("public/js/modules/dashboard/views/settings.js");
  assert.match(settings, /themeCardHtml\(\)/, "the Theme card is rendered");
  assert.match(settings, /updateProfile\(\{ theme: id \}\)/, "the choice is saved to profiles.theme");
  assert.match(settings, /data-preset="\$\{esc\(preset\.id\)\}"/, "each tile is drawn in its own look");
  assert.match(settings, /wallpaper-card/, "the wallpaper card is still there, separate from the theme");
  assert.doesNotMatch(settings, /themePicker|data-theme-choice|Six themes/);
});

test("the Settings previews are scoped to their own look", async () => {
  const css = await read("public/css/themes.css");
  for (const preset of PRESETS.filter((p) => p.id !== "violet")) {
    assert.match(css, new RegExp(`\\[data-preset="${preset.id}"\\] \\{`), `${preset.id} has a scoped block`);
  }
});
