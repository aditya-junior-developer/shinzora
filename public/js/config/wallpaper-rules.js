/* ==========================================================================
   Wallpaper rules — pure functions (P10)
   --------------------------------------------------------------------------
   No browser APIs and no imports, so the test suite can load this directly.
   The database decides what a member may choose (theme_set_wallpaper). These
   helpers only decide what to paint, and refuse any image address that could
   break out of a CSS url() value.
   ========================================================================== */

/* Shinzora's own artwork, or an https address. Quotes, parentheses, brackets,
   backslashes and whitespace are refused so the value is safe inside url("..."). */
const THEME_PATH = /^\/assets\/themes\/[a-z0-9._-]+$/;
const HTTPS_ADDRESS = /^https:\/\/[^\s"'()\\<>\[\]{}]+$/;

/* Wallpaper is hidden from members for now. The catalogue and uploads stay in
   the database; set this to true to bring the feature back. */
export const WALLPAPER_FEATURE_ENABLED = false;

export function isSafeWallpaperUrl(url) {
  return typeof url === "string" && url.length <= 500 && (THEME_PATH.test(url) || HTTPS_ADDRESS.test(url));
}

const TIER_NAMES = Object.freeze({ glow: "Glow", elite: "Elite" });

/** The name shown for a collection's requirement. Null means open to every member. */
export function tierLabel(tier) {
  return TIER_NAMES[tier] ?? "Free";
}

/**
 * The wallpaper that should be painted for this catalog, or null for the
 * default background. A locked collection never yields an image, and neither
 * does an unknown id. The catalog is the server's answer, so this stays a
 * second line of defence rather than the rule itself.
 */
export function resolveWallpaper(catalog, chosenId) {
  if (!catalog || !chosenId) return null;
  for (const collection of catalog.collections || []) {
    if (collection.locked) continue;
    for (const wallpaper of collection.wallpapers || []) {
      if (wallpaper.id === chosenId && isSafeWallpaperUrl(wallpaper.imageUrl)) {
        return {
          id: wallpaper.id,
          title: wallpaper.title,
          imageUrl: wallpaper.imageUrl,
          collectionId: collection.id,
          collectionName: collection.name
        };
      }
    }
  }
  return null;
}

/**
 * True when the member saved a wallpaper that is no longer available to them,
 * for example after a tier change or a deactivation. The UI says so, and the
 * default background is shown.
 */
export function savedChoiceUnavailable(catalog) {
  return Boolean(catalog?.chosenWallpaperId) && resolveWallpaper(catalog, catalog.chosenWallpaperId) === null;
}
