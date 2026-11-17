/* ==========================================================================
   Wallpapers — the member's saved background (P10)
   --------------------------------------------------------------------------
   Reads the catalog through theme_catalog() and saves through
   theme_set_wallpaper(), so the tier check runs in the database with the
   member's own entitlement. Nothing here grants access.
   ========================================================================== */

import { sb, normalizeError } from "./supabase.js";
import { applyWallpaper } from "../ui/theme.js";
import { resolveWallpaper, WALLPAPER_FEATURE_ENABLED } from "../config/wallpaper-rules.js";
import { currentMemberWallpaperUrl } from "./member-wallpaper.js";

export async function loadThemeCatalog() {
  if (!sb) return { error: normalizeError(new Error("Offline")) };
  const { data, error } = await sb.rpc("theme_catalog");
  if (error) return { error: normalizeError(error) };
  return { catalog: data || { collections: [], chosenWallpaperId: null, tier: null } };
}

/**
 * Paint the member's saved wallpaper on this page, or the default background
 * when the choice is missing or no longer allowed. Failures leave the default
 * in place; they never block the dashboard.
 */
export async function syncWallpaper() {
  if (!WALLPAPER_FEATURE_ENABLED) {
    applyWallpaper(null);
    return null;
  }
  /* A member's own upload wins: the database clears the catalogue choice when
     an upload is used, so the two never both apply. */
  const own = await currentMemberWallpaperUrl().catch(() => null);
  if (own) {
    applyWallpaper(own);
    return { own: true };
  }
  const { catalog } = await loadThemeCatalog();
  if (!catalog) {
    applyWallpaper(null);
    return null;
  }
  const wallpaper = resolveWallpaper(catalog, catalog.chosenWallpaperId);
  applyWallpaper(wallpaper?.imageUrl ?? null);
  return wallpaper;
}

export async function chooseWallpaper(wallpaperId) {
  if (!sb) return { error: normalizeError(new Error("Offline")) };
  const { error } = await sb.rpc("theme_set_wallpaper", { p_wallpaper: wallpaperId });
  if (error) return { error: normalizeError(error) };
  return { ok: true };
}

export async function clearWallpaper() {
  if (!sb) return { error: normalizeError(new Error("Offline")) };
  const { error } = await sb.rpc("theme_clear_wallpaper");
  if (error) return { error: normalizeError(error) };
  return { ok: true };
}
