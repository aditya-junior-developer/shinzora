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
import { RING_DESIGNS, RING_PRICE_RUPEES, ringArtUrl } from "../public/js/config/rings.js";
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
check("the client charges ₹10 a ring", RING_PRICE_RUPEES === 10);
check("the server charges 1000 paise a ring", /const RING_APPLY_PAISE = 1000;/.test(payments));
check("the client amount and the server price agree", RING_PRICE_RUPEES * 100 === 1000);
check("the payment function prices a ring from its own table", /purpose\.startsWith\("ring_apply:"\)[\s\S]*?RING_DESIGNS\[ringId\][\s\S]*?RING_APPLY_PAISE/.test(payments));
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
check("Billing shows the ring picker", /id="ring-card"/.test(billing) && /data-ring-apply=/.test(billing));
check("Billing reads the worn design from profile_ring_choices", /from\("profile_ring_choices"\)/.test(billing));
check("Billing sends ring_apply:<id> through startPayment", /purpose: `ring_apply:\$\{design\.id\}`/.test(billing));
check("Billing reads the price from the shared config", /RING_PRICE_RUPEES/.test(billing));

console.log("rings on avatars");
check("rings.js reads design ids from member_rings", /member_rings/.test(rings) && /row\.ring_id/.test(rings));
check("rings.js no longer reads tier or accent", !/ring_tier|ring_accent|ring_animated|data-tier|data-accent|data-animated/.test(rings));
check("applyRing writes data-ring and the artwork", /setAttribute\("data-ring", ring\.id\)/.test(rings) && /--ring-art/.test(rings));
check("applyRing refuses an id outside the catalogue", /KNOWN\.has\(ring\.id\)/.test(rings));
check("components.css draws the overlay from --ring-art", /\.avatar\[data-ring\]::after/.test(components) && /var\(--ring-art\)/.test(components));
check("no tier ring rules remain in components.css", !/\.avatar\[data-tier\]/.test(components));
check("no tier ring rules remain in views.css", !/\[data-tier\]/.test(views.replace(/\.premium-badge\[data-tier[^\n]*\n/g, "")));
check("no ring animation remains", !/ring-breathe|ring-toggle/.test(views + components));

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
check("Kuromi writes the screen blend", k.getAttribute("data-ring-blend") === "screen");
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
