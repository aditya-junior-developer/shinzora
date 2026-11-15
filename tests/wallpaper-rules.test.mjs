/* ==========================================================================
   Wallpapers (P10) — the browser rules and the catalog they depend on
   --------------------------------------------------------------------------
     - only Shinzora's own theme paths or https addresses can reach a CSS url()
     - a locked collection never yields an image, even if a stale catalog says so
     - a saved choice that is no longer allowed falls back to the default and is
       reported, so the Settings page can say why
     - every wallpaper the migration seeds exists on disk, so no member gets a
       broken tile
   ========================================================================== */

import { readFileSync, existsSync } from "node:fs";
import {
  isSafeWallpaperUrl,
  resolveWallpaper,
  savedChoiceUnavailable,
  tierLabel
} from "../public/js/config/wallpaper-rules.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

console.log("image addresses");
check("a Shinzora theme path is accepted", isSafeWallpaperUrl("/assets/themes/anime-petal-sky.svg"));
check("an https address is accepted", isSafeWallpaperUrl("https://cdn.example.com/art/a.png"));
check("a javascript address is refused", !isSafeWallpaperUrl("javascript:alert(1)"));
check("a plain http address is refused", !isSafeWallpaperUrl("http://example.com/a.png"));
check("a path outside the theme folder is refused", !isSafeWallpaperUrl("/assets/payments/upi-qr.png"));
check("a traversal path is refused", !isSafeWallpaperUrl("/assets/themes/../secret.svg"));
check("a quote that could break out of url() is refused", !isSafeWallpaperUrl('https://x.example.com/a"b.png'));
check("a parenthesis that could break out of url() is refused", !isSafeWallpaperUrl("https://x.example.com/a)b.png"));
check("a space is refused", !isSafeWallpaperUrl("https://x.example.com/a b.png"));
check("an empty value is refused", !isSafeWallpaperUrl(""));
check("a missing value is refused", !isSafeWallpaperUrl(null));
check("a value over 500 characters is refused", !isSafeWallpaperUrl(`https://x.example.com/${"a".repeat(500)}`));

const catalog = {
  tier: "glow",
  chosenWallpaperId: "w-anime",
  collections: [
    {
      id: "anime",
      name: "Anime",
      locked: false,
      requiredTier: "glow",
      wallpapers: [{ id: "w-anime", title: "Petal sky", imageUrl: "/assets/themes/anime-petal-sky.svg" }]
    },
    {
      id: "cyberpunk",
      name: "Cyberpunk",
      locked: true,
      requiredTier: "elite",
      wallpapers: [{ id: "w-neon", title: "Neon grid", imageUrl: null }]
    }
  ]
};

console.log("resolving the wallpaper to paint");
check("an unlocked, chosen wallpaper resolves", resolveWallpaper(catalog, "w-anime")?.imageUrl === "/assets/themes/anime-petal-sky.svg");
check("the resolved wallpaper names its collection", resolveWallpaper(catalog, "w-anime")?.collectionName === "Anime");
check("no choice means the default background", resolveWallpaper(catalog, null) === null);
check("an unknown choice means the default background", resolveWallpaper(catalog, "w-missing") === null);
check("a locked collection never yields an image", resolveWallpaper(catalog, "w-neon") === null);
const staleLocked = {
  collections: [{ id: "cyberpunk", name: "Cyberpunk", locked: true, wallpapers: [{ id: "w-neon", title: "Neon", imageUrl: "/assets/themes/cyber-neon-grid.svg" }] }]
};
check("a stale catalog that leaks a locked image is still refused", resolveWallpaper(staleLocked, "w-neon") === null);
const unsafe = {
  collections: [{ id: "x", name: "X", locked: false, wallpapers: [{ id: "w-bad", title: "Bad", imageUrl: 'https://x.example.com/a")' }] }]
};
check("an unsafe address is never painted, even from an unlocked collection", resolveWallpaper(unsafe, "w-bad") === null);
check("no catalog means the default background", resolveWallpaper(null, "w-anime") === null);

console.log("saved choices that lapsed");
check("a choice that is still allowed is not reported", savedChoiceUnavailable(catalog) === false);
check("a locked choice is reported", savedChoiceUnavailable({ ...catalog, chosenWallpaperId: "w-neon" }) === true);
check("no choice is not reported", savedChoiceUnavailable({ ...catalog, chosenWallpaperId: null }) === false);

console.log("tier names");
check("Glow is named", tierLabel("glow") === "Glow");
check("Elite is named", tierLabel("elite") === "Elite");
check("no requirement reads as Free", tierLabel(null) === "Free");

console.log("seeded artwork exists");
const migration = readFileSync(new URL("../supabase/migrations/0059_theme_collections.sql", import.meta.url), "utf8");
const seeded = [...migration.matchAll(/'(\/assets\/themes\/[a-z0-9._-]+\.svg)'/g)].map((m) => m[1]);
check("the migration seeds eight wallpapers", seeded.length === 8, String(seeded.length));
const missing = seeded.filter((path) => !existsSync(new URL(`../public${path}`, import.meta.url)));
check("every seeded wallpaper exists in public/assets/themes", missing.length === 0, missing.join(", "));
const svgSafe = seeded.every((path) => {
  const text = readFileSync(new URL(`../public${path}`, import.meta.url), "utf8");
  return !/<script|<foreignObject|on[a-z]+\s*=|href\s*=\s*["']https?:/i.test(text);
});
check("no seeded SVG carries script, foreign content or remote links", svgSafe);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
