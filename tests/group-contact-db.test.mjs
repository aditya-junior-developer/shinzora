/* ==========================================================================
   Group contact number (0063) — behaviour in PGlite
   --------------------------------------------------------------------------
     - the owner sets a number; spaces and dashes are removed before storing
     - a number with letters, or too short or too long, is refused
     - members read the number; a stranger cannot
     - a plain member cannot change it; the owner can clear it
     - a direct table update changes nothing (no write policy, 0037)
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
  carol: "00000000-0000-4000-8000-0000000000c3"
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}

await db.exec(`
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on public.community_groups to authenticated;
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
const asSystem = async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub','',false);
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

console.log("group contact number");
await asUser(ids.alice);
await db.query(`select public.group_create($1, $2, $3::uuid[])`, ["Design", null, [ids.bob]]);
const groupId = (await q(`select id from public.community_groups where name = 'Design'`))[0].id;

const saved = await q(`select public.group_set_contact($1, $2) as r`, [groupId, "+91 98765-43210"]);
check("the owner sets a number; spaces and dashes are removed", saved[0].r.contactPhone === "+919876543210", JSON.stringify(saved[0].r));
check("the stored value is digits with an optional +", (await q(`select contact_phone from public.community_groups where id=$1`, [groupId]))[0].contact_phone === "+919876543210");

check("a number with letters is refused", (await errorCode(() => db.query(`select public.group_set_contact($1,$2)`, [groupId, "call me"]))) === "22023");
check("a number that is too short is refused", (await errorCode(() => db.query(`select public.group_set_contact($1,$2)`, [groupId, "12345"]))) === "22023");
check("a number that is too long is refused", (await errorCode(() => db.query(`select public.group_set_contact($1,$2)`, [groupId, "1234567890123456"]))) === "22023");

await asUser(ids.bob);
const bobReads = await q(`select public.group_contact($1) as n`, [groupId]);
check("a member reads the number", bobReads[0].n === "+919876543210");
check("a plain member cannot set it", (await errorCode(() => db.query(`select public.group_set_contact($1,$2)`, [groupId, "9876543210"]))) === "42501");

await asUser(ids.carol);
check("someone outside the group cannot read the number", (await errorCode(() => db.query(`select public.group_contact($1)`, [groupId]))) === "42501");

await asUser(ids.alice);
check("a direct table update changes nothing", (await db.query(`update public.community_groups set contact_phone = '5550000000' where id = $1`, [groupId])).affectedRows === 0
  || (await q(`select contact_phone from public.community_groups where id=$1`, [groupId]))[0].contact_phone === "+919876543210");
check("the number is unchanged after that attempt", (await q(`select contact_phone from public.community_groups where id=$1`, [groupId]))[0].contact_phone === "+919876543210");

const cleared = await q(`select public.group_set_contact($1, $2) as r`, [groupId, "   "]);
check("the owner can clear the number", cleared[0].r.contactPhone === null);

await asSystem();
await db.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
