/* ==========================================================================
   Ring management (R8) — the browser side agrees with the database
   --------------------------------------------------------------------------
     - a free member has no ring; Glow and Elite animate unless still is chosen
     - Elite keeps its accent; Glow never gets one
     - applyRing writes data-animated and clears everything on a null ring
     - settings offers style and visibility to Glow and Elite only, and saves
       through ring_prefs_set
     - the admin ledger reads admin_ring_ledger, and the member view never does
     - the CSS animates ring elements only, is faster for Elite, and stops for
       reduced motion
   ========================================================================== */

import { readFileSync } from "node:fs";
import { ringAttributes, activeTier } from "../public/js/lib/premium.js";
import { applyRing } from "../public/js/lib/rings.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const settings = read("public/js/modules/dashboard/views/settings.js");
const ledgerView = read("public/js/modules/admin/views/premium.js");
const views = read("public/css/views.css");

console.log("ring attributes");
const free = ringAttributes({ tier: null });
check("a free member has no ring", free.tier === null && activeTier({ tier: null }) === null);
const glow = ringAttributes({ tier: "glow", accent: "rose" });
check("a Glow member gets a ring that animates by default", glow.tier === "glow" && glow.animated === true, JSON.stringify(glow));
check("Glow never gets an accent", glow.accent === null);
const elite = ringAttributes({ tier: "elite", accent: "teal" }, { animated: true });
check("an Elite member keeps their accent", elite.accent === "teal" && elite.animated === true, JSON.stringify(elite));
check("a still ring is reported as not animated", ringAttributes({ tier: "glow" }, { animated: false }).animated === false);
check("a missing preference means animated", ringAttributes({ tier: "elite" }, null).animated === true);

console.log("applying a ring");
const fakeNode = () => {
  const attrs = new Map();
  return {
    attrs,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k)
  };
};
const a = fakeNode();
applyRing(a, { tier: "elite", accent: "rose", animated: true });
check("an animated ring writes data-animated=true", a.getAttribute("data-animated") === "true");
check("an accent is written", a.getAttribute("data-accent") === "rose");
const b = fakeNode();
applyRing(b, { tier: "glow", accent: null, animated: false });
check("a still ring writes data-animated=false", b.getAttribute("data-animated") === "false");
check("a Glow ring carries no accent", b.getAttribute("data-accent") === null);
applyRing(b, null);
check("a null ring clears tier, accent and animation", b.getAttribute("data-tier") === null && b.getAttribute("data-animated") === null && b.getAttribute("data-accent") === null);

console.log("settings");
check("settings shows ring style to Glow and Elite (not free)", /ringControls\(tier\)/.test(settings) && /\$\{tier \? `<div id="ring-settings"/.test(settings));
check("the style control offers animated and still", /value="animated"/.test(settings) && /value="still"/.test(settings));
check("the visibility control is a checkbox named ring-shown", /id="ring-shown"/.test(settings));
check("save goes through saveRingPrefs", /await saveRingPrefs\(animated, shown\)/.test(settings));
check("settings loads prefs through fetchRingPrefs", /ringPrefs = await fetchRingPrefs\(\)/.test(settings));
check("the copy says hiding does not change the plan", /Hiding your ring does not change your plan/.test(settings));
check("the member view never reads the admin ledger", !/admin_ring_ledger/.test(settings));

console.log("admin ledger");
check("the ledger reads admin_ring_ledger with the admin session", /sb\.rpc\("admin_ring_ledger", \{ p_limit: 100 \}\)/.test(ledgerView));
check("the ledger shows amount, status, paid time and visibility", /money\(Number\(row\.payment_amount/.test(ledgerView) && /row\.payment_status/.test(ledgerView) && /row\.paid_at/.test(ledgerView) && /row\.ring_shown/.test(ledgerView));
check("the ledger is inside the premium profiles view", /ring-ledger-card/.test(ledgerView) && /Premium profiles/.test(ledgerView));
check("the ledger does not show card or bank details", !/card_(number|last|brand)|account_number|bank_|payer_upi|payerUpi/i.test(ledgerView));

console.log("animation CSS");
const r8 = views.slice(views.indexOf("R8 — ring animation"));
check("the ring animation is keyed to ring elements only", /\.avatar\[data-tier\]:not\(\[data-animated="false"\]\)/.test(r8) && /\[data-ring-user\]\[data-tier\]:not\(\[data-animated="false"\]\)/.test(r8));
check("the badge never pulses", !/\.premium-badge[^{]*\{[^}]*animation/.test(r8));
check("Elite pulses faster than Glow", /animation-duration: 1\.6s/.test(r8) && /ring-breathe 3\.2s/.test(r8));
check("reduced motion stops the ring", /prefers-reduced-motion: reduce/.test(r8) && /animation: none !important/.test(r8));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
