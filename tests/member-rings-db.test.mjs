/* ==========================================================================
   Platform-wide profile rings (0066) — behaviour in PGlite
   --------------------------------------------------------------------------
     - a signed-in member gets the tier of anyone who holds one
     - accent is returned only for Elite; a Glow member has none
     - a member with no tier is simply absent (Free shows no ring)
     - nothing about the purchase leaves the function: no order, payment or due date
     - anonymous callers get no rows
     - more than 200 members in one call is refused
     - the owner-only table policy is unchanged for direct reads
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
  viewer: "00000000-0000-4000-8000-0000000000a1",
  glow: "00000000-0000-4000-8000-0000000000b2",
  elite: "00000000-0000-4000-8000-0000000000c3",
  free: "00000000-0000-4000-8000-0000000000d4"
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}
await db.query(
  `insert into public.profile_entitlements (user_id, tier, accent, granted_at, updated_at)
   values ($1, 'glow', null, now(), now()), ($2, 'elite', 'rose', now(), now())`,
  [ids.glow, ids.elite]
);
const { rows: [pay] } = await db.query(
  `insert into public.payments (owner_id, purpose, label, amount, status)
   values ($1, 'premium:elite', 'Elite profile', 1000, 'verified') returning id`,
  [ids.elite]
);
await db.query(
  `insert into public.premium_orders (owner_id, payment_id, tier, status, due_by, admin_note)
   values ($1, $2, 'elite', 'activated', now(), 'secret note')`,
  [ids.elite, pay.id]
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
const errorCode = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code || error.message;
  }
};

const all = [ids.viewer, ids.glow, ids.elite, ids.free];

await asUser(ids.viewer);
const rings = await q(`select member_id, ring_tier, ring_accent from public.member_rings($1::uuid[]) order by ring_tier`, [all]);
const byId = Object.fromEntries(rings.map((r) => [r.member_id, r]));
check("a member sees the Glow tier of another member", byId[ids.glow]?.ring_tier === "glow");
check("a member sees the Elite tier of another member", byId[ids.elite]?.ring_tier === "elite");
check("accent is returned for Elite", byId[ids.elite]?.ring_accent === "rose");
check("Glow has no accent", byId[ids.glow]?.ring_accent === null);
check("a Free member is absent, so no ring is drawn", !(ids.free in byId));
check("the result has only the three ring fields", rings.length > 0 && Object.keys(rings[0]).sort().join(",") === "member_id,ring_accent,ring_tier");

const leak = await q(`select * from public.member_rings($1::uuid[])`, [[ids.elite]]);
const text = JSON.stringify(leak);
check("no order note, payment or due date is returned", !/secret note|activated|due_by|payment/.test(text), text);

check("an empty list returns nothing", (await q(`select * from public.member_rings('{}'::uuid[])`)).length === 0);
check("a null list returns nothing", (await q(`select * from public.member_rings(null)`)).length === 0);

const tooMany = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`);
const code = await errorCode(() => q(`select * from public.member_rings($1::uuid[])`, [tooMany]));
check("more than 200 members in one call is refused", code === "22023", String(code));

await asAnon();
check("anonymous callers cannot run the function", (await errorCode(() => q(`select * from public.member_rings($1::uuid[])`, [all]))) !== null);

await asUser(ids.viewer);
const direct = await q(`select user_id from public.profile_entitlements`);
check("direct table reads stay owner-only (the viewer sees no other row)", direct.length === 0, `saw ${direct.length}`);

await db.exec(`reset role;`);
const acl = await q(`select has_function_privilege('anon','public.member_rings(uuid[])','execute') as anon, has_function_privilege('authenticated','public.member_rings(uuid[])','execute') as auth`);
check("anon has no execute right on member_rings", acl[0].anon === false);
check("authenticated has execute right on member_rings", acl[0].auth === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
