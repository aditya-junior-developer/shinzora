/* ==========================================================================
   Investor role and investor decks (P9, 0058) — behaviour in PGlite
   Replays every migration, then checks what the four login roles may do:
     - an investor is a fourth account type, entered only through investor_join
     - an investor reads only decks a founder shared, and only ready ones
     - an investor cannot build, share, or change account type
     - an owner builds decks; an agent cannot
     - a deck's data is read only for the sections the owner ticked, from
       the owner's own business
     - a verified Rs 20 payment becomes one export, used once
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
  owner: "00000000-0000-4000-8000-0000000009a1",
  otherOwner: "00000000-0000-4000-8000-0000000009a2",
  agent: "00000000-0000-4000-8000-0000000009a3",
  investor: "00000000-0000-4000-8000-0000000009a4",
  newcomer: "00000000-0000-4000-8000-0000000009a5",
  busy: "00000000-0000-4000-8000-0000000009a6"
};

const seed = [
  ["owner", "owner", "olive.founder"],
  ["otherOwner", "owner", "rival.co"],
  ["agent", "agent", "ari.agent"],
  ["investor", "investor", "ivy.investor"],
  ["newcomer", "owner", "nina.new"],
  ["busy", "owner", "bo.busy"]
];
for (const [key, type, username] of seed) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [ids[key], `${key}@test.local`]);
  /* The signup trigger has already made each profile an owner, so an investor
     seed is a switch. Real investors get there through investor_join(); the
     seed sets the same transaction flag that function sets, and only here. */
  await db.query(`select set_config('shinzora.investor_join', $1, false)`, [type === "investor" ? "on" : "off"]);
  await db.query(
    `insert into public.profiles (id, full_name, username, account_type) values ($1, $2, $3, $4)
     on conflict (id) do update set username = excluded.username, account_type = excluded.account_type`,
    [ids[key], key, username, type]
  );
  await db.query(`select set_config('shinzora.investor_join', 'off', false)`);
}

// Businesses: the owner has one, the busy owner has one (so investor_join must refuse them).
await db.query(
  `insert into public.businesses (id, owner_id, name, category, location, stage, description, target_audience, goals)
   values ('00000000-0000-4000-8000-0000000009b1', $1, 'Olive Roasters', 'Food', 'Faridabad', 'established', 'Small batch coffee', 'Office workers', '["growth"]'::jsonb)`,
  [ids.owner]
);
await db.query(
  `insert into public.businesses (id, owner_id, name) values ('00000000-0000-4000-8000-0000000009b2', $1, 'Rival Beans')`,
  [ids.otherOwner]
);
await db.query(
  `insert into public.businesses (id, owner_id, name) values ('00000000-0000-4000-8000-0000000009b3', $1, 'Busy Bakery')`,
  [ids.busy]
);

/* Supabase grants table privileges to `authenticated` by default, and RLS then
   decides each row. The PGlite replay does not add those defaults, so grant the
   tables this suite reads and writes as a signed-in user. The policies and the
   migration's own grants are what is being checked. */
await db.exec(`
  grant usage on schema public to authenticated, anon;
  grant select, update on public.profiles to authenticated;
  grant select on public.businesses, public.store_products, public.store_orders, public.notifications, public.payments to authenticated;
`);
const asUser = async (uid) =>
  db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); select set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated"}',false);`);
const asAnon = async () => db.exec(`reset role; set role anon; select set_config('request.jwt.claim.sub','',false);`);
/* The system session is what a verified provider callback runs as: service_role
   in the JWT claims, so guard_payment_status accepts the confirmation. */
const asSystem = async () =>
  db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','{"role":"service_role"}',false);`);

const errorCode = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error?.code || error?.message || "unknown";
  }
};

const SLIDES = [
  { title: "Olive Roasters", bullets: ["Small batch coffee for offices"] },
  { title: "The problem", bullets: ["Office coffee is stale", "Teams pay too much for it"] },
  { title: "The ask", bullets: ["Raise to open a second roastery"] }
];

console.log("the fourth role");
await asSystem();
check(
  "profiles accept the investor account type",
  (await errorCode(() => db.query(`update public.profiles set account_type = 'investor' where id = $1`, [ids.newcomer]))) !== null,
  "the constraint should refuse a switch to investor outside investor_join"
);
await asUser(ids.investor);
check(
  "an investor cannot switch its own account type to owner",
  (await errorCode(() => db.query(`update public.profiles set account_type = 'owner' where id = $1`, [ids.investor]))) !== null
);
check(
  "an investor cannot use set_account_type either",
  (await errorCode(() => db.query(`select public.set_account_type('owner')`))) !== null
);
await asUser(ids.owner);
check(
  "an owner cannot switch to investor through a plain update",
  (await errorCode(() => db.query(`update public.profiles set account_type = 'investor' where id = $1`, [ids.owner]))) !== null
);

await asUser(ids.newcomer);
check(
  "a new account with no business can join as an investor",
  (await errorCode(() => db.query(`select public.investor_join('nina.investor')`))) === null
);
const { rows: joined } = await db.query(`select account_type, username from public.profiles where id = $1`, [ids.newcomer]);
check("joining sets the account type and the handle", joined[0]?.account_type === "investor" && joined[0]?.username === "nina.investor", JSON.stringify(joined[0]));
await asUser(ids.busy);
check(
  "a business owner cannot join as an investor",
  (await errorCode(() => db.query(`select public.investor_join('busy.investor')`).then(() => null))) !== null
);
await asSystem();
const { rows: busy } = await db.query(`select account_type from public.profiles where id = $1`, [ids.busy]);
check("the refused owner is still an owner", busy[0]?.account_type === "owner");

console.log("deck building (owner only)");
await asUser(ids.owner);
const { rows: deckRows } = await db.query(
  `insert into public.investor_decks (owner_id, title, mode, slides)
   values ($1, 'Seed round', 'manual', $2::jsonb) returning id`,
  [ids.owner, JSON.stringify(SLIDES)]
);
const deckId = deckRows[0].id;
check("an owner can create a deck", Boolean(deckId));

await asUser(ids.agent);
check(
  "an agent cannot create a deck",
  (await errorCode(() =>
    db.query(`insert into public.investor_decks (owner_id, title, slides) values ($1, 'Nope', '[]'::jsonb)`, [ids.agent])
  )) !== null
);

await asUser(ids.owner);
check(
  "an owner cannot create a deck in another owner's name",
  (await errorCode(() =>
    db.query(`insert into public.investor_decks (owner_id, title, slides) values ($1, 'Forged', '[]'::jsonb)`, [ids.otherOwner])
  )) !== null
);
check(
  "a deck cannot be marked ready with fewer than three slides",
  (await errorCode(() => db.query(`update public.investor_decks set status = 'ready', slides = '[]'::jsonb where id = $1`, [deckId]))) !== null
);
check(
  "a draft holds at most twelve slides",
  (await errorCode(() =>
    db.query(`update public.investor_decks set slides = (select jsonb_agg(x) from generate_series(1,13) x) where id = $1`, [deckId])
  )) !== null
);

console.log("reading decks");
await asUser(ids.investor);
const { rows: investorSees } = await db.query(`select id from public.investor_decks`);
check("an investor cannot read a founder's deck directly", investorSees.length === 0, `saw ${investorSees.length}`);
await asUser(ids.otherOwner);
const { rows: rivalSees } = await db.query(`select id from public.investor_decks`);
check("another owner cannot read the deck", rivalSees.length === 0);

console.log("sharing");
await asUser(ids.owner);
check(
  "a draft deck cannot be shared",
  (await errorCode(() => db.query(`select public.deck_share($1, 'ivy.investor')`, [deckId]))) !== null
);
await db.query(`update public.investor_decks set status = 'ready' where id = $1`, [deckId]);
check(
  "a ready deck with three slides can be marked ready and shared",
  (await errorCode(() => db.query(`select public.deck_share($1, 'ivy.investor')`, [deckId]))) === null
);
check(
  "an owner cannot share with an agent's handle",
  (await errorCode(() => db.query(`select public.deck_share($1, 'ari.agent')`, [deckId]))) !== null
);
check(
  "an owner cannot share with a handle that does not exist",
  (await errorCode(() => db.query(`select public.deck_share($1, 'nobody.here')`, [deckId]))) !== null
);

await asUser(ids.investor);
const { rows: shared } = await db.query(`select public.investor_shared_decks() as d`);
check("the investor sees the shared deck", shared.length === 1, `saw ${shared.length}`);
check("the shared deck carries its slides and the sharer's handle", shared[0]?.d?.slides?.length === 3 && shared[0]?.d?.sharedBy === "olive.founder");
check(
  "the investor cannot insert a share for themselves",
  (await errorCode(() =>
    db.query(`insert into public.investor_deck_shares (deck_id, owner_id, investor_id) values ($1, $2, $3)`, [deckId, ids.owner, ids.investor])
  )) !== null
);
check(
  "the investor cannot share a deck onward",
  (await errorCode(() => db.query(`select public.deck_share($1, 'nina.investor')`, [deckId]))) !== null
);
const shareId = shared[0].d.shareId;
check("the investor can remove a deck from their own list", (await errorCode(() => db.query(`select public.investor_remove_share($1)`, [shareId]))) === null);
const { rows: afterRemove } = await db.query(`select public.investor_shared_decks() as d`);
check("the removed deck disappears for the investor", afterRemove.length === 0);

await asUser(ids.owner);
await db.query(`select public.deck_share($1, 'ivy.investor')`, [deckId]);
check(
  "an owner who revokes a share takes the deck away",
  (await errorCode(() => db.query(`select public.deck_unshare((select id from public.investor_deck_shares where deck_id = $1 and revoked_at is null))`, [deckId]))) === null
);
await asUser(ids.investor);
const { rows: afterRevoke } = await db.query(`select public.investor_shared_decks() as d`);
check("the revoked deck is gone for the investor", afterRevoke.length === 0);

console.log("data a deck may use");
await asUser(ids.owner);
const { rows: onlyBusiness } = await db.query(`select public.deck_data_snapshot(array['business']) as s`);
const sections = onlyBusiness[0].s.sections;
check("a business-only snapshot holds the business and nothing else", sections.business?.name === "Olive Roasters" && !("inventory" in sections) && !("sales" in sections));
check("the snapshot does not reveal another owner's business", !JSON.stringify(onlyBusiness[0].s).includes("Rival Beans"));
check("an empty selection returns no data", JSON.stringify((await db.query(`select public.deck_data_snapshot(array[]::text[]) as s`)).rows[0].s.sections) === "{}");
check(
  "an unknown data section is refused",
  (await errorCode(() => db.query(`select public.deck_data_snapshot(array['payroll'])`))) !== null
);

await asSystem();
await db.query(
  `insert into public.store_orders (owner_id, order_number, customer_name, status, total_amount, currency, placed_at)
   values ($1, 'SO-1', 'Customer', 'paid', 500, 'INR', now())`,
  [ids.owner]
);
await db.query(
  `insert into public.store_orders (owner_id, order_number, customer_name, status, total_amount, currency, placed_at)
   values ($1, 'SO-2', 'Customer', 'paid', 99999, 'INR', now())`,
  [ids.otherOwner]
);
await asUser(ids.owner);
const { rows: sales } = await db.query(`select public.deck_data_snapshot(array['sales']) as s`);
const salesRows = sales[0].s.sections.sales;
check("the sales section counts only the owner's orders", salesRows?.[0]?.orders === 1 && Number(salesRows?.[0]?.revenue) === 500, JSON.stringify(salesRows));

await asUser(ids.investor);
check(
  "an investor cannot read the data snapshot",
  (await errorCode(() => db.query(`select public.deck_data_snapshot(array['business'])`))) !== null
);
await asUser(ids.agent);
check(
  "an agent cannot read the data snapshot",
  (await errorCode(() => db.query(`select public.deck_data_snapshot(array['business'])`))) !== null
);

console.log("the Rs 20 export");
await asSystem();
const { rows: pay } = await db.query(
  `insert into public.payments (owner_id, reference, purpose, label, amount, currency, method, status)
   values ($1, 'DECK-TEST-1', 'deck_pdf', 'Investor deck PDF export', 20, 'INR', 'upi', 'pending') returning id`,
  [ids.owner]
);
const { rows: beforePay } = await db.query(`select count(*)::int as n from public.deck_exports where owner_id = $1`, [ids.owner]);
check("a pending deck payment grants nothing", beforePay[0].n === 0);
await db.query(`update public.payments set status = 'verified' where id = $1`, [pay[0].id]);
await db.query(`update public.payments set status = 'verified' where id = $1`, [pay[0].id]);
const { rows: granted } = await db.query(`select count(*)::int as n from public.deck_exports where owner_id = $1`, [ids.owner]);
check("a verified payment grants exactly one export, even when re-saved", granted[0].n === 1, `rows: ${granted[0].n}`);

await asUser(ids.agent);
check(
  "an agent cannot take an export",
  (await errorCode(() => db.query(`select public.deck_export_take($1)`, [deckId]))) !== null
);

await asUser(ids.owner);
const { rows: taken } = await db.query(`select public.deck_export_take($1) as e`, [deckId]);
check("an owner takes the export", taken[0].e !== null);
const { rows: second } = await db.query(`select public.deck_export_take($1) as e`, [deckId]);
check("the same export cannot be taken twice", second[0].e === null);
await db.query(`select public.deck_export_release($1)`, [taken[0].e]);
const { rows: again } = await db.query(`select public.deck_export_take($1) as e`, [deckId]);
check("a failed render gives the export back", again[0].e === taken[0].e);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
