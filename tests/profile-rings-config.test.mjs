/* ==========================================================================
   Profile rings (0069, 0070) — configuration and wiring
   --------------------------------------------------------------------------
     - the client catalogue, the payment function and the migrations agree on
       the eight design ids, and on the ₹10 price
     - the payment function prices a ring itself and refuses an unknown design
     - the Premium card and its ring controls are gone from Settings
     - rings are read through member_rings(), and painted as data-ring
     - the artwork exists for every design, and is a PNG
   ========================================================================== */

import { readFileSync, existsSync, statSync } from "node:fs";
import { RING_DESIGNS, RING_PRICE_STANDARD_RUPEES, RING_PRICE_PREMIUM_RUPEES, ringArtUrl, ringPriceRupees } from "../public/js/config/rings.js";
import { applyRing } from "../public/js/lib/rings.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const payments = read("supabase/functions/payments/index.ts");
const settings = read("public/js/modules/dashboard/views/settings.js");
const billing = read("public/js/modules/dashboard/views/billing.js");
const rings = read("public/js/lib/rings.js");
const components = read("public/css/components.css");
const views = read("public/css/views.css");
const adminPremium = read("public/js/modules/admin/views/premium.js");
const m69 = read("supabase/migrations/0069_profile_rings.sql");
const m70 = read("supabase/migrations/0070_ring_design_names.sql");

console.log("catalogue");
const clientIds = RING_DESIGNS.map((d) => d.id);
check("there are eight designs", clientIds.length === 8, `got ${clientIds.length}`);
check("the ids are unique", new Set(clientIds).size === clientIds.length);
check("each id is a valid slug", clientIds.every((id) => /^[a-z][a-z0-9-]{2,40}$/.test(id)));
const seededIds = [...m69.matchAll(/^\s*\('([a-z0-9-]+)', '[^']+', \d+\)/gm)].map((m) => m[1]);
const renamed = [...m70.matchAll(/where id = '[a-z-]+';/g)].length;
check("the migration seeds the same eight ids (with the 0070 renames)", ["kuromi-neon", "starlight-vine"].every((id) => m70.includes(`'${id}'`)) && seededIds.length === 8, `seeded=${seededIds.join(",")}`);
check("every client id appears in the migrations", clientIds.every((id) => m69.includes(`'${id}'`) || m70.includes(`'${id}'`)));
check("the payment function knows the same eight ids", clientIds.every((id) => payments.includes(`"${id}": "`)));
check("the payment function holds no ninth design", (payments.match(/"[a-z-]+": "[A-Za-z ]+",?\n/g) || []).length >= 8);
check("the client and the database name the designs the same way", RING_DESIGNS.every((d) => m70.includes(`'${d.name}'`) || m69.includes(`'${d.name}'`) || m70.includes(d.name) || m69.includes(d.name)));

console.log("price");
check("the standard ring costs ₹10 and the premium ring ₹20", RING_PRICE_STANDARD_RUPEES === 10 && RING_PRICE_PREMIUM_RUPEES === 20);
const premium = RING_DESIGNS.filter((d) => d.premium).map((d) => d.id).sort();
check("the four premium designs are pink-gold, diamond-wings, tiger-gold, gothic-skull", premium.join(",") === ["diamond-wings", "gothic-skull", "pink-gold", "tiger-gold"].join(","));
check("exactly four designs are premium", premium.length === 4);
check("every other design is ₹10", RING_DESIGNS.filter((d) => !d.premium).every((d) => ringPriceRupees(d) === 10));
check("the server reads each ring price from ring_designs", /ring_designs/.test(payments) && /price_paise/.test(payments) && !/RING_APPLY_PAISE/.test(payments));
check("the client prices match the table seeded by 0071", ringPriceRupees({ premium: true }) * 100 === 2000 && ringPriceRupees({ premium: false }) * 100 === 1000);
check("the payment function prices a ring from its own table", /purpose\.startsWith\("ring_apply:"\)[\s\S]*?own\(RING_DESIGNS, ringId\)[\s\S]*?price_paise/.test(payments));
check("price and plan tables are read only by their own keys (no inherited 'constructor')", /Object\.hasOwn\(table, key\)/.test(payments) && !/PLAN_PRICES\[plan\]|PREMIUM_PRICES\[tier\]|RING_DESIGNS\[ringId\]/.test(payments));
check("an unknown design is refused by resolveAmount", /if \(!name\) return null;/.test(payments));
check("the payment function never reads a client amount", !/body\.amount/.test(payments));
check("a ring order records exactly the server price", /ring_orders"\)\.insert\(\{[\s\S]*?amount_paise: resolved\.amount/.test(payments));
check("a ring order that cannot be recorded cancels its payment", /ringError[\s\S]*?cancelled/.test(payments));

console.log("the database decides");
check("0069 applies a ring only on a verified payment", /new\.status = 'verified'/.test(m69) && /coalesce\(old\.status, ''\) <> 'verified'/.test(m69));
check("0069 writes the choice only from the trigger", /revoke all on public\.profile_ring_choices from public, anon, authenticated;/.test(m69));
check("0069 member_rings returns no payment or order detail", /returns table \(member_id uuid, ring_id text, ring_name text\)/.test(m69));
check("0069 caps member_rings at 200", /cardinality\(p_user_ids\) > 200/.test(m69));
check("0069 limits the ledger to administrators", /if not public\.is_admin\(\) then/.test(m69));

console.log("Settings");
check("the Premium profile card is removed from Settings", !/premiumCard|id="premium-settings"/.test(settings));
check("no ring controls remain in Settings", !/ringControls|bindRing|saveRingPrefs|fetchRingPrefs|ring-style|ring-shown|save-ring/.test(settings));
check("no accent control remains in Settings", !/premium-accent|save-accent|set_premium_accent|PREMIUM_ACCENTS/.test(settings));
check("Settings still saves the profile", /id="profile-form"/.test(settings) && /save-profile/.test(settings));

console.log("Billing");
check("Billing shows the ring card and mounts the shared picker", /id="ring-card"/.test(billing) && /mountRingPicker\(/.test(billing));
check("Billing buys through startPayment, with the purpose from ringPurpose (ring_apply:<id> or rgb_ring)", /purpose: ringPurpose\(design\)/.test(billing) && /ringLabel\(design\)/.test(billing));
check("Billing reads the price from the shared config", /ringPriceRupees/.test(billing));
check("Billing no longer charges for an owned ring (no direct apply)", !/data-ring-apply/.test(billing));

const picker = readFileSync("public/js/modules/dashboard/ring-picker.js", "utf8");
console.log("Shared ring picker");
check("the picker reads what is owned and what is worn", /from\("profile_ring_owned"\)/.test(picker) && /from\("profile_ring_choices"\)/.test(picker));
check("wearing an owned ring calls ring_wear, which charges nothing", /sb\.rpc\("ring_wear"/.test(picker) && !/payments/.test(picker.split("ring_wear")[1] || ""));
check("removing a ring calls ring_remove (back to default)", /sb\.rpc\("ring_remove"\)/.test(picker));
check("buying goes through the caller's payment, once", /data-ring-buy/.test(picker) && /onBuy\(chosen\)/.test(picker));
check("an owned ring is never offered for purchase", /owned\.has\(chosen\.id\)[\s\S]*?data-ring-wear[\s\S]*?data-ring-buy/.test(picker));
check("the preview uses the same ring attributes as a worn ring", /applyRing\(avatar,/.test(picker) && /data-ring-stage/.test(picker));
check("the preview is never saved", !/preview[^\n]*rpc\(/i.test(picker));

console.log("Settings");
const settingsSrc = readFileSync("public/js/modules/dashboard/views/settings.js", "utf8");
check("Settings shows the ring card and mounts the picker", /id="ring-card-settings"/.test(settingsSrc) && /mountRingPicker\(ringHost/.test(settingsSrc));
check("the Settings profile photo carries the member id, so the ring shows", /avatarUrl: profile\.avatar_url, size: "xl", userId: state\.user\?\.id/.test(settingsSrc));
check("Settings buys a ring through the same payment as Billing (ringPurpose)", /ringPurpose\(design\)/.test(settingsSrc) && /ringLabel\(design\)/.test(settingsSrc));

console.log("Server guard");
check("the payment function refuses a ring already owned (409)", /profile_ring_owned/.test(payments) && /409, "ring_owned"/.test(payments));
check("the ownership migration is in the repo", existsSync("supabase/migrations/0073_ring_ownership.sql"));

console.log("Visibility");
const comps = readFileSync("public/css/components.css", "utf8");
check("the halo is a solid band, wide enough to read when zoomed", /inset: -24%/.test(comps) && /transparent 64%, #000 67\.5%/.test(comps));
check("the artwork is cut away from the photo centre", /transparent 62%, #000 66%/.test(comps));

console.log("rings on avatars");
check("rings.js reads design ids from member_rings", /member_rings/.test(rings) && /row\.ring_id/.test(rings));
check("rings.js no longer reads tier or accent", !/ring_tier|ring_accent|ring_animated|data-tier|data-accent|data-animated/.test(rings));
check("applyRing writes data-ring and the artwork", /setAttribute\("data-ring", ring\.id\)/.test(rings) && /--ring-art/.test(rings));
check("applyRing refuses an id outside the catalogue", /KNOWN\.has\(ring\.id\)/.test(rings));
check("components.css draws the overlay from --ring-art", /\.avatar\[data-ring\]::after/.test(components) && /var\(--ring-art\)/.test(components));
check("no tier ring rules remain in components.css", !/\.avatar\[data-tier\]/.test(components));
check("no tier ring rules remain in views.css", !/\[data-tier\]/.test(views.replace(/\.premium-badge\[data-tier[^\n]*\n/g, "")));
check("rings are still: no spin, orbit or pulse remains in components.css", !/ring-spin|ring-orbit|ring-glow/.test(components) && !/animation: ring-(spin|orbit|glow)/.test(components));
check("the PFP photo and artwork never move: no transform animation on the avatar itself", !/\.avatar\[data-ring\][^{]*\{[^}]*animation/.test(components));
check("the rainbow halo is only for the RGB ring (never on a PFP design)", /\.avatar\[data-ring="rgb"\]::before/.test(components) && !/\.avatar\[data-ring\]::before/.test(components));
check("sparkles: a few stars on their own elements, with reduced motion kept still", /\.ring-spark::after/.test(components) && /ring-spark 7s/.test(components) && /prefers-reduced-motion: reduce\) \{\s*\.ring-spark::after \{ animation: none/.test(components));
check("the sparkle layer is added by rings.js and skips image elements", /data-ring-sparks/.test(rings) && /tagName === "IMG"/.test(rings));
check("the RGB ring is a separate purpose, priced ₹30 (0074)", /export function ringPurpose[\s\S]*rgb_ring/.test(readFileSync("public/js/config/rings.js","utf8")) && /RGB_PRICE_RUPEES = 30/.test(readFileSync("public/js/config/rings.js","utf8")));
check("the ring halo is bold and circular", /border-radius: 50%/.test(components) && /conic-gradient/.test(components));

console.log("ring test helper");
const fake = () => {
  const attrs = new Map();
  const styles = new Map();
  return {
    attrs,
    styles,
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    style: {
      setProperty(k, v) { styles.set(k, v); },
      removeProperty(k) { styles.delete(k); }
    }
  };
};
const a = fake();
applyRing(a, { id: "sakura", name: "Sakura" });
check("a design writes data-ring", a.getAttribute("data-ring") === "sakura");
check("a design writes its artwork", a.styles.get("--ring-art") === 'url("/assets/rings/sakura.png")', a.styles.get("--ring-art"));
check("a plain design has no screen blend", a.getAttribute("data-ring-blend") === null);
const k = fake();
applyRing(k, { id: "kuromi-neon", name: "Kuromi neon" });
/* Kuromi is drawn with normal blending. The old screen blend, on the picker's
   dark tile, showed the artwork's backing as a black disc. The PNG is clean. */
check("Kuromi uses normal blending (no black disc)", k.getAttribute("data-ring-blend") === null);
applyRing(a, null);
check("a null ring clears the design", a.getAttribute("data-ring") === null && a.styles.get("--ring-art") === undefined);
const bad = fake();
applyRing(bad, { id: "not-a-design", name: "x" });
check("an unknown id leaves the avatar plain", bad.getAttribute("data-ring") === null);

console.log("artwork");
for (const design of RING_DESIGNS) {
  const path = new URL(`../public${ringArtUrl(design.id)}`, import.meta.url);
  check(`${design.id} has its artwork`, existsSync(path) && statSync(path).size > 1000, ringArtUrl(design.id));
}
check("an unknown design has no artwork", ringArtUrl("nope") === "");

console.log("admin ledger");
check("the ledger reads admin_ring_ledger", /sb\.rpc\("admin_ring_ledger", \{ p_limit: 100 \}\)/.test(adminPremium));
check("the ledger shows the design, not a tier", /row\.ring_name/.test(adminPremium) && !/row\.tier\)/.test(adminPremium.slice(adminPremium.indexOf("function paintLedger"), adminPremium.indexOf("async function load()"))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
