/* ==========================================================================
   Premium profiles (P6) — the pieces that must agree with each other
   --------------------------------------------------------------------------
     - the prices shown in the browser are the prices the gateway charges
     - the rank order is the same in the browser, the admin function and the
       gateway, so "already holds this tier" means the same thing everywhere
     - the accent palette is the same in the browser, the database and the
       admin function
     - the view helpers decide what is shown correctly
   Reads the Deno functions as text, because they cannot be imported in Node.
   ========================================================================== */

import { readFileSync } from "node:fs";
import { PREMIUM_TIERS, PREMIUM_ACCENTS } from "../public/js/config/env.js";
import {
  TIER_RANK,
  activeTier,
  buyableTiers,
  pendingOrders,
  hoursUntilDue,
  ringAttributes,
  statusLine
} from "../public/js/lib/premium.js";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const gateway = read("supabase/functions/payments/index.ts");
const admin = read("supabase/functions/admin/index.ts");
const migration = read("supabase/migrations/0054_premium_profiles.sql");

console.log("prices");
const charged = {};
for (const match of gateway.matchAll(/(glow|elite): \{ amount: (\d+), label: "[^"]+", rank: (\d+) \}/g)) {
  charged[match[1]] = { amount: Number(match[2]), rank: Number(match[3]) };
}
check("the gateway defines both premium tiers", Object.keys(charged).sort().join(",") === "elite,glow", JSON.stringify(charged));
for (const tier of PREMIUM_TIERS) {
  check(
    `${tier.name} is shown at the price the gateway charges`,
    charged[tier.id]?.amount === tier.priceRupees * 100,
    `shown ₹${tier.priceRupees}, charged ${charged[tier.id]?.amount} paise`
  );
}
check("the tiers are listed in rank order", PREMIUM_TIERS.map((t) => t.id).join(",") === "glow,elite");

console.log("rank order");
for (const [id, rank] of Object.entries(charged)) {
  check(`${id} has the same rank in the browser as in the gateway`, TIER_RANK[id] === rank.rank);
}
check(
  "the admin function ranks the tiers the same way",
  /PREMIUM_RANK: Record<string, number> = \{ glow: 1, elite: 2 \}/.test(admin)
);

console.log("accent palette");
const palette = PREMIUM_ACCENTS.map((a) => a.id);
const sqlPalette = [...migration.matchAll(/accent in \(([^)]+)\)/g)][0]?.[1]
  ?.split(",").map((s) => s.trim().replace(/'/g, "")) ?? [];
check("the database allows the same palette the browser offers", sqlPalette.join(",") === palette.join(","), sqlPalette.join(","));
check(
  "the admin function allows the same palette",
  (admin.match(/PREMIUM_ACCENTS = \[([^\]]+)\]/)?.[1] ?? "").replace(/["\s]/g, "") === palette.join(",")
);
check("the set_premium_accent function refuses values outside the palette", /p_accent not in \('violet', 'rose', 'amber', 'teal', 'sky'\)/.test(migration));

console.log("view helpers");
check("a Free member can buy both tiers", buyableTiers(null).map((t) => t.id).join(",") === "glow,elite");
check("a Glow member can only buy Elite", buyableTiers({ tier: "glow" }).map((t) => t.id).join(",") === "elite");
check("an Elite member has nothing to buy", buyableTiers({ tier: "elite" }).length === 0);
check("an unknown tier counts as Free", activeTier({ tier: "platinum" }) === null);
check("a Glow member gets no accent in the ring", JSON.stringify(ringAttributes({ tier: "glow", accent: "rose" })) === JSON.stringify({ tier: "glow", accent: null }));
check("an Elite member's accent is in the ring", ringAttributes({ tier: "elite", accent: "rose" }).accent === "rose");
check("a Free member gets no ring", ringAttributes(null).tier === null);

const now = Date.parse("2026-11-04T06:00:00Z");
const orders = [
  { id: "a", tier: "glow", status: "activated", created_at: "2026-11-01T00:00:00Z", due_by: "2026-11-02T00:00:00Z" },
  { id: "b", tier: "elite", status: "awaiting_activation", created_at: "2026-11-03T00:00:00Z", due_by: "2026-11-04T00:00:00Z" },
  { id: "c", tier: "glow", status: "awaiting_activation", created_at: "2026-11-04T01:00:00Z", due_by: "2026-11-05T01:00:00Z" }
];
check("only orders waiting for activation are pending", pendingOrders(orders).map((o) => o.id).join(",") === "c,b", pendingOrders(orders).map((o) => o.id).join(","));
check("hours left never go negative", hoursUntilDue({ due_by: "2026-11-04T00:00:00Z" }, now) === 0);
check("hours left are rounded to a tenth", hoursUntilDue({ due_by: "2026-11-04T09:30:00Z" }, now) === 3.5);
check("an order with no due time has no countdown", hoursUntilDue({}, now) === null);
const soon = new Date(Date.now() + 3 * 36e5 + 60e3).toISOString();
check(
  "a pending order is described with its time left",
  statusLine(null, [{ tier: "elite", status: "awaiting_activation", created_at: "2026-11-04", due_by: soon }]) ===
    "Payment for Elite is confirmed. We activate it within 24 hours (about 3 h left)."
);
check("an active tier with a pending order says both", /Elite is active\. A further order/.test(statusLine({ tier: "elite" }, [orders[1]])));
check("a Free member with nothing pending is told plainly", /Free plan/.test(statusLine(null, [])));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
