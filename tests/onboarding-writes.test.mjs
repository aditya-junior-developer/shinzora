/* ==========================================================================
   Finish Setup — the writes, against a real PostgreSQL with real RLS
   --------------------------------------------------------------------------
   The reported failure was:

     "You do not have access to this resource. Row Level Security blocked the
      request. Sign in with an account that owns this data."

   Two causes were found by reading the shipped SQL, and both are reproduced
   here as failing behaviour first, then verified as fixed:

     1. public.subscriptions has a SELECT policy only (plan changes must go
        through payments), but onboarding upserted into it. The signup trigger
        has already created the row, so the upsert was an UPDATE — denied.
     2. the paid-plan service request was inserted with status 'pending', which
        neither the CHECK constraint nor the insert policy allows.

   The fix adds one narrowly scoped function (migration 0010) instead of
   loosening a policy. These tests prove the function cannot be used to touch
   another customer's data, and that RLS is still doing its job afterwards.
   ========================================================================== */

import path from "node:path";
import { fileURLToPath } from "node:url";

let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("  ! SKIPPED — @electric-sql/pglite is not installed, so this SQL suite did not run.");
  console.log("  ! Install it with: npm install --save-dev @electric-sql/pglite");
  process.exit(0);
}

const { SCAFFOLD, migrationFiles, apply } = await import("../scripts/staging-db.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const db = new PGlite();
await db.exec(SCAFFOLD);

for (const file of migrationFiles()) {
  try {
    await apply(db, file);
  } catch (error) {
    check(`${file} applies`, false, error.message.split("\n")[0]);
  }
}

/* Supabase grants its API roles table privileges by default; a bare Postgres
   does not. This has to run AFTER the migrations, because it applies to the
   tables they create — otherwise the roles fail on privileges and the policies
   (the thing under test) are never exercised at all. */
await db.exec(`
  grant usage on schema public to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
`);

/* Migration 0010 is what this suite is about; if it silently did not land, say so
   rather than reporting a hollow pass. */
const { rows: fn } = await db.query(
  `select p.prosecdef as definer
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'attach_business_to_subscription'`
);
check("migration 0010 is present", fn.length === 1);
check("the linking function is SECURITY DEFINER", fn[0]?.definer === true);

/* --- fixtures: two customers, one business each --------------------------- */
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');
  insert into public.businesses (owner_id, name, category) values
    ('${A}', 'Aster Studio', 'photography'),
    ('${B}', 'Blue Bakery', 'food');
`);

const businessOf = async (owner) => {
  const { rows } = await db.query(`select id from public.businesses where owner_id = '${owner}' limit 1`);
  return rows[0].id;
};
const businessA = await businessOf(A);
const businessB = await businessOf(B);

/* The signup trigger is what creates the subscription — this is the row the old
   client code then tried to upsert. */
const { rows: seeded } = await db.query(
  `select user_id, count(*)::int as n from public.subscriptions where user_id in ('${A}','${B}') group by user_id`
);
check(
  "the signup trigger created exactly one subscription per account",
  seeded.length === 2 && seeded.every((row) => Number(row.n) === 1),
  JSON.stringify(seeded)
);

/* ---------------------------------------------------------------- as user A */
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${A}', false);`);

console.log("\nthe reported failure, reproduced");

/* The client used an upsert, and an upsert starts with an INSERT — that is the
   statement RLS actually refuses. A bare UPDATE is worse than an error: it
   silently matches no rows, so the "saved" business id would never appear and
   nothing would say why. Both are reproduced so the difference is recorded. */
let directWrite = null;
try {
  await db.exec(`
    insert into public.subscriptions (user_id, plan, status, business_id)
    values ('${A}', 'free', 'active', '${businessA}')
    on conflict (user_id) do update set business_id = excluded.business_id`);
} catch (error) {
  directWrite = error.message;
}
check(
  "the old upsert is still refused by RLS",
  /row-level security|permission denied/i.test(String(directWrite)),
  String(directWrite || "the write succeeded — RLS has been loosened")
);

const { rows: silent } = await db.query(
  `update public.subscriptions set business_id = '${businessA}' where user_id = '${A}' returning business_id`
);
check("a bare UPDATE quietly affects nothing (why the bug was invisible)", silent.length === 0, String(silent.length));

let pendingStatus = null;
try {
  await db.exec(`
    insert into public.service_requests (owner_id, service_type, title, status)
    values ('${A}', 'plan_upgrade', 'Upgrade to Pro', 'pending')`);
} catch (error) {
  pendingStatus = error.message;
}
check(
  "status 'pending' is rejected — the old paid-plan insert could never work",
  /check constraint|violates/i.test(String(pendingStatus)),
  String(pendingStatus || "the insert succeeded")
);

console.log("\nthe fix");

const { rows: linked } = await db.query(`select public.attach_business_to_subscription('${businessA}') as r`);
check("linking a business succeeds", linked[0].r?.ok === true, JSON.stringify(linked[0].r));

const { rows: afterLink } = await db.query(
  `select business_id, plan, status, ai_credits_used, ai_credits_limit
     from public.subscriptions where user_id = '${A}'`
);
check("the subscription now points at the customer's business", afterLink[0].business_id === businessA);
check("the plan was not changed", afterLink[0].plan === "free");
check("the status was not changed", afterLink[0].status === "active");
check("AI credits were not touched", Number(afterLink[0].ai_credits_limit) === 30 && Number(afterLink[0].ai_credits_used) === 0);

let foreign = null;
try {
  await db.exec(`select public.attach_business_to_subscription('${businessB}')`);
} catch (error) {
  foreign = error.message;
}
check("another customer's business cannot be linked", /does not belong/i.test(String(foreign)), String(foreign || "it succeeded"));

const { rows: stillA } = await db.query(`select business_id from public.subscriptions where user_id = '${A}'`);
check("the refused call left the row untouched", stillA[0].business_id === businessA);

await db.exec(`reset role;`);
const { rows: untouchedB } = await db.query(
  `select business_id from public.subscriptions where user_id = '${B}'`
);
check("the other customer's subscription was never touched", untouchedB[0]?.business_id === null);
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${A}', false);`);

/* The correct status now works for the paid-plan branch. */
await db.exec(`
  insert into public.service_requests (owner_id, service_type, title, status)
  values ('${A}', 'plan_upgrade', 'Upgrade to Pro', 'requested')`);
const { rows: sr } = await db.query(`select status, owner_id from public.service_requests`);
check("a paid-plan request is accepted at 'requested'", sr.length === 1 && sr[0].status === "requested");

let foreignInsert = null;
try {
  await db.exec(`
    insert into public.service_requests (owner_id, service_type, title, status)
    values ('${B}', 'plan_upgrade', 'Not mine', 'requested')`);
} catch (error) {
  foreignInsert = error.message;
}
check("a request cannot be filed on behalf of somebody else", /row-level security|violates/i.test(String(foreignInsert)), String(foreignInsert || "it succeeded"));

/* ------------------------------------------------------------- as nobody */
await db.exec(`reset role;`);
await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
await db.exec(`set role anon;`);
let anonymous = null;
try {
  await db.exec(`select public.attach_business_to_subscription('${businessA}')`);
} catch (error) {
  anonymous = error.message;
}
check(
  "the function refuses an anonymous caller",
  /signed-in|permission denied/i.test(String(anonymous)),
  String(anonymous || "it ran")
);
await db.exec(`reset role;`);

/* The subscriptions table must still have no browser write policy: if a future
   change adds one, this fails loudly instead of quietly widening authority. */
const { rows: policies } = await db.query(
  `select cmd from pg_policies where schemaname = 'public' and tablename = 'subscriptions'`
);
const cmds = policies.map((row) => row.cmd).sort().join(",");
check("subscriptions still has no INSERT/UPDATE policy for the browser", cmds === "SELECT", cmds);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
