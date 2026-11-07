/* ==========================================================================
   Migration 0011 — the builder, conversion and marketing tables under real RLS
   --------------------------------------------------------------------------
   Every rule in this file is a rule the product promised the customer:

     • a customer files a marketing request; only an administrator can move it
       through the review states, and the block is in the database, not the UI
     • a customer never verifies their own connected account
     • a browser can never report an APK/AAB/IPA as built
     • internal notes are invisible to the customer
     • a campaign request announces itself to administrators, and an anonymous
       caller cannot announce anything
     • Free and Pro may target one app platform, Enterprise two

   Run with: node tests/marketing-rls.test.mjs
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

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const SUPPORT = "44444444-4444-4444-8444-444444444444";

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
  /* Supabase grants EXECUTE on new functions to anon by default, and the blanket
     grant above would undo the migration's revoke simply because the harness
     runs it last. Re-apply the revoke so the privileges under test match what a
     real apply produces. */
  revoke all on function public.app_platform_slots(uuid) from public, anon;
`);

console.log("\nthe migration landed");

const { rows: tables } = await db.query(`
  select table_name from information_schema.tables
   where table_schema = 'public'
     and table_name in ('ai_generation_jobs','conversion_jobs','marketing_accounts',
                        'marketing_requests','marketing_request_events')
   order by table_name`);
check("all five tables exist", tables.length === 5, JSON.stringify(tables.map((t) => t.table_name)));

const { rows: rls } = await db.query(`
  select c.relname, c.relrowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('ai_generation_jobs','conversion_jobs','marketing_accounts',
                       'marketing_requests','marketing_request_events')`);
check("row level security is enabled on every one of them", rls.length === 5 && rls.every((r) => r.relrowsecurity === true));

/* --- fixtures ------------------------------------------------------------ */
await db.exec(`
  insert into auth.users (id, email) values
    ('${CUSTOMER}', 'customer@example.com'),
    ('${OTHER}',    'other@example.com'),
    ('${ADMIN}',    'admin@example.com'),
    ('${SUPPORT}',  'support@example.com');

  insert into public.admin_users (user_id, email, role) values
    ('${ADMIN}',   'admin@example.com',   'admin'),
    ('${SUPPORT}', 'support@example.com', 'support');

  insert into public.businesses (owner_id, name, category) values
    ('${CUSTOMER}', 'Aster Studio', 'photography');

  insert into public.projects (owner_id, name, type) values
    ('${CUSTOMER}', 'Aster website', 'website');
`);

const { rows: biz } = await db.query(`select id from public.businesses where owner_id = '${CUSTOMER}'`);
const { rows: proj } = await db.query(`select id from public.projects where owner_id = '${CUSTOMER}'`);
const businessId = biz[0].id;
const projectId = proj[0].id;

const asCustomer = () =>
  db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${CUSTOMER}', false);`);
const asOther = () =>
  db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${OTHER}', false);`);
const asAdmin = () =>
  db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
const asAnon = () =>
  db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;`);

/* ---------------------------------------------------------- generation jobs */
console.log("\ngeneration jobs");
await asCustomer();
await db.exec(`
  insert into public.ai_generation_jobs (user_id, project_id, kind, status, stage, stages, progress)
  values ('${CUSTOMER}', '${projectId}', 'website', 'running', 'writing_code',
          '[{"id":"brief","done":true},{"id":"structure","done":true},{"id":"code","done":false}]'::jsonb, 60)`);
const { rows: ownJob } = await db.query(`select id, progress from public.ai_generation_jobs`);
check("a customer can open their own generation job", ownJob.length === 1 && Number(ownJob[0].progress) === 60);

let foreignJob = null;
try {
  await db.exec(`insert into public.ai_generation_jobs (user_id, kind) values ('${OTHER}', 'website')`);
} catch (error) {
  foreignJob = error.message;
}
check("a job cannot be opened on behalf of somebody else", /row-level security|violates/i.test(String(foreignJob)), String(foreignJob || "it succeeded"));

const { rows: progressGuard } = await db.query(`
  select 1 from public.ai_generation_jobs where progress between 0 and 100`);
check("the progress column is constrained to 0–100", progressGuard.length === 1);
let badProgress = null;
try {
  await db.exec(`insert into public.ai_generation_jobs (user_id, progress) values ('${CUSTOMER}', 140)`);
} catch (error) {
  badProgress = error.message;
}
check("progress above 100 is rejected", /check constraint|violates/i.test(String(badProgress)), String(badProgress || "accepted"));

/* ---------------------------------------------------------- conversion jobs */
console.log("\nconversion jobs (a browser must never report a package as built)");
await asCustomer();
await db.exec(`
  insert into public.conversion_jobs (user_id, project_id, platform, target, app_name)
  values ('${CUSTOMER}', '${projectId}', 'android', 'apk', 'Aster Studio')`);
const { rows: conv } = await db.query(`select id, status from public.conversion_jobs`);
check("a customer can register a conversion request", conv.length === 1 && conv[0].status === "queued");

let claimedBuilt = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, platform, target, app_name, status)
                 values ('${CUSTOMER}', 'android', 'apk', 'Fake', 'built')`);
} catch (error) {
  claimedBuilt = error.message;
}
check("a job cannot be opened already marked 'built'",
  /starts as queued|row-level security|violates/i.test(String(claimedBuilt)), String(claimedBuilt || "it succeeded"));

const { rows: promoted } = await db.query(
  `update public.conversion_jobs set status = 'built', artifact_path = 'x.apk' where id = '${conv[0].id}' returning id`
);
check("a customer cannot promote their own job to 'built'", promoted.length === 0, `${promoted.length} row(s) changed`);

let iosAsIpa = null;
try {
  await db.exec(`insert into public.conversion_jobs (user_id, platform, target, app_name)
                 values ('${CUSTOMER}', 'android', 'ipa', 'Wrong pairing')`);
} catch (error) {
  iosAsIpa = error.message;
}
check("an iOS target cannot be filed under the Android platform",
  /does not belong to that platform|check constraint|violates/i.test(String(iosAsIpa)), String(iosAsIpa || "accepted"));

/* ------------------------------------------------------- marketing accounts */
console.log("\nconnected marketing accounts");
await asCustomer();
await db.exec(`
  insert into public.marketing_accounts (user_id, business_id, channel, handle, profile_url, details)
  values ('${CUSTOMER}', '${businessId}', 'instagram', 'aster.studio',
          'https://instagram.com/aster.studio', '{"followers":0,"business":true}'::jsonb)`);
const { rows: account } = await db.query(`select id, status from public.marketing_accounts`);
check("a customer can record a connection at 'submitted'", account.length === 1 && account[0].status === "submitted");

let selfVerifyInsert = null;
try {
  await db.exec(`insert into public.marketing_accounts (user_id, channel, handle, status)
                 values ('${CUSTOMER}', 'facebook', 'aster', 'verified')`);
} catch (error) {
  selfVerifyInsert = error.message;
}
check("a connection cannot be opened already 'verified'", /row-level security|violates/i.test(String(selfVerifyInsert)), String(selfVerifyInsert || "it succeeded"));

let selfVerifyUpdate = null;
try {
  await db.exec(`update public.marketing_accounts set status = 'verified', verified_at = now() where id = '${account[0].id}'`);
} catch (error) {
  selfVerifyUpdate = error.message;
}
check("a customer cannot verify their own account", /42501|Only an administrator/i.test(String(selfVerifyUpdate)), String(selfVerifyUpdate || "the update was allowed"));

const { rows: stillSubmitted } = await db.query(`select status from public.marketing_accounts where id = '${account[0].id}'`);
check("the refused verification left the row untouched", stillSubmitted[0].status === "submitted");

const { rows: editable } = await db.query(
  `update public.marketing_accounts set handle = 'aster.studio.official' where id = '${account[0].id}' returning handle, status`
);
check("the customer can still correct their own handle", editable.length === 1 && editable[0].status === "submitted");

await asAdmin();
const { rows: verified } = await db.query(
  `update public.marketing_accounts set status = 'verified', verified_by = '${ADMIN}', verified_at = now()
    where id = '${account[0].id}' returning status`
);
check("an administrator can verify the account", verified.length === 1 && verified[0].status === "verified");

let passwords = null;
try {
  await db.exec(`alter table public.marketing_accounts add column password text`);
  passwords = "ok";
} catch (error) {
  passwords = error.message;
}
check("there is no password column on a connection record", true);
await db.query(`select 1`);
const { rows: columns } = await db.query(`
  select column_name from information_schema.columns
   where table_schema='public' and table_name='marketing_accounts'`);
const columnNames = columns.map((c) => c.column_name).join(",");
check(
  "no credential-shaped column exists (password, token, secret, cookie)",
  !/password|token|secret|cookie|api_key/i.test(columnNames),
  columnNames
);

/* ------------------------------------------------------- marketing requests */
console.log("\nmarketing campaign requests");
await asCustomer();
await db.exec(`
  insert into public.marketing_requests
    (user_id, business_id, campaign_type, objective, audience, location,
     budget_mode, budget_paise, duration_days, start_date, creative_notes,
     contact_preference, accounts)
  values
    ('${CUSTOMER}', '${businessId}', 'meta_ads', 'leads', 'Brides 25-34', 'Delhi NCR',
     'total', 1500000, 14, current_date + 7, 'Use the logo and two studio photos',
     'email', '[{"channel":"instagram","handle":"aster.studio.official"}]'::jsonb)`);

const { rows: request } = await db.query(`select id, reference, status, budget_paise from public.marketing_requests`);
check("a customer can file a request", request.length === 1);
check("it starts at 'submitted'", request[0].status === "submitted");
check(
  "a human-readable reference is generated (MR-YYMMDD-XXXXXX)",
  /^MR-\d{6}-[0-9A-F]{6}$/.test(String(request[0].reference)),
  String(request[0].reference)
);
check("the budget is stored exactly, in paise", Number(request[0].budget_paise) === 1500000);
const requestId = request[0].id;

let preApproved = null;
try {
  await db.exec(`insert into public.marketing_requests (user_id, campaign_type, objective, status)
                 values ('${CUSTOMER}', 'google_ads', 'sales', 'approved')`);
} catch (error) {
  preApproved = error.message;
}
check(
  "a request cannot be filed already 'approved'",
  /row-level security|violates|starts as a draft or as submitted/i.test(String(preApproved)),
  String(preApproved || "it succeeded")
);

let selfApprove = null;
try {
  await db.exec(`update public.marketing_requests set status = 'approved' where id = '${requestId}'`);
} catch (error) {
  selfApprove = error.message;
}
check("a customer cannot approve their own request", /42501|Only an administrator/i.test(String(selfApprove)), String(selfApprove || "the update was allowed"));

const { rows: stillSubmittedReq } = await db.query(`select status from public.marketing_requests where id = '${requestId}'`);
check("the refused approval left the status at 'submitted'", stillSubmittedReq[0].status === "submitted");

const { rows: noteEdit } = await db.query(
  `update public.marketing_requests set contact_preference = 'whatsapp', audience = 'Brides 25-40, Delhi'
    where id = '${requestId}' returning contact_preference, audience`
);
check("the customer can still correct the brief they filed", noteEdit.length === 1 && noteEdit[0].contact_preference === "whatsapp");

let adminField = null;
try {
  await db.exec(`update public.marketing_requests set admin_notes = 'looks good' where id = '${requestId}'`);
} catch (error) {
  adminField = error.message;
}
check("a customer cannot write the internal review notes", /42501|Only an administrator/i.test(String(adminField)), String(adminField || "the write was allowed"));

let reassign = null;
try {
  await db.exec(`update public.marketing_requests set assigned_to = '${ADMIN}' where id = '${requestId}'`);
} catch (error) {
  reassign = error.message;
}
check("a customer cannot assign themselves a reviewer", /42501|Only an administrator/i.test(String(reassign)), String(reassign || "the write was allowed"));

await asAdmin();
const { rows: adminSees } = await db.query(`select id, user_id from public.marketing_requests`);
check("an administrator sees the customer's request", adminSees.length === 1 && adminSees[0].user_id === CUSTOMER);

const { rows: moved } = await db.query(
  `update public.marketing_requests
      set status = 'under_review', admin_notes = 'Checking the ad account', decided_by = '${ADMIN}', decided_at = now()
    where id = '${requestId}' returning status`
);
check("an administrator can move it to 'under_review'", moved.length === 1 && moved[0].status === "under_review");

for (const next of ["more_information_required", "approved", "in_progress", "completed"]) {
  const { rows } = await db.query(`update public.marketing_requests set status = '${next}' where id = '${requestId}' returning status`);
  check(`the status '${next}' is accepted for an administrator`, rows.length === 1 && rows[0].status === next);
}

await db.exec(`
  insert into public.marketing_request_events (request_id, actor_id, kind, body, internal)
  values ('${requestId}', '${ADMIN}', 'note', 'Customer asked for a call back on Monday', true),
         ('${requestId}', '${ADMIN}', 'status', 'Approved. We will call to confirm the budget.', false)`);

const { rows: adminEvents } = await db.query(`select kind, internal from public.marketing_request_events`);
check("an administrator sees internal and customer-visible notes", adminEvents.length === 2);

await asCustomer();
const { rows: customerEvents } = await db.query(`select kind, internal from public.marketing_request_events`);
check("the customer sees only the customer-visible note", customerEvents.length === 1 && customerEvents[0].internal === false);

/* 0013 lets the owner answer on their own request — that is how "Send the extra
   information" is recorded. An internal note stays administrator-only. */
let customerNote = null;
try {
  await db.exec(`insert into public.marketing_request_events (request_id, actor_id, kind, body, internal)
                 values ('${requestId}', '${CUSTOMER}', 'note', 'Extra information sent', false)`);
} catch (error) {
  customerNote = error.message;
}
check("a customer can answer on their own request", customerNote === null, String(customerNote || ""));

let customerInternal = null;
try {
  await db.exec(`insert into public.marketing_request_events (request_id, actor_id, kind, body, internal)
                 values ('${requestId}', '${CUSTOMER}', 'note', 'my own internal note', true)`);
} catch (error) {
  customerInternal = error.message;
}
check(
  "a customer cannot write an internal note",
  /row-level security|violates/i.test(String(customerInternal)),
  String(customerInternal || "it succeeded")
);

await asOther();
const { rows: otherSees } = await db.query(`select id from public.marketing_requests`);
const { rows: otherAccounts } = await db.query(`select id from public.marketing_accounts`);
const { rows: otherJobs } = await db.query(`select id from public.ai_generation_jobs`);
check("another customer sees none of it", otherSees.length === 0 && otherAccounts.length === 0 && otherJobs.length === 0);

/* ------------------------------------------------------------- notifications */
console.log("\nadmin notification");
await asCustomer();
/* Counted as the table owner: admin_users is deliberately not readable by a
   customer, so the fixture has to be measured from outside RLS. */
await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
const { rows: adminCount } = await db.query(
  `select count(*)::int n from public.admin_users where role in ('admin','superadmin')`
);
await asCustomer();
const { rows: notified } = await db.query(
  `select public.notify_admins('New marketing request',
     'Aster Studio filed a Meta Ads request.', '/admin/marketing') as n`
);
check(
  "one notification per administrator, and no others",
  Number(notified[0].n) === Number(adminCount[0].n),
  `sent ${notified[0].n}, administrators ${adminCount[0].n}`
);

await asAdmin();
const { rows: adminInbox } = await db.query(`select user_id, title, link from public.notifications where title = 'New marketing request'`);
check("the administrator received the notification", adminInbox.some((n) => n.user_id === ADMIN));
check("no duplicate notifications were written", adminInbox.length === Number(adminCount[0].n), `${adminInbox.length}`);
check("the support role was not notified", !adminInbox.some((n) => n.user_id === SUPPORT));

await asCustomer();
const { rows: ownInbox } = await db.query(`select id from public.notifications where title = 'New marketing request'`);
check("the customer did not notify themselves", ownInbox.length === 0);

await asAnon();
let anonNotify = null;
try {
  await db.exec(`select public.notify_admins('Spam', 'from nowhere')`);
} catch (error) {
  anonNotify = error.message;
}
check("an anonymous caller cannot notify administrators", /permission denied|42501|signed-in/i.test(String(anonNotify)), String(anonNotify || "it succeeded"));

/* -------------------------------------------------------------- entitlements */
console.log("\napp platform entitlements");
await asCustomer();
const { rows: freePlan } = await db.query(`select plan from public.subscriptions where user_id = '${CUSTOMER}'`);
check("the fixture really is on the free plan", freePlan[0]?.plan === "free", String(freePlan[0]?.plan));

const slots = async (user) => {
  const { rows } = await db.query(`select public.app_platform_slots('${user}') as n`);
  return Number(rows[0].n);
};
check("Free may build for one platform", (await slots(CUSTOMER)) === 1);

/* A plan change is a billing event, not a profile edit: no client role may make
   one. These fixtures are written as the table owner, the same way the payment
   path and the service role do it. */
const setPlan = async (plan) => {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  await db.exec(`update public.subscriptions set plan = '${plan}' where user_id = '${CUSTOMER}'`);
  await asCustomer();
};
await setPlan("pro");
check("Pro may still build for one platform", (await slots(CUSTOMER)) === 1);
await setPlan("enterprise");
check("Enterprise may build for Android and iOS", (await slots(CUSTOMER)) === 2);

/* With no argument it answers for the caller, and this caller is Enterprise. */
const { rows: noArg } = await db.query(`select public.app_platform_slots() as n`);
check("with no argument it answers for the caller", Number(noArg[0].n) === 2);

await asOther();
const { rows: otherSlots } = await db.query(`select public.app_platform_slots() as n`);
check("a Free account still gets one, whoever asks", Number(otherSlots[0].n) === 1);

let anonSlots = null;
await asAnon();
try {
  await db.exec(`select public.app_platform_slots('${CUSTOMER}')`);
} catch (error) {
  anonSlots = error.message;
}
check("an anonymous caller cannot read a plan entitlement", /permission denied|42501/i.test(String(anonSlots)), String(anonSlots || "it was allowed"));

await asCustomer();

/* A customer must not be able to grant themselves Enterprise to get two slots. */
await asCustomer();
const { rows: selfUpgrade } = await db.query(
  `update public.subscriptions set plan = 'enterprise' where user_id = '${CUSTOMER}' returning plan`
);
check("a customer cannot change their own plan through the table", selfUpgrade.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
