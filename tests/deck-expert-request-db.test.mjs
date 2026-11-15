/* ==========================================================================
   "Written by Experts" investor deck request (0062) — behaviour in PGlite
   --------------------------------------------------------------------------
     - a member can request an expert deck for their own deck
     - the request is stored as an investor_deck_expert service request
     - it needs no budget, and it can be tracked to the deck it is about
     - a member cannot attach a deck link to any other request type
     - a member cannot request an expert deck for someone else's deck
     - the admin desk sees every such request (service role)
   Replays every migration, the same way premium-db.test.mjs does.
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
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name, account_type) values ($1, $2, 'owner') on conflict (id) do update set account_type = 'owner'`, [uid, name]);
}

/* Supabase grants table privileges to `authenticated` by default; the scaffold
   does not, so grant them here. The policies, not the grants, are under test. */
await db.exec(`
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on public.service_requests to authenticated;
  grant select, insert, update, delete on public.investor_decks to authenticated;
`);

const deckId = (await q(
  `insert into public.investor_decks (owner_id, title, mode, status, slides)
   values ($1, 'Seed round', 'manual', 'draft', '[]'::jsonb) returning id`,
  [ids.alice]
))[0].id;

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
const refused = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

/* The insert shape the app sends (see views/deck-experts.js). */
const expertRow = (owner, deck) => ({
  owner_id: owner,
  service_type: "investor_deck_expert",
  title: "Investor deck: Seed round — written by experts",
  details: "Seed round. Sections: business.",
  custom_description: "Seed round. Sections: business.",
  budget_inr: null,
  contact_name: owner === ids.alice ? "alice" : "bob",
  contact_email: `${owner === ids.alice ? "alice" : "bob"}@test.local`,
  contact_phone: null,
  status: "submitted",
  deck_id: deck
});

const insertRequest = (row) =>
  db.query(
    `insert into public.service_requests
       (owner_id, service_type, title, details, custom_description, budget_inr, contact_name, contact_email, contact_phone, status, deck_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [row.owner_id, row.service_type, row.title, row.details, row.custom_description, row.budget_inr, row.contact_name, row.contact_email, row.contact_phone, row.status, row.deck_id]
  );

console.log("expert deck requests");
await asUser(ids.alice);
let created = null;
try {
  created = (await insertRequest(expertRow(ids.alice, deckId))).rows[0];
} catch (error) {
  console.log(error.message);
}
check("a member can request an expert deck for their own deck", Boolean(created?.id));

await asSystem();
const stored = await q(`select service_type, status, budget_inr, deck_id from public.service_requests where id = $1`, [created?.id]);
check("it is stored as an investor_deck_expert request, submitted", stored[0]?.service_type === "investor_deck_expert" && stored[0]?.status === "submitted");
check("it needs no budget", stored[0]?.budget_inr === null);
check("it is tracked to the deck it is about", stored[0]?.deck_id === deckId);

await asUser(ids.bob);
check(
  "a member cannot request an expert deck for someone else's deck",
  await refused(() => insertRequest({ ...expertRow(ids.bob, deckId) }))
);

await asUser(ids.alice);
check(
  "a deck link cannot be attached to any other request type",
  await refused(() =>
    insertRequest({ ...expertRow(ids.alice, deckId), service_type: "business_cards", budget_inr: 5000, title: "Cards" })
  )
);

await asSystem();
const adminSees = await q(`select count(*)::int as n from public.service_requests where service_type = 'investor_deck_expert'`);
check("the admin desk sees the request", adminSees[0].n === 1);

await db.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
