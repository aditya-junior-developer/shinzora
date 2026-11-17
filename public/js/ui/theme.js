/* ==========================================================================
   Shinzora — theme
   --------------------------------------------------------------------------
   Two separate things:

     - Look (presets): Violet, Cocoa, Ember or Plum. Each one re-colours the
       whole dashboard through the tokens in public/css/themes.css, generated
       from config/theme-presets.js. The choice is saved on the profile
       (profiles.theme) and cached on this device (shinzora:look) so the first
       paint already has the right colours.
     - Wallpaper: an optional background image, chosen in Settings. It is not a
       theme and never sets colours.

   clearRetiredPalette drops the palette keys left by the old picker. Profile
   rows keep their old `theme` value; a retired value resolves to Violet.
   ========================================================================== */

import { isSafeWallpaperUrl } from "../config/wallpaper-rules.js";
import { DEFAULT_PRESET, normalizePreset, presetById } from "../config/theme-presets.js";

const WALLPAPER_LAYER = "theme-wallpaper";
const RETIRED_KEY = "shinzora:theme";
const DEFAULT_META_COLOUR = "#08070e";
const LOOK_KEY = "shinzora:look";

/** The look shown right now (a preset id). */
export function currentPreset() {
  return normalizePreset(document.documentElement.getAttribute("data-preset") || DEFAULT_PRESET);
}

/**
 * Paint a look on this page and remember it on this device. Violet removes the
 * attribute so the tokens.css defaults apply. Returns the normalised id.
 */
export function applyPreset(id) {
  const preset = presetById(id);
  const root = document.documentElement;
  if (preset.id === DEFAULT_PRESET) root.removeAttribute("data-preset");
  else root.setAttribute("data-preset", preset.id);
  const meta = document.querySelector('meta[name="theme-color"]');
  const base = getComputedStyle(root).getPropertyValue("--base").trim();
  if (meta && base) meta.setAttribute("content", base);
  try {
    if (preset.id === DEFAULT_PRESET) localStorage.removeItem(LOOK_KEY);
    else localStorage.setItem(LOOK_KEY, preset.id);
  } catch {
    /* Storage blocked: the look still applies for this page. */
  }
  return preset.id;
}

/** The look a profile asks for. An unknown or retired value gives Violet. */
export function presetFromProfile(profile) {
  return normalizePreset(profile?.theme);
}

/** Drop the retired palette from this page and this device. Idempotent. */
export function clearRetiredPalette() {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.removeAttribute("data-tone");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", DEFAULT_META_COLOUR);
  try {
    localStorage.removeItem(RETIRED_KEY);
  } catch {
    /* Storage blocked: nothing was stored, nothing to clear. */
  }
}

/** Paint a wallpaper, or remove it when the url is null or not allowed. */
export function applyWallpaper(url) {
  const root = document.documentElement;
  const layer = document.getElementById(WALLPAPER_LAYER);
  if (!isSafeWallpaperUrl(url) || !document.body) {
    layer?.remove();
    root.removeAttribute("data-wallpaper");
    return false;
  }
  const node = layer || document.createElement("div");
  if (!layer) {
    node.id = WALLPAPER_LAYER;
    node.setAttribute("aria-hidden", "true");
    document.body.prepend(node);
  }
  node.style.backgroundImage = `url("${url}")`;
  root.setAttribute("data-wallpaper", "on");
  return true;
}
