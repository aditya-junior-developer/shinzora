/* ==========================================================================
   Six themes, and the promise that each one is a whole palette
   --------------------------------------------------------------------------
   A theme is not a colour. A theme is a block of tokens that every component
   already reads, plus an entry in the picker, plus the inline pre-paint script
   knowing about it — three places, and a missing one is either a page that
   flashes the wrong colours or a card that does nothing when clicked.

   This file keeps the three in step, and holds each palette to the contrast
   rule the light themes were built with: body text at least 4.5:1 against the
   page it sits on.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (file) => readFile(path.join(repo, file), "utf8");

/** Split `[data-theme="x"] { ... }` blocks into id → declarations. */
function palettes(css) {
  const found = {};
  const re = /:root\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\n\}/g;
  for (const match of css.matchAll(re)) {
    const body = match[2];
    const tokens = {};
    for (const line of body.split("\n")) {
      const decl = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/);
      if (decl) tokens[decl[1]] = decl[2].trim();
    }
    found[match[1]] = tokens;
  }
  return found;
}

function rgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16));
}

/** WCAG 2.1 relative luminance. */
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

test("there are six themes, three dark and three light", async () => {
  const theme = await import("../public/js/ui/theme.js");
  assert.equal(theme.THEMES.length, 6, "six themes");
  const tones = theme.THEMES.map((entry) => theme.toneOf(entry.id));
  assert.equal(tones.filter((tone) => tone === "dark").length, 3, "three dark");
  assert.equal(tones.filter((tone) => tone === "light").length, 3, "three light");
  for (const entry of theme.THEMES) {
    assert.ok(entry.name && entry.note, `${entry.id} is named and described`);
    assert.equal(entry.swatch.length, 4, `${entry.id} has four preview colours`);
  }
});

test("every theme in the picker has a real palette in the stylesheet", async () => {
  const theme = await import("../public/js/ui/theme.js");
  const css = (await read("public/css/tokens.css")) + (await read("public/css/theme-light.css"));
  const blocks = palettes(css);
  for (const entry of theme.THEMES) {
    if (entry.id === "midnight") continue; // the :root default, not a block
    assert.ok(blocks[entry.id], `${entry.id} has a [data-theme] block`);
    for (const token of ["--base", "--panel", "--text", "--text-2", "--line", "--violet"]) {
      assert.ok(blocks[entry.id][token], `${entry.id} defines ${token}`);
    }
  }
});

test("body text passes 4.5:1 on the page it sits on, in every theme", async () => {
  const theme = await import("../public/js/ui/theme.js");
  const css = (await read("public/css/tokens.css")) + (await read("public/css/theme-light.css"));
  const blocks = palettes(css);
  /* Midnight is the :root default, so its palette is read from the base block —
     the first `:root { … }` in tokens.css, before any [data-theme] override. */
  const defaults = {};
  const base = css.slice(css.indexOf(":root {"));
  const baseBlock = base.slice(0, base.indexOf("\n}"));
  for (const line of baseBlock.split("\n")) {
    const decl = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6});/);
    if (decl) defaults[decl[1]] = decl[2];
  }
  assert.ok(defaults["--text"] && defaults["--base"], "the default palette was read");

  for (const entry of theme.THEMES) {
    const palette = entry.id === "midnight" ? defaults : blocks[entry.id];
    for (const [ink, surface] of [
      ["--text", "--base"],
      ["--text", "--panel"],
      ["--text-2", "--panel"]
    ]) {
      const ratio = contrast(palette[ink], palette[surface]);
      assert.ok(ratio >= 4.5, `${entry.id}: ${ink} on ${surface} is ${ratio.toFixed(2)}:1, below 4.5:1`);
    }
  }
});

test("the picker draws six choices, and the note no longer mentions only three", async () => {
  const theme = await import("../public/js/ui/theme.js");
  const markup = theme.themePicker("nebula");
  assert.equal((markup.match(/data-theme-choice=/g) || []).length, 6, "six cards");
  assert.match(markup, /Nebula/, "the new dark theme is offered");
  assert.match(markup, /Grove/);
  assert.match(markup, /Porcelain/);
  assert.match(markup, /data-theme-choice="nebula" aria-pressed="true"/, "the current one is marked");

  const settings = await read("public/js/modules/dashboard/views/settings.js");
  assert.match(settings, /Six themes, three dark and three light/, "the explanation matches the picker");
  assert.equal(/All three pass/.test(settings), false, "the old three-theme sentence is gone");
});

test("the inline pre-paint script knows all six, so no page flashes the wrong theme", async () => {
  for (const page of ["public/app/index.html", "public/admin/index.html"]) {
    const html = await read(page);
    const inline = html.slice(html.indexOf("localStorage.getItem(\"shinzora:theme\")"));
    const script = inline.slice(0, inline.indexOf("</script>"));
    for (const id of ["midnight", "blossom", "daylight", "nebula", "grove", "porcelain"]) {
      assert.match(script, new RegExp(`${id}: "(dark|light)"`), `${page} knows ${id}`);
    }
    assert.match(script, /nebula: "dark"/, `${page} treats Nebula as dark`);
    assert.match(script, /porcelain: "light"/, `${page} treats Porcelain as light`);
  }
});

test("a dark theme keeps the light-theme corrections switched off", async () => {
  /* Every light-only rule in theme-light.css is scoped to [data-tone="light"].
     If a new dark theme ever set that attribute, the page would go white-on-
     white — so the mapping is asserted, not assumed. */
  const theme = await import("../public/js/ui/theme.js");
  for (const id of ["midnight", "nebula", "grove"]) assert.equal(theme.toneOf(id), "dark", `${id} is dark`);
  for (const id of ["blossom", "daylight", "porcelain"]) assert.equal(theme.toneOf(id), "light", `${id} is light`);
});
