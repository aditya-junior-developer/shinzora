/* ==========================================================================
   Premium profiles (0054) — behaviour, in PGlite
   --------------------------------------------------------------------------
   Replays every migration into an in-process PostgreSQL, then checks:
     - a pending payment opens no order; a verified premium payment opens
       exactly one, due 24 hours later, and a repeat update opens no second one
     - a non-premium payment never opens a premium order
     - owners read their own order and entitlement, never anyone else's
     - the browser cannot write entitlements or orders directly
     - set_premium_accent() only works for an active Elite profile and only with
       a palette value
   Uses the same scaffold and replay path as reminders-db.test.mjs.
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
for (const file of migrationFiles()) {
  await apply(db, file);
}

const ids = {
  alice: "00000000-0000-4000-8000-0000000000a1",
  bob: "00000000-0000-4000-8000-0000000000b2"
};

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}

/* Payments are created by the gateway as 'pending'. The test inserts the same
   shape, as the postgres superuser, before exercising the transitions. */
const makePayment = async (ownerId, purpose, status = "pending") => {
  const reference = `SZ-T-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const rows = await q(
    `insert into public.payments (owner_id, reference, purpose, label, amount, currency, method, status)
     values ($1, $2, $3, $4, 9900, 'INR', 'upi', $5) returning id`,
    [ownerId, reference, purpose, purpose, status]
  );
  return rows[0].id;
};

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

/* True only when the operation fails with the expected SQLSTATE. A broken query
   (wrong column, missing table) fails with some other code and does not count. */
const refused = async (fn, code = "42501") => {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
};

console.log("order creation");
await asSystem();
const pendingPay = await makePayment(ids.alice, "premium:glow", "pending");
let orders = await q(`select count(*)::int as n from public.premium_orders where payment_id = $1`, [pendingPay]);
check("a pending premium payment opens no order", orders[0].n === 0);

await db.query(`update public.payments set status = 'awaiting_verification' where id = $1`, [pendingPay]);
orders = await q(`select count(*)::int as n from public.premium_orders where payment_id = $1`, [pendingPay]);
check("awaiting verification opens no order", orders[0].n === 0);

await db.query(
  `update public.payments set status = 'verified', verified_at = now() where id = $1`,
  [pendingPay]
);
orders = await q(
  `select tier, status, extract(epoch from (due_by - created_at))::int as window_s from public.premium_orders where payment_id = $1`,
  [pendingPay]
);
check("a verified premium:glow payment opens one order", orders.length === 1, JSON.stringify(orders));
check("the order is for glow and is activated in the same step as verification", orders[0]?.tier === "glow" && orders[0]?.status === "activated");
const glowNow = await q(`select tier, granted_order_id from public.profile_entitlements where user_id = $1`, [ids.alice]);
check("the glow profile is live as soon as the payment is verified", glowNow[0]?.tier === "glow", JSON.stringify(glowNow));
check("the order is due within 24 hours", orders[0]?.window_s === 86400, String(orders[0]?.window_s));

const notes = await q(
  `select count(*)::int as n from public.notifications where user_id = $1 and title = 'Glow profile is live'`,
  [ids.alice]
);
check("the member is told the glow profile is live", notes[0].n === 1);

await db.query(`update public.payments set note = 'touched' where id = $1`, [pendingPay]);
await db.query(`update public.payments set status = 'verified' where id = $1`, [pendingPay]);
orders = await q(`select count(*)::int as n from public.premium_orders where payment_id = $1`, [pendingPay]);
check("re-saving a verified payment does not create a second order", orders[0].n === 1);

const elitePay = await makePayment(ids.alice, "premium:elite", "pending");
await db.query(`update public.payments set status = 'verified' where id = $1`, [elitePay]);
const eliteOrders = await q(`select tier, status from public.premium_orders where payment_id = $1`, [elitePay]);
check("a second premium purchase opens its own order", eliteOrders[0]?.tier === "elite");
const eliteNow = await q(`select tier from public.profile_entitlements where user_id = $1`, [ids.alice]);
check("the elite purchase upgrades the live profile at once", eliteNow[0]?.tier === "elite");

/* A lower tier bought later never replaces a higher one. */
const lowerPay = await makePayment(ids.alice, "premium:glow", "pending");
await db.query(`update public.payments set status = 'verified' where id = $1`, [lowerPay]);
const lowerOrder = await q(`select status from public.premium_orders where payment_id = $1`, [lowerPay]);
const kept = await q(`select tier from public.profile_entitlements where user_id = $1`, [ids.alice]);
check("a glow purchase is recorded as activated", lowerOrder[0]?.status === "activated", JSON.stringify(lowerOrder));
check("a glow purchase never downgrades an elite profile", kept[0]?.tier === "elite", JSON.stringify(kept));
const keptNote = await q(
  `select count(*)::int as n from public.notifications where user_id = $1 and title = 'Premium payment confirmed'`,
  [ids.alice]
);
check("the member is told the lower purchase is confirmed", keptNote[0].n === 1);

const realtime = await q(
  `select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'profile_entitlements'`
);
check("entitlement changes are published for live dashboards", realtime[0].n === 1);

const subPay = await makePayment(ids.bob, "subscription:pro", "pending");
await db.query(`update public.payments set status = 'verified' where id = $1`, [subPay]);
const subOrders = await q(`select count(*)::int as n from public.premium_orders where payment_id = $1`, [subPay]);
check("a non-premium verified payment opens no premium order", subOrders[0].n === 0);

const badPay = await makePayment(ids.bob, "premium:platinum", "pending");
await db.query(`update public.payments set status = 'verified' where id = $1`, [badPay]);
const badOrders = await q(`select count(*)::int as n from public.premium_orders where payment_id = $1`, [badPay]);
check("an unknown premium tier opens no order", badOrders[0].n === 0);

console.log("entitlements and access");
/* The elite entitlement was granted by the verification itself (0060); it is
   not inserted by hand here. */
const grantedBy = await q(
  `select granted_order_id = (select id from public.premium_orders where payment_id = $1) as same
     from public.profile_entitlements where user_id = $2`,
  [elitePay, ids.alice]
);
check("the live entitlement points at the order that was verified", grantedBy[0]?.same === true);

await asUser(ids.alice);
const own = await q(`select tier from public.profile_entitlements where user_id = $1`, [ids.alice]);
check("an owner reads their own entitlement", own[0]?.tier === "elite");

const aliceOrders = await q(`select count(*)::int as n from public.premium_orders where owner_id = $1`, [ids.alice]);
check("an owner reads their own orders", aliceOrders[0].n >= 2);

const bobEntitlement = await q(`select count(*)::int as n from public.profile_entitlements where user_id = $1`, [ids.bob]);
check("an owner cannot read someone else's entitlement", bobEntitlement[0].n === 0);

const bobOrders = await q(`select count(*)::int as n from public.premium_orders where owner_id = $1`, [ids.bob]);
check("an owner cannot read someone else's orders", bobOrders[0].n === 0);

check(
  "an owner cannot grant themselves a tier",
  await refused(() =>
    db.query(`insert into public.profile_entitlements (user_id, tier) values ($1, 'elite')`, [ids.bob])
  )
);
check(
  "an owner cannot change their own tier",
  await refused(() => db.query(`update public.profile_entitlements set tier = 'elite' where user_id = $1`, [ids.bob]))
);
check(
  "an owner cannot open an order directly",
  await refused(() =>
    db.query(
      `insert into public.premium_orders (owner_id, payment_id, tier, due_by) values ($1, $2, 'elite', now())`,
      [ids.bob, subPay]
    )
  )
);
check(
  "an owner cannot mark their own order activated",
  await refused(() => db.query(`update public.premium_orders set status = 'activated' where owner_id = $1`, [ids.alice]))
);

console.log("accent colour");
await asUser(ids.alice);
await db.query(`select public.set_premium_accent('rose')`);
const accent = await q(`select accent from public.profile_entitlements where user_id = $1`, [ids.alice]);
check("an Elite member can pick a palette accent", accent[0]?.accent === "rose");

check(
  "an accent outside the palette is refused",
  await refused(() => db.query(`select public.set_premium_accent('neon-pink')`), "22023")
);

await db.query(`select public.set_premium_accent(null)`);
const cleared = await q(`select accent from public.profile_entitlements where user_id = $1`, [ids.alice]);
check("clearing the accent is allowed", cleared[0]?.accent === null);

await asUser(ids.bob);
check(
  "a member with no entitlement cannot set an accent",
  await refused(() => db.query(`select public.set_premium_accent('teal')`))
);

await asSystem();
await db.query(
  `insert into public.profile_entitlements (user_id, tier) values ($1, 'glow')`,
  [ids.bob]
);
await asUser(ids.bob);
check(
  "a Glow member cannot set an accent (Elite only)",
  await refused(() => db.query(`select public.set_premium_accent('teal')`))
);

await asSystem();
check("the owner of a verified order is the payment owner", (await q(
  `select count(*)::int as n from public.premium_orders o join public.payments p on p.id = o.payment_id where o.owner_id <> p.owner_id`
))[0].n === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
