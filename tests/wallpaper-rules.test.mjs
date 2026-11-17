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

import { readFileSync, existsSync, readdirSync } from "node:fs";
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
check("a Shinzora theme path is accepted", isSafeWallpaperUrl("/assets/themes/glow-01.jpg"));
check("an https address is accepted", isSafeWallpaperUrl("https://cdn.example.com/art/a.png"));
check("a javascript address is refused", !isSafeWallpaperUrl("javascript:alert(1)"));
check("a plain http address is refused", !isSafeWallpaperUrl("http://example.com/a.png"));
check("a path outside the theme folder is refused", !isSafeWallpaperUrl("/assets/payments/upi-qr.png"));
check("a traversal path is refused", !isSafeWallpaperUrl("/assets/themes/../secret.jpg"));
check("a quote that could break out of url() is refused", !isSafeWallpaperUrl('https://x.example.com/a"b.png'));
check("a parenthesis that could break out of url() is refused", !isSafeWallpaperUrl("https://x.example.com/a)b.png"));
check("a space is refused", !isSafeWallpaperUrl("https://x.example.com/a b.png"));
check("an empty value is refused", !isSafeWallpaperUrl(""));
check("a missing value is refused", !isSafeWallpaperUrl(null));
check("a value over 500 characters is refused", !isSafeWallpaperUrl(`https://x.example.com/${"a".repeat(500)}`));

const catalog = {
  tier: "glow",
  chosenWallpaperId: "w-glow",
  collections: [
    {
      id: "glow",
      name: "Glow",
      locked: false,
      requiredTier: "glow",
      wallpapers: [{ id: "w-glow", title: "Petal sky", imageUrl: "/assets/themes/glow-01.jpg" }]
    },
    {
      id: "elite",
      name: "Elite",
      locked: true,
      requiredTier: "elite",
      wallpapers: [{ id: "w-neon", title: "Elite I", imageUrl: null }]
    }
  ]
};

console.log("resolving the wallpaper to paint");
check("an unlocked, chosen wallpaper resolves", resolveWallpaper(catalog, "w-glow")?.imageUrl === "/assets/themes/glow-01.jpg");
check("the resolved wallpaper names its collection", resolveWallpaper(catalog, "w-glow")?.collectionName === "Glow");
check("no choice means the default background", resolveWallpaper(catalog, null) === null);
check("an unknown choice means the default background", resolveWallpaper(catalog, "w-missing") === null);
check("a locked collection never yields an image", resolveWallpaper(catalog, "w-neon") === null);
const staleLocked = {
  collections: [{ id: "cyberpunk", name: "Cyberpunk", locked: true, wallpapers: [{ id: "w-neon", title: "Neon", imageUrl: "/assets/themes/elite-01.jpg" }] }]
};
check("a stale catalog that leaks a locked image is still refused", resolveWallpaper(staleLocked, "w-neon") === null);
const unsafe = {
  collections: [{ id: "x", name: "X", locked: false, wallpapers: [{ id: "w-bad", title: "Bad", imageUrl: 'https://x.example.com/a")' }] }]
};
check("an unsafe address is never painted, even from an unlocked collection", resolveWallpaper(unsafe, "w-bad") === null);
check("no catalog means the default background", resolveWallpaper(null, "w-glow") === null);

console.log("saved choices that lapsed");
check("a choice that is still allowed is not reported", savedChoiceUnavailable(catalog) === false);
check("a locked choice is reported", savedChoiceUnavailable({ ...catalog, chosenWallpaperId: "w-neon" }) === true);
check("no choice is not reported", savedChoiceUnavailable({ ...catalog, chosenWallpaperId: null }) === false);

console.log("tier names");
check("Glow is named", tierLabel("glow") === "Glow");
check("Elite is named", tierLabel("elite") === "Elite");
check("no requirement reads as Free", tierLabel(null) === "Free");

console.log("seeded artwork exists");
const migration = readFileSync(new URL("../supabase/migrations/0078_glow_elite_collections.sql", import.meta.url), "utf8");
const seeded = [...migration.matchAll(/'(\/assets\/themes\/[a-z0-9._-]+\.jpg)'/g)].map((m) => m[1]);
check("the migration seeds eight Glow and Elite wallpapers", seeded.length === 8, String(seeded.length));
const missing = seeded.filter((path) => !existsSync(new URL(`../public${path}`, import.meta.url)));
check("every seeded wallpaper exists in public/assets/themes", missing.length === 0, missing.join(", "));
const jpegs = seeded.every((path) => {
  const bytes = readFileSync(new URL(`../public${path}`, import.meta.url));
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
});
check("every seeded wallpaper is a real JPEG", jpegs);
check("no theme file is left over from the retired collections", !readdirSync(new URL("../public/assets/themes/", import.meta.url)).some((f) => f.endsWith(".svg")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
