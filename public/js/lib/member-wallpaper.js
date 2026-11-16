/* ==========================================================================
   Member wallpapers — upload, use and remove a member's own PNG or GIF (R7)
   --------------------------------------------------------------------------
   The browser asks; the database decides. Every step is checked again on the
   server:
     - the file type and size are checked here first, so a refused file never
       leaves the browser (config/member-wallpaper.js)
     - the bucket accepts only PNG and GIF up to 5 MB, in the caller's folder,
       and only for a Glow or Elite member (migration 0067)
     - member_wallpaper_register() checks the stored object's real size and type
       before the upload is recorded
     - the file is private: it is shown through a short-lived signed address

   If registration is refused, the rejected file is removed from storage, so no
   orphan stays behind.
   ========================================================================== */

import { sb, normalizeError, getSession } from "./supabase.js";
import {
  MEMBER_WALLPAPER_BUCKET,
  MEMBER_WALLPAPER_MAX_COUNT,
  checkWallpaperFile,
  extensionFor
} from "../config/member-wallpaper.js";

const SIGNED_SECONDS = 60 * 60;

function failure(error) {
  return { error: normalizeError(error || new Error("Something went wrong.")) };
}

/** What the Settings page needs: tier, uploads and which one is in use. */
export async function loadMemberWallpapers() {
  if (!sb) return failure(new Error("Offline"));
  const { data, error } = await sb.rpc("member_wallpaper_state");
  if (error) return failure(error);
  return {
    state: {
      tierOk: Boolean(data?.tierOk),
      limit: Number(data?.limit) || MEMBER_WALLPAPER_MAX_COUNT,
      chosenId: data?.chosenId || null,
      chosenPath: data?.chosenPath || null,
      uploads: (Array.isArray(data?.uploads) ? data.uploads : []).map((row) => ({
        id: row.id,
        path: row.path,
        mimeType: row.mimeType,
        byteSize: Number(row.byteSize) || 0,
        createdAt: row.createdAt,
        chosen: Boolean(row.chosen)
      }))
    }
  };
}

/** A short-lived address for one of the caller's private files, or null. */
export async function memberWallpaperUrl(path) {
  if (!sb || !path) return null;
  const { data, error } = await sb.storage.from(MEMBER_WALLPAPER_BUCKET).createSignedUrl(path, SIGNED_SECONDS);
  if (error) return null;
  return data?.signedUrl || null;
}

/** The address to paint behind the page, or null for the default background. */
export async function currentMemberWallpaperUrl() {
  const { state } = await loadMemberWallpapers();
  if (!state?.chosenPath) return null;
  return memberWallpaperUrl(state.chosenPath);
}

/**
 * Check the file, store it in the caller's folder, and record it. The file is
 * removed again if the record is refused. Returns { ok, id } or { error }.
 */
export async function uploadMemberWallpaper(file) {
  const check = checkWallpaperFile(file);
  if (!check.ok) return { error: new Error(check.reason) };
  if (!sb) return failure(new Error("Offline"));

  const session = await getSession();
  const uid = session?.user?.id;
  if (!uid) return failure(new Error("Sign in first."));

  const ext = extensionFor(file.type);
  const name = `${crypto.randomUUID()}.${ext}`;
  const path = `${uid}/${name}`;

  const { error: uploadError } = await sb.storage
    .from(MEMBER_WALLPAPER_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type, cacheControl: "3600" });
  if (uploadError) return failure(uploadError);

  const { data, error } = await sb.rpc("member_wallpaper_register", { p_path: path });
  if (error) {
    await sb.storage.from(MEMBER_WALLPAPER_BUCKET).remove([path]).catch(() => undefined);
    return failure(error);
  }
  return { ok: true, id: data?.id || null, path };
}

/** Use one of the caller's uploads. The catalogue choice is cleared by the database. */
export async function useMemberWallpaper(id) {
  if (!sb) return failure(new Error("Offline"));
  const { error } = await sb.rpc("member_wallpaper_use", { p_id: id });
  if (error) return failure(error);
  return { ok: true };
}

/** Remove one of the caller's uploads and its stored file. */
export async function removeMemberWallpaper(id) {
  if (!sb) return failure(new Error("Offline"));
  const { data, error } = await sb.rpc("member_wallpaper_delete", { p_id: id });
  if (error) return failure(error);
  if (data?.path) await sb.storage.from(MEMBER_WALLPAPER_BUCKET).remove([data.path]).catch(() => undefined);
  return { ok: true };
}
