/* ==========================================================================
   Profile rings (0069) — behaviour in PGlite
   --------------------------------------------------------------------------
     - the eight designs are readable; nobody can change them
     - a ring is applied only when its payment is verified, never before
     - each verified ring payment replaces the member's design
     - a pending or cancelled ring payment changes nothing
     - a member can read only their own choice and order; nobody can write them
     - member_rings() returns the design and name of the members asked for, and
       refuses more than 200 members
     - the ring ledger is for administrators only
     - the tier rings and ring settings from 0066 and 0068 are gone
   The ₹10 price is checked in tests/profile-rings-config.test.mjs, because it
   lives in the Edge Function.
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
  alice: "00000000-0000-4000-8000-0000000000a1",
  bob: "00000000-0000-4000-8000-0000000000b2",
  admin: "00000000-0000-4000-8000-0000000000c3"
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`update public.profiles set full_name = $2 where id = $1`, [uid, name]);
}
await db.query(`insert into public.admin_users (user_id, email, role) values ($1, 'admin@test.local', 'admin')`, [ids.admin]);

await db.exec(`
  grant usage on schema public to authenticated, anon;
  grant select on public.payments to authenticated;
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
const asSystem = async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claims','{"role":"service_role"}',false);
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

/* What the Edge Function writes when a member orders a ring. */
let seq = 0;
async function order(ownerId, ringId, status = "pending") {
  seq += 1;
  await asSystem();
  const { rows: [pay] } = await db.query(
    `insert into public.payments (owner_id, purpose, label, amount, status)
     values ($1, $2, 'Profile ring', 1000, 'pending') returning id`,
    [ownerId, `ring_apply:${ringId}`]
  );
  await db.query(
    `insert into public.ring_orders (payment_id, owner_id, ring_id, amount_paise) values ($1, $2, $3, 1000)`,
    [pay.id, ownerId, ringId]
  );
  if (status !== "pending") {
    await db.query(`update public.payments set status = $2 where id = $1`, [pay.id, status]);
  }
  return pay.id;
}
const setStatus = async (paymentId, status) => {
  await asSystem();
  await db.query(`update public.payments set status = $2 where id = $1`, [paymentId, status]);
};
const choiceOf = async (userId) => q(`select ring_id, payment_id from public.profile_ring_choices where user_id = $1`, [userId]);

console.log("designs");
await asAnon();
const designs = await q(`select id, name from public.ring_designs order by sort_order`);
check("the eight designs are readable", designs.length === 8, `got ${designs.length}`);
check("the designs are the ones the picker shows", designs.map((d) => d.id).join(",") === "kuromi-neon,starlight-vine,sakura,thorn-rose,gothic-skull,tiger-gold,diamond-wings,pink-gold");
check("anonymous visitors cannot change a design", (await errorCode(() => q(`update public.ring_designs set name = 'x'`))) === "42501");

console.log("applying a ring");
await asUser(ids.alice);
const payOne = await order(ids.alice, "sakura");
let choice = await choiceOf(ids.alice);
check("a pending ring order applies nothing", choice.length === 0);
await asUser(ids.bob);
check("other members see no ring for a pending order", (await q(`select * from public.member_rings($1::uuid[])`, [[ids.alice]])).length === 0);

await setStatus(payOne, "awaiting_verification");
choice = await choiceOf(ids.alice);
check("sent for verification applies nothing yet", choice.length === 0);

await setStatus(payOne, "verified");
choice = await choiceOf(ids.alice);
check("a verified payment applies the design", choice.length === 1 && choice[0].ring_id === "sakura", JSON.stringify(choice));
check("the choice records the payment", choice[0]?.payment_id === payOne);

await asUser(ids.bob);
const seen = await q(`select member_id, ring_id, ring_name from public.member_rings($1::uuid[])`, [[ids.alice]]);
check("another member sees the design and its name", seen.length === 1 && seen[0].ring_id === "sakura" && seen[0].ring_name === "Sakura", JSON.stringify(seen));
check("member_rings returns no payment or order detail", Object.keys(seen[0] || {}).sort().join(",") === "member_id,ring_id,ring_name");

console.log("each application replaces the last");
await asUser(ids.alice);
const payTwo = await order(ids.alice, "thorn-rose");
await setStatus(payTwo, "verified");
choice = await choiceOf(ids.alice);
check("a second verified order replaces the design", choice.length === 1 && choice[0].ring_id === "thorn-rose", JSON.stringify(choice));

const payThree = await order(ids.alice, "gothic-skull");
await setStatus(payThree, "cancelled");
choice = await choiceOf(ids.alice);
check("a cancelled order changes nothing", choice[0]?.ring_id === "thorn-rose");

console.log("bob, who has no tier of any kind");
await asUser(ids.bob);
const payBob = await order(ids.bob, "tiger-gold");
await setStatus(payBob, "verified");
choice = await choiceOf(ids.bob);
check("any signed-in member can apply a ring, with no tier", choice[0]?.ring_id === "tiger-gold");

console.log("access");
await asUser(ids.bob);
check("a member reads only their own choice", (await q(`select user_id from public.profile_ring_choices`)).every((r) => r.user_id === ids.bob));
check("a member reads only their own ring orders", (await q(`select owner_id from public.ring_orders`)).every((r) => r.owner_id === ids.bob));
check("a member cannot write their own choice", (await errorCode(() => q(`update public.profile_ring_choices set ring_id = 'sakura'`))) === "42501");
check("a member cannot insert a choice", (await errorCode(() => q(`insert into public.profile_ring_choices (user_id, ring_id) values ($1, 'sakura')`, [ids.bob]))) === "42501");
check("a member cannot write an order", (await errorCode(() => q(`insert into public.ring_orders (payment_id, owner_id, ring_id, amount_paise) values (gen_random_uuid(), $1, 'sakura', 1000)`, [ids.bob]))) === "42501");

await asSystem();
check("an order must cost exactly ₹10", (await errorCode(() => q(`insert into public.ring_orders (payment_id, owner_id, ring_id, amount_paise) values ($1, $2, 'sakura', 500)`, [payBob, ids.bob]))) === "23514");

await asAnon();
check("anonymous visitors get no rings", (await errorCode(() => q(`select * from public.member_rings($1::uuid[])`, [[ids.alice]]))) === "42501");
check("anonymous visitors cannot read choices", (await errorCode(() => q(`select * from public.profile_ring_choices`))) === "42501");

await asUser(ids.bob);
check("an empty list returns nothing", (await q(`select * from public.member_rings($1::uuid[])`, [[]])).length === 0);
check("a null list returns nothing", (await q(`select * from public.member_rings(null)`)).length === 0);
const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
check("more than 200 members are refused", (await errorCode(() => q(`select * from public.member_rings($1::uuid[])`, [many]))) === "22023");

console.log("admin ledger");
await asUser(ids.alice);
check("a member cannot read the ring ledger", (await errorCode(() => q(`select * from public.admin_ring_ledger(10)`))) === "42501");
await asUser(ids.admin);
const ledger = await q(`select order_id, ring_id, ring_name, payment_amount, payment_status, applied from public.admin_ring_ledger(50)`);
check("an administrator reads every ring order", ledger.length === 4, `rows=${ledger.length}`);
check("the ledger shows the ₹10 amount", ledger.every((r) => Number(r.payment_amount) === 1000));
check("exactly one of alice's orders is the applied one", ledger.filter((r) => r.applied && r.ring_id === "thorn-rose").length === 1);
check("the cancelled order is shown as not applied", ledger.some((r) => r.ring_id === "gothic-skull" && r.payment_status === "cancelled" && r.applied === false));
await asAnon();
check("anonymous visitors cannot read the ledger", (await errorCode(() => q(`select * from public.admin_ring_ledger(10)`))) === "42501");

console.log("removed");
await asSystem();
check("the ring settings table from 0068 is gone", (await q(`select to_regclass('public.profile_ring_prefs') as t`))[0].t === null);
check("the ring settings functions from 0068 are gone", (await q(`select to_regprocedure('public.ring_prefs_get()') as p`))[0].p === null);
check("the ring settings save function from 0068 is gone", (await q(`select to_regprocedure('public.ring_prefs_set(boolean,boolean)') as p`))[0].p === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
