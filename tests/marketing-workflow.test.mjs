/* ==========================================================================
   Migration 0013 — the request lifecycle a customer actually walks through
   --------------------------------------------------------------------------
   The one transition a customer owns is draft → submitted. Everything after
   that is an administrator decision, and the trigger is what enforces it.
   ========================================================================== */

import path from "node:path";

let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("  ! SKIPPED — @electric-sql/pglite is not installed.");
  process.exit(0);
}

const { SCAFFOLD, migrationFiles, apply } = await import("../scripts/staging-db.mjs");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${extra}`));

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) {
  try {
    await apply(db, file);
  } catch (error) {
    check(`${path.basename(file)} applies`, false, error.message.split("\n")[0]);
  }
}

await db.exec(`
  grant usage on schema public to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
`);

const asCustomer = () => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${CUSTOMER}', false);`);
const asOther = () => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${OTHER}', false);`);
const asAdmin = () => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);

await db.exec(`
  insert into auth.users (id, email) values
    ('${CUSTOMER}', 'customer@example.com'),
    ('${OTHER}',    'other@example.com'),
    ('${ADMIN}',    'admin@example.com');
  insert into public.admin_users (user_id, email, role) values ('${ADMIN}', 'admin@example.com', 'admin');
  insert into public.businesses (owner_id, name, category) values ('${CUSTOMER}', 'Aster Studio', 'photography');
`);
const { rows: biz } = await db.query(`select id from public.businesses where owner_id = '${CUSTOMER}'`);
const businessId = biz[0].id;

console.log("a draft is not a request yet");
await asCustomer();
await db.exec(`
  insert into public.marketing_requests (user_id, business_id, campaign_type, objective, status, details)
  values ('${CUSTOMER}', '${businessId}', 'meta_ads', 'leads', 'draft',
          '{"instagram":"https://instagram.com/aster.studio","age_min":25,"age_max":34}'::jsonb)`);
const { rows: draft } = await db.query(`select id, status, reference, details from public.marketing_requests`);
check("a draft can be saved", draft.length === 1 && draft[0].status === "draft");
check("a draft has no reference", draft[0].reference === null);
check("the request detail is stored as written", draft[0].details.age_min === 25);
const draftId = draft[0].id;

let preApproved = null;
try {
  await db.exec(`insert into public.marketing_requests (user_id, campaign_type, objective, status)
                 values ('${CUSTOMER}', 'google_ads', 'sales', 'approved')`);
} catch (error) {
  preApproved = error.message;
}
check("a request cannot be opened already approved", /draft or as submitted|row-level security/i.test(String(preApproved)), String(preApproved || "accepted"));

console.log("\nsubmitting is the customer's own act");
await db.exec(`update public.marketing_requests set status = 'submitted' where id = '${draftId}'`);
const { rows: submitted } = await db.query(`select status, reference from public.marketing_requests where id = '${draftId}'`);
check("the owner can submit their draft", submitted[0].status === "submitted");
check("submission issues the reference", /^MR-\d{6}-[0-9A-F]{6}$/.test(String(submitted[0].reference)), String(submitted[0].reference));

let selfApprove = null;
try {
  await db.exec(`update public.marketing_requests set status = 'approved' where id = '${draftId}'`);
} catch (error) {
  selfApprove = error.message;
}
check("the owner cannot approve it afterwards", /Only an administrator/i.test(String(selfApprove)), String(selfApprove || "accepted"));

let reopenDraft = null;
try {
  await db.exec(`update public.marketing_requests set status = 'draft' where id = '${draftId}'`);
} catch (error) {
  reopenDraft = error.message;
}
check("a submitted request cannot be pulled back to draft", /Only an administrator/i.test(String(reopenDraft)), String(reopenDraft || "accepted"));

console.log("\nthe customer timeline");
await db.exec(`
  insert into public.marketing_request_events (request_id, actor_id, kind, body, internal)
  values ('${draftId}', '${CUSTOMER}', 'status', 'Request submitted for review.', false)`);
const { rows: ownEvent } = await db.query(`select body, internal from public.marketing_request_events`);
check("the owner can record a customer-visible event", ownEvent.length === 1 && ownEvent[0].internal === false);

let internalNote = null;
try {
  await db.exec(`insert into public.marketing_request_events (request_id, actor_id, kind, body, internal)
                 values ('${draftId}', '${CUSTOMER}', 'note', 'sneaky', true)`);
} catch (error) {
  internalNote = error.message;
}
check("the owner cannot write an internal note", /row-level security|violates/i.test(String(internalNote)), String(internalNote || "accepted"));

await asOther();
const { rows: otherRequests } = await db.query(`select id from public.marketing_requests`);
const { rows: otherEvents } = await db.query(`select id from public.marketing_request_events`);
check("another customer sees nothing", otherRequests.length === 0 && otherEvents.length === 0);

let foreignEvent = null;
try {
  await db.exec(`insert into public.marketing_request_events (request_id, actor_id, kind, body, internal)
                 values ('${draftId}', '${OTHER}', 'note', 'not mine', false)`);
} catch (error) {
  foreignEvent = error.message;
}
check("another customer cannot write into the timeline", /row-level security|violates/i.test(String(foreignEvent)), String(foreignEvent || "accepted"));

console.log("\nthe administrator decides, and the customer is told");
await asAdmin();
const { rows: decided } = await db.query(`
  update public.marketing_requests
     set status = 'under_review', admin_notes = 'Checking the Instagram account', decided_by = '${ADMIN}', decided_at = now()
   where id = '${draftId}' returning status`);
check("an administrator moves it to under review", decided.length === 1 && decided[0].status === "under_review");

const { rows: notified } = await db.query(
  `select public.notify_customer('${CUSTOMER}', 'Your marketing request is under review',
     'Aster Studio — Meta Ads', '/app/?view=marketing') as id`
);
check("an administrator can notify the customer", Boolean(notified[0].id));

await asCustomer();
const { rows: inbox } = await db.query(`select title, type from public.notifications where user_id = '${CUSTOMER}'`);
check("the customer received the marketing notification", inbox.some((n) => n.type === "marketing"), JSON.stringify(inbox));
check("no duplicate marketing notifications were written",
  inbox.filter((n) => n.type === "marketing").length === 1, String(inbox.filter((n) => n.type === "marketing").length));

let customerNotify = null;
try {
  await db.exec(`select public.notify_customer('${CUSTOMER}', 'self', 'x')`);
} catch (error) {
  customerNotify = error.message;
}
check("a customer cannot notify anybody through that door", /Only an administrator|permission denied/i.test(String(customerNotify)), String(customerNotify || "accepted"));

console.log("\nstatuses the workflow needs");
await asAdmin();
for (const next of ["more_information_required", "approved", "in_progress", "completed", "rejected"]) {
  const { rows } = await db.query(`update public.marketing_requests set status = '${next}' where id = '${draftId}' returning status`);
  check(`'${next}' is accepted`, rows.length === 1 && rows[0].status === next);
}

let badStatus = null;
try {
  await db.exec(`update public.marketing_requests set status = 'launched' where id = '${draftId}'`);
} catch (error) {
  badStatus = error.message;
}
check("a status outside the workflow is refused", /check constraint|violates/i.test(String(badStatus)), String(badStatus || "accepted"));

console.log("\nreferences stay unique");
await asOther();
await db.exec(`insert into public.marketing_requests (user_id, campaign_type, objective, status)
               values ('${OTHER}', 'google_ads', 'traffic', 'submitted')`);
/* Read as the owner of the table: each customer can only see their own row,
   which is the point of the policy, so uniqueness has to be checked outside. */
await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
const { rows: refs } = await db.query(`select reference, status from public.marketing_requests order by created_at`);
check("both requests exist", refs.length === 2, String(refs.length));
check("two submitted requests get different references", refs[0].reference !== refs[1].reference, JSON.stringify(refs.map((r) => r.reference)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
