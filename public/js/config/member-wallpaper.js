/* ==========================================================================
   Member wallpapers — the limits and the file check (R7)
   --------------------------------------------------------------------------
   Pure: no browser APIs and no imports, so the test suite can load it. The
   limits here must match the bucket and the functions in migration 0067;
   tests/member-wallpaper-config.test.mjs checks that they do.

   The check runs before an upload starts, so a refused file never leaves the
   browser. The database and the bucket check again, because the browser is
   never trusted with the decision.
   ========================================================================== */

export const MEMBER_WALLPAPER_BUCKET = "member-wallpapers";
export const MEMBER_WALLPAPER_MAX_BYTES = 5 * 1024 * 1024;
export const MEMBER_WALLPAPER_MAX_COUNT = 5;

/** The types accepted, and the file extension each one is stored under. */
export const MEMBER_WALLPAPER_TYPES = Object.freeze({
  "image/png": "png",
  "image/gif": "gif"
});

/** The file extension for an accepted type, or null. */
export function extensionFor(mimeType) {
  return Object.prototype.hasOwnProperty.call(MEMBER_WALLPAPER_TYPES, mimeType) ? MEMBER_WALLPAPER_TYPES[mimeType] : null;
}

/** "5 MB" style text for a byte count. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Decide whether a chosen file may be uploaded. Returns { ok: true } or
 * { ok: false, reason } with plain words for the member.
 */
export function checkWallpaperFile(file) {
  if (!file || typeof file !== "object") {
    return { ok: false, reason: "Choose a PNG or GIF file." };
  }
  if (extensionFor(file.type) === null) {
    return { ok: false, reason: "Only PNG and GIF files can be used as wallpapers." };
  }
  if (!Number.isFinite(file.size) || file.size < 1) {
    return { ok: false, reason: "That file is empty." };
  }
  if (file.size > MEMBER_WALLPAPER_MAX_BYTES) {
    return {
      ok: false,
      reason: `That file is ${formatSize(file.size)}. A wallpaper can be at most ${formatSize(MEMBER_WALLPAPER_MAX_BYTES)}.`
    };
  }
  return { ok: true };
}
