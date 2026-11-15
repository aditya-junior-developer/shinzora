/* ==========================================================================
   Request Services (0055) — behaviour, in PGlite
   --------------------------------------------------------------------------
   Replays every migration into an in-process PostgreSQL, then checks:
     - exactly five statuses are accepted; the old ones are refused
     - a customer can submit a request only as 'submitted', with no amount,
       payment, assignee or admin note
     - the ten categories need a positive INR budget; 'others' needs a written
       description; legacy paid-service types still work without a budget
     - a customer cannot update or delete their own request, or read another's
     - an administrator can update status and note
     - every submission, status change and new note notifies the owner, and
       other edits do not
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
  bob: "00000000-0000-4000-8000-0000000000b2",
  admin: "00000000-0000-4000-8000-0000000000ad"
};

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}
await db.query(`insert into public.admin_users (user_id, email, role) values ($1, $2, 'admin') on conflict do nothing`, [ids.admin, "admin@test.local"]);

/* Supabase grants table privileges to `authenticated` by default, and row
   security then decides what each person can touch. The replay scaffold does
   not add those defaults, so grant them here for the table under test. The
   policies, not the grants, are what this suite is checking. */
await db.exec(`
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on public.service_requests to authenticated;
  grant select on public.payments to authenticated;
  grant select on public.notifications to authenticated;
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

/* True only when the operation fails with the expected SQLSTATE. */
const refused = async (fn, code) => {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
};

const customerRequest = (overrides = {}) => ({
  owner_id: ids.alice,
  service_type: "business_cards",
  title: "500 cards for the Diwali launch",
  status: "submitted",
  budget_inr: 2500,
  contact_name: "alice",
  contact_email: "alice@test.local",
  contact_phone: "+919999999999",
  ...overrides
});

/* Inserts exactly the columns the app sends. Optional fields that are not set
   are left out, so the column defaults apply the way they do in the browser.
   amount is one of those fields: the table default is 0. */
const insertRequest = (row) => {
  const all = {
    owner_id: row.owner_id,
    service_type: row.service_type,
    title: row.title,
    status: row.status,
    budget_inr: row.budget_inr,
    custom_description: row.custom_description,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    amount: row.amount,
    payment_id: row.payment_id,
    assigned_to: row.assigned_to,
    admin_note: row.admin_note
  };
  const present = Object.entries(all).filter(([, v]) => v !== undefined && v !== null);
  const cols = present.map(([k]) => k).join(", ");
  const marks = present.map((_, i) => `$${i + 1}`).join(", ");
  return db.query(
    `insert into public.service_requests (${cols}) values (${marks}) returning id, reference, respond_by`,
    present.map(([, v]) => v)
  );
};

const notesFor = async (uid) =>
  q(`select title, body, link from public.notifications where user_id = $1 order by created_at, id`, [uid]);

console.log("statuses");
await asSystem();
const okStatuses = ["submitted", "under_review", "in_progress", "completed", "rejected"];
for (const status of okStatuses) {
  const ok = await refused(async () => {
    await insertRequest(customerRequest({ status, title: `status ${status}` }));
  }, "23514");
  check(`status '${status}' is accepted`, !ok);
}
for (const status of ["requested", "approved", "cancelled"]) {
  check(`legacy status '${status}' is refused`, await refused(() => insertRequest(customerRequest({ status })), "23514"));
}

console.log("customer submission");
await asUser(ids.alice);
const submitted = await insertRequest(customerRequest({ title: "Alice's first card order" }));
check("a customer can submit a budgeted category request", submitted.rows.length === 1);
check("the new request has a reference", /^SR-/.test(submitted.rows[0]?.reference || ""));
check(
  "the contact time is about 24 hours after submission",
  submitted.rows[0] && Math.abs(Date.parse(submitted.rows[0].respond_by) - Date.now() - 86400000) < 60000
);

check(
  "a customer cannot submit at a status other than 'submitted'",
  await refused(() => insertRequest(customerRequest({ status: "completed" })), "42501")
);
check(
  "an app-shaped insert that leaves amount to its default is accepted",
  (await insertRequest(customerRequest({ title: "Default amount" }))).rows.length === 1
);
check(
  "a customer cannot set an amount",
  await refused(() => insertRequest(customerRequest({ amount: 100 })), "42501")
);
check(
  "a customer cannot assign their own request",
  await refused(() => insertRequest(customerRequest({ assigned_to: ids.admin })), "42501")
);
check(
  "a customer cannot write an admin note",
  await refused(() => insertRequest(customerRequest({ admin_note: "looks done" })), "42501")
);
check(
  "a customer cannot submit for another owner",
  await refused(() => insertRequest(customerRequest({ owner_id: ids.bob })), "42501")
);

console.log("budget and description");
check(
  "a category request without a budget is refused",
  await refused(() => insertRequest(customerRequest({ budget_inr: null })), "23514")
);
check(
  "a zero budget is refused",
  await refused(() => insertRequest(customerRequest({ budget_inr: 0 })), "23514")
);
check(
  "a negative budget is refused",
  await refused(() => insertRequest(customerRequest({ budget_inr: -10 })), "23514")
);
check(
  "a budget above the ceiling is refused",
  await refused(() => insertRequest(customerRequest({ budget_inr: 200000000 })), "23514")
);
check(
  "'others' without a description is refused",
  await refused(() => insertRequest(customerRequest({ service_type: "others", custom_description: "too short" })), "23514")
);
check(
  "'others' with a description is accepted",
  (await insertRequest(customerRequest({
    service_type: "others",
    title: "Something custom",
    custom_description: "A branded souvenir box for 200 corporate guests in Pune."
  }))).rows.length === 1
);
check(
  "an unknown category is refused",
  await refused(() => insertRequest(customerRequest({ service_type: "crypto_mining" })), "23514")
);
check(
  "every new category is accepted with a budget",
  await (async () => {
    const categories = ["business_cards", "meta_ads", "video_maker", "post_maker", "nfc_cards", "custom_packaging", "export_international", "business_audits", "ai_calling"];
    for (const service_type of categories) {
      await insertRequest(customerRequest({ service_type, title: service_type }));
    }
    return true;
  })()
);
check(
  "a legacy billing service still needs no budget",
  (await insertRequest(customerRequest({ service_type: "website_setup", budget_inr: null, title: "Website" }))).rows.length === 1
);
check(
  "a legacy account action still needs no budget",
  (await insertRequest(customerRequest({ service_type: "account_deletion", budget_inr: null, title: "Deletion" }))).rows.length === 1
);

console.log("customer read and write");
await asUser(ids.alice);
const own = await q(`select count(*)::int as n from public.service_requests where owner_id = $1`, [ids.alice]);
check("a customer reads their own requests", own[0].n >= 1);
const others = await q(`select count(*)::int as n from public.service_requests where owner_id = $1`, [ids.bob]);
check("a customer cannot read another customer's requests", others[0].n === 0);

const mine = await q(`select id from public.service_requests where owner_id = $1 limit 1`, [ids.alice]);
const updated = await db.query(`update public.service_requests set status = 'completed' where id = $1 returning id`, [mine[0].id]);
check("a customer cannot change their request's status", updated.rows.length === 0);
const noted = await db.query(`update public.service_requests set admin_note = 'done' where id = $1 returning id`, [mine[0].id]);
check("a customer cannot write a note", noted.rows.length === 0);
const deleted = await db.query(`delete from public.service_requests where id = $1 returning id`, [mine[0].id]);
check("a customer cannot delete their request", deleted.rows.length === 0);

console.log("administrator");
await asUser(ids.admin);
const adminView = await q(`select count(*)::int as n from public.service_requests`);
check("an administrator reads every request", adminView[0].n >= 10, String(adminView[0].n));
const sample = await q(`select id from public.service_requests where owner_id = $1 limit 1`, [ids.alice]);
const moved = await db.query(
  `update public.service_requests set status = 'under_review' where id = $1 returning status`,
  [sample[0].id]
);
check("an administrator can move a request to under review", moved.rows[0]?.status === "under_review");
const assigned = await db.query(
  `update public.service_requests set assigned_to = $2 where id = $1 returning assigned_to`,
  [sample[0].id, ids.admin]
);
check("an administrator can assign a request", assigned.rows[0]?.assigned_to === ids.admin);

console.log("notifications");
await asSystem();
const before = await notesFor(ids.alice);
const [{ id: targetId }] = await q(`select id from public.service_requests where owner_id = $1 and title = 'Alice''s first card order'`, [ids.alice]);

await db.query(`update public.service_requests set status = 'in_progress' where id = $1`, [targetId]);
let after = await notesFor(ids.alice);
const progress = after.slice(before.length).filter((n) => n.title === "Request update: In Progress");
check("a status change notifies the owner once", progress.length === 1, String(progress.length));
check("the status notification links to the request", progress[0]?.link === `/app/?view=requests&id=${targetId}`);

const beforeNote = after.length;
await db.query(`update public.service_requests set admin_note = 'Printing starts Monday.' where id = $1`, [targetId]);
after = await notesFor(ids.alice);
const noteAlerts = after.slice(beforeNote).filter((n) => n.title === "New note on your request");
check("a new admin note notifies the owner", noteAlerts.length === 1 && noteAlerts[0].body.includes("Printing starts Monday."));

const beforeTitle = (await notesFor(ids.alice)).length;
await db.query(`update public.service_requests set title = 'Renamed' where id = $1`, [targetId]);
check("editing something other than status or note does not notify", (await notesFor(ids.alice)).length === beforeTitle);

const beforeSame = (await notesFor(ids.alice)).length;
await db.query(`update public.service_requests set status = 'in_progress' where id = $1`, [targetId]);
check("setting the same status again does not notify", (await notesFor(ids.alice)).length === beforeSame);

const beforeDone = (await notesFor(ids.alice)).length;
await db.query(`update public.service_requests set status = 'completed' where id = $1`, [targetId]);
const done = (await notesFor(ids.alice)).slice(beforeDone).filter((n) => n.title === "Request update: Completed");
check("completion notifies with the completed label", done.length === 1);

const received = (await notesFor(ids.alice)).filter((n) => n.title === "Request received");
check("a submission notifies the owner that it was received", received.length >= 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
