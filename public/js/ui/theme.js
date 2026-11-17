/* ==========================================================================
   Shinzora — theme
   --------------------------------------------------------------------------
   One colour design: the purple-and-black default in tokens.css. The six
   selectable palettes (Midnight, Blossom, Daylight, Nebula, Grove, Porcelain)
   have been removed, and so has their picker.

   What remains here:
     - applyWallpaper: the Glow and Elite backgrounds (Settings → Wallpaper)
     - clearRetiredPalette: at boot, drops the palette attributes and the stored
       palette key left by the old picker. Profile rows keep their old `theme`
       value; nothing is deleted, and nothing reads it any more.
   ========================================================================== */

import { isSafeWallpaperUrl } from "../config/wallpaper-rules.js";

const WALLPAPER_LAYER = "theme-wallpaper";
const RETIRED_KEY = "shinzora:theme";
const DEFAULT_META_COLOUR = "#08070e";

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
