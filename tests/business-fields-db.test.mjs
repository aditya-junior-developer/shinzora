/* ==========================================================================
   Business profile fields for the AI (0065) — behaviour in PGlite
   --------------------------------------------------------------------------
     - a pending payment grants nothing; a verified one grants the ticked fields
     - the grant is added to fields already held, with no duplicates
     - a field outside the catalogue is refused
     - an owner cannot set ai_fields directly, even on their own business
     - a re-verification of the same payment does not grant twice
     - an owner reads their own purchases; a stranger reads none
     - the catalogue is readable; nobody can write it
   The price (₹10 per field, recomputed on the server) is checked in
   tests/business-fields-config.test.mjs, because it lives in the Edge Function.
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
  bob: "00000000-0000-4000-8000-0000000000b2"
};
const biz = "00000000-0000-4000-8000-00000000b1b1";
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}
await db.query(
  `insert into public.businesses (id, owner_id, name) values ($1, $2, 'Alice Studio')`,
  [biz, ids.alice]
);

await db.exec(`
  grant usage on schema public to authenticated, anon;
  grant select, update on public.businesses to authenticated;
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

/* The Edge Function's steps, as the service role: a payment row, then the order. */
async function createOrder(fields) {
  await asSystem();
  const payment = await q(
    `insert into public.payments (owner_id, purpose, label, amount, status)
     values ($1, 'business_fields', 'Business fields', $2, 'pending') returning id`,
    [ids.alice, fields.length * 10]
  );
  const paymentId = payment[0].id;
  await db.query(
    `insert into public.business_field_orders (payment_id, owner_id, business_id, fields, amount_paise)
     values ($1, $2, $3, $4, $5)`,
    [paymentId, ids.alice, biz, fields, fields.length * 1000]
  );
  return paymentId;
}
const verify = async (paymentId) => {
  await asSystem();
  await db.query(`update public.payments set status = 'verified', verified_at = now() where id = $1`, [paymentId]);
};
const aiFields = async () => (await q(`select ai_fields from public.businesses where id = $1`, [biz]))[0].ai_fields;

console.log("business fields for the AI");

const first = await createOrder(["name", "email"]);
check("a pending payment grants nothing", (await aiFields()).length === 0, JSON.stringify(await aiFields()));

await verify(first);
const granted = await aiFields();
check("a verified payment grants the ticked fields", granted.includes("name") && granted.includes("email") && granted.length === 2, JSON.stringify(granted));

const second = await createOrder(["email", "phone"]);
await verify(second);
const merged = await aiFields();
check("a later purchase adds to the fields already held, without duplicates", merged.length === 3 && merged.filter((k) => k === "email").length === 1, JSON.stringify(merged));

await db.query(`update public.payments set status = 'verified' where id = $1`, [first]);
check("re-verifying the same payment does not change the grant", JSON.stringify(await aiFields()) === JSON.stringify(merged));

const unknown = await errorCode(async () => {
  await asSystem();
  await db.query(
    `insert into public.business_field_orders (payment_id, owner_id, business_id, fields, amount_paise)
     values (gen_random_uuid(), $1, $2, $3, 1000)`,
    [ids.alice, biz, ["favourite_colour"]]
  );
});
check("a field outside the catalogue is refused", unknown !== null, String(unknown));

await asUser(ids.alice);
const selfGrant = await errorCode(async () => {
  await db.query(`update public.businesses set ai_fields = array['name','category','location','description','target_audience','website_url','phone','email'] where id = $1`, [biz]);
});
check("an owner cannot grant themselves AI fields directly", selfGrant !== null, String(selfGrant));
await asSystem();
check("the refused update changed nothing", JSON.stringify(await aiFields()) === JSON.stringify(merged));

await asUser(ids.alice);
const own = await q(`select payment_id, fields from public.business_field_orders`);
check("an owner reads their own purchases", own.length === 2, `rows ${own.length}`);

await asUser(ids.bob);
const stranger = await q(`select payment_id from public.business_field_orders`);
check("a stranger reads none of them", stranger.length === 0, `rows ${stranger.length}`);

const catalogue = await q(`select key from public.business_field_catalog order by sort_order`);
check("the catalogue has the eight business-profile fields", catalogue.length === 8, `rows ${catalogue.length}`);
await asUser(ids.alice);
const catalogueWrite = await errorCode(async () => {
  await db.query(`insert into public.business_field_catalog (key, label, sort_order) values ('x','x',99)`);
});
check("nobody can add to the catalogue from the client", catalogueWrite !== null, String(catalogueWrite));

await asSystem();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
