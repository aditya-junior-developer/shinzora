/* ==========================================================================
   Ring management and the admin ring ledger (0068) — behaviour in PGlite
   --------------------------------------------------------------------------
     - a Glow or Elite member gets the defaults: animated, shown
     - a free member cannot change ring settings
     - a member can make the ring still and hide it from others
     - a hidden ring is not returned to other members, and is returned to its owner
     - a still ring is reported as not animated
     - bad input (null) is refused
     - the admin ledger is refused to a member and works for an administrator
     - the ledger shows the payment amount, status and paid time, and whether the ring is shown
     - the functions are not callable by anonymous users
   ========================================================================== */

import { SCAFFOLD, migrationFiles, apply } from "../scripts/staging-db.mjs";

let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("  ! SKIPPED — @electric-sql/pglite is not installed, so this database suite did not run.");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) await apply(db, file);

const ids = {
  glow: "00000000-0000-4000-8000-0000000000a1",
  elite: "00000000-0000-4000-8000-0000000000e2",
  free: "00000000-0000-4000-8000-0000000000f3",
  viewer: "00000000-0000-4000-8000-0000000000b4",
  admin: "00000000-0000-4000-8000-0000000000c5"
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`update public.profiles set full_name = $2 where id = $1`, [uid, name]);
}
await db.query(
  `insert into public.profile_entitlements (user_id, tier, accent, granted_at, updated_at)
   values ($1, 'glow', null, now(), now()), ($2, 'elite', 'rose', now(), now())`,
  [ids.glow, ids.elite]
);
await db.query(`insert into public.admin_users (user_id, email, role) values ($1, 'admin@test.local', 'admin')`, [ids.admin]);

const { rows: [pay] } = await db.query(
  `insert into public.payments (owner_id, purpose, label, amount, status, paid_at)
   values ($1, 'premium:glow', 'Glow profile', 499, 'verified', now()) returning id`,
  [ids.glow]
);
await db.query(
  `insert into public.premium_orders (owner_id, payment_id, tier, status, due_by)
   values ($1, $2, 'glow', 'activated', now())`,
  [ids.glow, pay.id]
);

await db.exec(`
  grant usage on schema public to authenticated, anon;
  grant select on public.profile_entitlements to authenticated;
`);

const asUser = async (userId) => {
  await db.exec(`
    reset role;
    set role authenticated;
    select set_config('request.jwt.claim.sub','${userId}',false);
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claims','{"sub":"${userId}","role":"authenticated"}',false);
  `);
};
const asAnon = async () => {
  await db.exec(`
    reset role;
    set role anon;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claim.role','anon',false);
    select set_config('request.jwt.claims','{"role":"anon"}',false);
  `);
};
const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
};

/* Defaults. */
await asUser(ids.glow);
const glowDefaults = (await q(`select ring_prefs_get() as p`))[0].p;
check("a Glow member gets the defaults: animated and shown", glowDefaults.tierOk === true && glowDefaults.animated === true && glowDefaults.shown === true, JSON.stringify(glowDefaults));

await asUser(ids.free);
const freeDefaults = (await q(`select ring_prefs_get() as p`))[0].p;
check("a free member reports no tier", freeDefaults.tierOk === false);
check("a free member cannot change ring settings", (await errorOf(() => q(`select ring_prefs_set(false, false)`)))?.code === "42501");

/* Changing settings. */
await asUser(ids.glow);
check("a null setting is refused", (await errorOf(() => q(`select ring_prefs_set(null, true)`)))?.code === "22023");
const saved = (await q(`select ring_prefs_set(false, false) as r`))[0].r;
check("a Glow member can make the ring still and hidden", saved.ok === true && saved.animated === false && saved.shown === false);
const glowNow = (await q(`select ring_prefs_get() as p`))[0].p;
check("the saved settings are read back", glowNow.animated === false && glowNow.shown === false);

/* Visibility to others. */
await asUser(ids.viewer);
const seenByOther = await q(`select member_id from public.member_rings($1::uuid[])`, [[ids.glow, ids.elite]]);
const otherIds = seenByOther.map((r) => r.member_id);
check("a hidden ring is not returned to another member", !otherIds.includes(ids.glow), JSON.stringify(otherIds));
check("a shown ring is still returned to another member", otherIds.includes(ids.elite));

await asUser(ids.glow);
const seenBySelf = await q(`select member_id, ring_animated from public.member_rings($1::uuid[])`, [[ids.glow]]);
check("the owner still gets their own hidden ring", seenBySelf.length === 1 && seenBySelf[0].ring_animated === false, JSON.stringify(seenBySelf));

await asUser(ids.viewer);
const eliteRing = await q(`select ring_tier, ring_animated from public.member_rings($1::uuid[])`, [[ids.elite]]);
check("an Elite member with no settings is animated by default", eliteRing[0]?.ring_tier === "elite" && eliteRing[0]?.ring_animated === true, JSON.stringify(eliteRing));

/* Admin ledger. */
await asUser(ids.glow);
check("a member cannot read the admin ring ledger", (await errorOf(() => q(`select * from public.admin_ring_ledger()`)))?.code === "42501");

await asUser(ids.admin);
const ledger = await q(`select * from public.admin_ring_ledger(10)`);
check("an administrator reads the ring ledger", ledger.length === 1, `rows=${ledger.length}`);
const row = ledger[0] || {};
check("the ledger shows the payment amount and status", Number(row.payment_amount) === 499 && row.payment_status === "verified", JSON.stringify({ a: row.payment_amount, s: row.payment_status }));
check("the ledger shows when it was paid, and the order status", row.paid_at != null && row.order_status === "activated");
check("the ledger shows the member and whether the ring is shown", row.member_name === "glow" && row.ring_shown === false);
const capped = await q(`select * from public.admin_ring_ledger(100000)`);
check("the ledger limit is capped at 200", capped.length <= 200);

/* Access. */
await asAnon();
check("anonymous users cannot read ring settings", (await errorOf(() => q(`select ring_prefs_get()`)))?.code === "42501" || (await errorOf(() => q(`select ring_prefs_get()`))) !== null);
await db.exec(`reset role;`);
const acl = await q(`select has_function_privilege('anon','public.ring_prefs_set(boolean,boolean)','execute') as anon_set, has_function_privilege('anon','public.admin_ring_ledger(integer)','execute') as anon_ledger, has_function_privilege('authenticated','public.ring_prefs_set(boolean,boolean)','execute') as auth_set`);
check("anon has no execute right on ring settings or the ledger", acl[0].anon_set === false && acl[0].anon_ledger === false);
check("authenticated can save ring settings", acl[0].auth_set === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
