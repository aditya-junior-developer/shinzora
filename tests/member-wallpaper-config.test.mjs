/* ==========================================================================
   Member wallpapers — the limits and the file check (R7), in Node
   --------------------------------------------------------------------------
     - PNG and GIF pass; JPEG, WebP, SVG, PDF and an empty type are refused
     - a file over 5 MB is refused with its size in the message
     - the limits match migration 0067 (bucket size, types, count)
     - the sizes are read in plain words
   ========================================================================== */

import { readFileSync } from "node:fs";
import {
  MEMBER_WALLPAPER_BUCKET,
  MEMBER_WALLPAPER_MAX_BYTES,
  MEMBER_WALLPAPER_MAX_COUNT,
  MEMBER_WALLPAPER_TYPES,
  checkWallpaperFile,
  extensionFor,
  formatSize
} from "../public/js/config/member-wallpaper.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const MIGRATION = readFileSync(new URL("../supabase/migrations/0067_member_wallpapers.sql", import.meta.url), "utf8");

console.log("member wallpaper rules");
check("PNG is accepted", checkWallpaperFile({ type: "image/png", size: 1000 }).ok === true);
check("GIF is accepted", checkWallpaperFile({ type: "image/gif", size: 1000 }).ok === true);
for (const type of ["image/jpeg", "image/webp", "image/svg+xml", "application/pdf", ""]) {
  const result = checkWallpaperFile({ type, size: 1000 });
  check(`refuses ${type || "a file with no type"}`, result.ok === false && /PNG and GIF/.test(result.reason), JSON.stringify(result));
}
check("an empty file is refused", checkWallpaperFile({ type: "image/png", size: 0 }).ok === false);
check("a file exactly at 5 MB is accepted", checkWallpaperFile({ type: "image/png", size: MEMBER_WALLPAPER_MAX_BYTES }).ok === true);
const big = checkWallpaperFile({ type: "image/gif", size: 6 * 1024 * 1024 });
check("a file over 5 MB is refused, with its size", big.ok === false && /6(\.0)? MB/.test(big.reason) && /5 MB/.test(big.reason), big.reason);
check("no file is refused", checkWallpaperFile(null).ok === false);
check("extensionFor maps PNG and GIF", extensionFor("image/png") === "png" && extensionFor("image/gif") === "gif");
check("extensionFor refuses unknown types, even ones that look like prototype keys", extensionFor("constructor") === null && extensionFor("image/jpeg") === null);

console.log("sizes in plain words");
check("bytes", formatSize(512) === "512 B", formatSize(512));
check("kilobytes", formatSize(2048) === "2 KB", formatSize(2048));
check("megabytes", formatSize(5 * 1024 * 1024) === "5 MB", formatSize(5 * 1024 * 1024));
check("unknown size is blank", formatSize(NaN) === "");

console.log("limits match migration 0067");
check("the bucket name is the one the migration creates", MIGRATION.includes(`values ('${MEMBER_WALLPAPER_BUCKET}'`));
check("the bucket limit is the same size", MIGRATION.includes(String(MEMBER_WALLPAPER_MAX_BYTES)) && MEMBER_WALLPAPER_MAX_BYTES === 5242880);
check("the migration accepts the same types", Object.keys(MEMBER_WALLPAPER_TYPES).every((type) => MIGRATION.includes(`'${type}'`)));
check("the count is the same in the migration and the browser", MIGRATION.includes(`v_count >= ${MEMBER_WALLPAPER_MAX_COUNT}`) && MEMBER_WALLPAPER_MAX_COUNT === 5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
