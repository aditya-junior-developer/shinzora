/* ==========================================================================
   One colour design, and no palette picker
   --------------------------------------------------------------------------
   The six selectable palettes (Midnight, Blossom, Daylight, Nebula, Grove,
   Porcelain) and their picker were removed. Shinzora keeps its purple-and-black
   default and the Glow / Elite wallpapers. This file holds that line: a palette
   cannot come back through the picker, the pre-paint script or a stored value.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the six palettes are no longer defined in the stylesheets", () => {
  const tokens = read("public/css/tokens.css");
  const light = read("public/css/theme-light.css");
  assert.doesNotMatch(tokens, /:root\[data-theme="/, "tokens.css has no palette block");
  assert.doesNotMatch(light, /:root\[data-theme="/, "theme-light.css has no palette block");
  assert.doesNotMatch(light, /\.theme-choice/, "the picker has no styles left");
  /* The default design is still there. */
  assert.match(tokens, /:root \{/, "the default design is defined");
  assert.match(tokens, /--base:/, "the default defines its base surface");
});

test("the theme module offers no palette and applies no palette", () => {
  const theme = read("public/js/ui/theme.js");
  for (const name of ["THEMES", "applyTheme", "themePicker", "toneOf", "currentTheme", "saveThemeToProfile", "adoptProfileTheme"]) {
    assert.doesNotMatch(theme, new RegExp(`export (const|function) ${name}\\b`), `${name} is gone`);
  }
  for (const id of ["midnight", "blossom", "daylight", "nebula", "grove", "porcelain"]) {
    assert.doesNotMatch(theme, new RegExp(`id: "${id}"`), `${id} is not offered`);
  }
  assert.match(theme, /export function clearRetiredPalette/, "a stored palette is dropped at boot");
  assert.match(theme, /export function applyWallpaper/, "wallpapers still paint");
});

test("the pre-paint script reads the look key, and sets the tone only for light looks", () => {
  for (const page of ["public/app/index.html", "public/admin/index.html"]) {
    const html = read(page);
    assert.doesNotMatch(html, /shinzora:theme/, `${page} does not read the old key`);
  }
  const app = read("public/app/index.html");
  assert.match(app, /shinzora:look/, "the app reads the look key");
  assert.match(app, /"blossom", "daylight", "porcelain"/, "the app sets the tone for the light looks");
  assert.doesNotMatch(read("public/admin/index.html"), /data-tone/, "admin keeps its own styling");
});

test("the Settings appearance section is the wallpaper card, with no palette picker", () => {
  const settings = read("public/js/modules/dashboard/views/settings.js");
  assert.doesNotMatch(settings, /themePicker|data-theme-choice|Six themes/);
  assert.match(settings, /wallpaper-card/, "the wallpaper card is still there");
  assert.match(settings, /\[data-wallpaper-preview\]/, "locked designs still preview");
});

test("the boot path clears a retired palette", () => {
  const store = read("public/js/lib/store.js");
  assert.match(store, /clearRetiredPalette\(\)/);
  assert.doesNotMatch(store, /adoptProfileTheme/);
});

test("the palette audit script is retired with the palettes", () => {
  assert.equal(existsSync(new URL("../scripts/theme-audit.mjs", import.meta.url)), false);
});

test("shared rules that other screens depend on are kept", () => {
  const light = read("public/css/theme-light.css");
  assert.match(light, /\.bubble-mine/, "chat bubble rule");
  assert.match(light, /\.presence-active/, "presence indicator rule");
});
