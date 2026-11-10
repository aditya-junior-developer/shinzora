/* ==========================================================================
   Profile writes — the restrictive policies, against a real PostgreSQL
   --------------------------------------------------------------------------
   The reported failure was the last onboarding step:

     "You do not have access to this resource.
      Row Level Security blocked the request."

   Cause: profiles_customer_update_only was RESTRICTIVE and hard-coded
   `role = 'customer'`. A restrictive policy is ANDed with every permissive
   one, so the owner's own account (role 'admin') could not save its profile —
   the onboarding upsert died on its DO UPDATE half with

     42501 new row violates row-level security policy "profiles_customer_update_only"

   These assertions pin both halves of the fix: every role can edit its own
   row, and nobody can promote themselves while doing it.
   ========================================================================== */

import path from "node:path";
import { fileURLToPath } from "node:url";

let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("  ! SKIPPED — @electric-sql/pglite is not installed, so this SQL suite did not run.");
  process.exit(0);
}

const { SCAFFOLD, migrationFiles, apply } = await import("../scripts/staging-db.mjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

const CUSTOMER = "a1111111-1111-4111-8111-111111111111";
const OWNER = "b2222222-2222-4222-8222-222222222222";
const ADMIN = "c3333333-3333-4333-8333-333333333333";
const STRANGER = "d4444444-4444-4444-8444-444444444444";

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) await apply(db, file);

/* Supabase grants its API roles table privileges; bare Postgres does not. */
await db.exec(`
  grant usage on schema public to authenticated, anon;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant select on all tables in schema public to anon;
`);

/* The scaffold's auth.uid() reads request.jwt.claim.sub, so that is what the
   session has to set — setting a jsonb blob there would leave auth.uid() null
   and every policy would simply filter the statement down to zero rows. */
const as = async (id, sql) => {
  await db.exec(`reset role`);
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id]);
  try {
    return await db.exec(sql);
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
};

const rejects = async (id, sql) => {
  try {
    await as(id, sql);
    return null;
  } catch (error) {
    return error.message;
  }
};

/* ---------------------------------------------------------------- fixtures */
await db.exec(`
  insert into auth.users (id, email) values
    ('${CUSTOMER}', 'customer@example.com'),
    ('${OWNER}',    'owner@example.com'),
    ('${ADMIN}',    'admin@example.com'),
    ('${STRANGER}', 'stranger@example.com');

  /* handle_new_user() has already created a row for each user, with the
     default role. Give them the roles this test is about. */
  update public.profiles set full_name = 'Customer', role = 'customer' where id = '${CUSTOMER}';
  update public.profiles set full_name = 'Owner',    role = 'owner'    where id = '${OWNER}';
  update public.profiles set full_name = 'Admin',    role = 'admin'    where id = '${ADMIN}';
  update public.profiles set full_name = 'Stranger', role = 'customer' where id = '${STRANGER}';
`);

/* ------------------------------------------------------------- the failure */
for (const [label, id] of [["customer", CUSTOMER], ["owner", OWNER], ["admin", ADMIN]]) {
  const error = await rejects(
    id,
    `update public.profiles set full_name = 'Renamed ${label}', updated_at = now() where id = '${id}';`
  );
  const row = await db.query(`select full_name from public.profiles where id = '${id}'`);
  check(
    `${label} can update its own profile`,
    error === null && row.rows[0]?.full_name === `Renamed ${label}`,
    error || `name is ${JSON.stringify(row.rows[0]?.full_name)}`
  );
}

/* The exact statement the onboarding screen issues, for the admin account. */
const upsertError = await rejects(
  ADMIN,
  `insert into public.profiles (id, full_name, email, updated_at)
   values ('${ADMIN}', 'Aditya Sharma', 'admin@example.com', now())
   on conflict (id) do update set full_name = excluded.full_name, updated_at = excluded.updated_at;`
);
check("onboarding's profile upsert succeeds for an admin", upsertError === null, upsertError || "");

const adminName = await db.query(`select full_name from public.profiles where id = '${ADMIN}'`);
check(
  "the admin's name actually changed",
  adminName.rows[0]?.full_name === "Aditya Sharma",
  JSON.stringify(adminName.rows[0])
);

/* ------------------------------------------------------------- escalation */
const promoteSelf = await rejects(
  CUSTOMER,
  `update public.profiles set role = 'admin' where id = '${CUSTOMER}';`
);
check("a customer cannot make itself an admin", promoteSelf !== null, "the update was allowed");
check(
  "the escalation attempt is reported as a policy violation",
  /row-level security|policy/i.test(promoteSelf || ""),
  promoteSelf || ""
);

const stillCustomer = await db.query(`select role from public.profiles where id = '${CUSTOMER}'`);
check("the customer's role is unchanged", stillCustomer.rows[0]?.role === "customer");

/* Another account's row is not visible to the update at all, so RLS filters the
   statement to zero rows rather than raising. The proof is the stored value. */
await as(CUSTOMER, `update public.profiles set role = 'admin' where id = '${STRANGER}';`);
const strangerRole = await db.query(`select role from public.profiles where id = '${STRANGER}'`);
check("a customer cannot promote somebody else", strangerRole.rows[0]?.role === "customer");

await as(CUSTOMER, `update public.profiles set full_name = 'Hijacked' where id = '${STRANGER}';`);
const strangerName = await db.query(`select full_name from public.profiles where id = '${STRANGER}'`);
check(
  "a customer cannot edit another account's profile",
  strangerName.rows[0]?.full_name === "Stranger",
  JSON.stringify(strangerName.rows[0]?.full_name)
);

/* A customer may still rename themselves in the same statement shape the app
   uses — the fix must not have locked ordinary users out. */
const selfRename = await rejects(
  CUSTOMER,
  `update public.profiles set full_name = 'Customer Renamed', phone = '+910000000000' where id = '${CUSTOMER}';`
);
check("a customer keeps ordinary self-service edits", selfRename === null, selfRename || "");

/* --------------------------------------------------------------- insert path */
const selfInsert = await rejects(
  STRANGER,
  `insert into public.profiles (id, email, full_name)
   values ('${STRANGER}', 'stranger@example.com', 'Stranger')
   on conflict (id) do update set full_name = excluded.full_name;`
);
check("a self-insert with the default role is allowed", selfInsert === null, selfInsert || "");

const insertAsAdmin = await rejects(
  STRANGER,
  `insert into public.profiles (id, email, role) values ('${STRANGER}', 'stranger@example.com', 'admin');`
);
check("a self-insert cannot create an admin row", insertAsAdmin !== null);

/* A real new account: the auth row exists, the profile row does not. */
await db.query(`insert into auth.users (id, email) values ('e5555555-5555-4555-8555-555555555555', 'new@example.com')`);
await db.query(`delete from public.profiles where id = 'e5555555-5555-4555-8555-555555555555'`);
const okInsert = await rejects(
  "e5555555-5555-4555-8555-555555555555",
  `insert into public.profiles (id, email, full_name) values ('e5555555-5555-4555-8555-555555555555', 'new@example.com', 'Newcomer');`
);
check("a brand-new user can create its own row", okInsert === null, okInsert || "");

/* ------------------------------------------------------------------ helper */
const helper = await db.query(
  `select public.profile_role_of('${ADMIN}') as role, has_function_privilege('anon', 'public.profile_role_of(uuid)', 'execute') as anon_can`
);
check("the role helper answers for a known user", helper.rows[0]?.role === "admin");
check("anon cannot call the role helper", helper.rows[0]?.anon_can === false);

console.log(`\n  ${pass} profile-policy assertions passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exitCode = 1;
