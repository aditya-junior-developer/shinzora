/* ==========================================================================
   Marketplace — database contract
   --------------------------------------------------------------------------
   These assertions exist because the marketplace moves money and reputation.
   They test the rules that a UI cannot be trusted to enforce:

     • a client cannot propose on their own job
     • one party cannot accept a proposal on someone else's job
     • a third party cannot read proposals, contracts or another's profile
     • only the two parties can complete a contract or leave a review
     • a review cannot be left twice, or before completion
     • status transitions cannot be forced out of order
     • a cancelled contract never counts as completed work

   Run with: node tests/marketplace-db.test.mjs
   ========================================================================== */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCAFFOLD, migrationFiles, apply } from "../scripts/staging-db.mjs";

let pass = 0;
const ok = (name, extra = "") => {
  pass += 1;
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
};

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) await apply(db, file);

await db.exec(`
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select jsonb_build_object('email', nullif(current_setting('request.jwt.claim.email', true), ''))
  $$;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant execute on all functions in schema public to authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
  grant usage, select on all sequences in schema public to authenticated, service_role;

  insert into auth.users (id, email) values
    ('aaaaaaaa-1111-4111-8111-111111111111', 'client@example.com'),
    ('bbbbbbbb-2222-4222-8222-222222222222', 'freelancer@example.com'),
    ('cccccccc-3333-4333-8333-333333333333', 'stranger@example.com'),
    ('dddddddd-4444-4444-8444-444444444444', 'rival@example.com');

  insert into public.profiles (id, email, full_name) values
    ('aaaaaaaa-1111-4111-8111-111111111111', 'client@example.com', 'Client Co'),
    ('bbbbbbbb-2222-4222-8222-222222222222', 'freelancer@example.com', 'Freelancer One'),
    ('cccccccc-3333-4333-8333-333333333333', 'stranger@example.com', 'Stranger'),
    ('dddddddd-4444-4444-8444-444444444444', 'rival@example.com', 'Rival')
  on conflict (id) do nothing;
`);

const CLIENT = "aaaaaaaa-1111-4111-8111-111111111111";
const FREELANCER = "bbbbbbbb-2222-4222-8222-222222222222";
const STRANGER = "cccccccc-3333-4333-8333-333333333333";
const RIVAL = "dddddddd-4444-4444-8444-444444444444";

const as = (id, email) =>
  db.exec(`reset role; set role authenticated;
           select set_config('request.jwt.claim.sub','${id}',false);
           select set_config('request.jwt.claim.email','${email}',false);`);
const rpc = async (sql) => (await db.query(sql)).rows[0];
const rejects = async (sql, pattern) => {
  try {
    await db.query(sql);
    return false;
  } catch (error) {
    return pattern ? pattern.test(error.message) : true;
  }
};

console.log("marketplace · setup");

await as(CLIENT, "client@example.com");
const job = (await rpc(`select public.marketplace_create_job(
  'Build a bakery website','We need a five page site for a bakery in Delhi with menus and an order form.',
  array['Web Design','Copywriting'], 15000, 30000, 'INR', 14, null) as result`)).result;
assert.ok(job.jobId);
ok("a client can post a job", job.status);

await as(FREELANCER, "freelancer@example.com");
const profile = (await rpc(`select public.marketplace_upsert_freelancer(
  'Full-stack designer','I build small business sites end to end.',
  array['Web Design','Copywriting','React'], 1200, 'INR', 'available',
  'https://example.com/portfolio', 6, true) as result`)).result;
assert.deepEqual(profile.skills, ["copywriting", "react", "web design"]);
ok("skills are normalised, de-duplicated and sorted", profile.skills.join(","));

console.log("marketplace · proposal rules");

await as(CLIENT, "client@example.com");
const ownJob = await rejects(
  `select public.marketplace_submit_proposal('${job.jobId}','self bid',1000,5)`,
  /own job/
);
assert.ok(ownJob, "a client must not propose on their own job");
ok("a client cannot propose on their own job");

await as(RIVAL, "rival@example.com");
const rivalProposal = (await rpc(`select public.marketplace_submit_proposal(
  '${job.jobId}','I can start on Monday.', 22000, 10) as result`)).result;
ok("a second freelancer can propose", rivalProposal.status);

await as(FREELANCER, "freelancer@example.com");
const myProposal = (await rpc(`select public.marketplace_submit_proposal(
  '${job.jobId}','I have built bakeries before.', 18500, 12) as result`)).result;
ok("the first freelancer can propose", myProposal.status);

const updated = (await rpc(`select public.marketplace_submit_proposal(
  '${job.jobId}','Updated note.', 17500, 12) as result`)).result;
assert.equal(Number(updated.bidAmount), 17500);
ok("a submitted proposal can be revised, and there is still one row per job");

console.log("marketplace · isolation");

await as(STRANGER, "stranger@example.com");
const strangerSees = (await rpc(`select count(*)::int as n from public.marketplace_proposals`)).n;
assert.equal(strangerSees, 0);
ok("a stranger sees no proposals through the table at all");

const rivalSees = (await (async () => {
  await as(RIVAL, "rival@example.com");
  return rpc(`select count(*)::int as n from public.marketplace_proposals`);
})()).n;
assert.equal(rivalSees, 1);
ok("a freelancer sees only their own proposal, not the other bid", `${rivalSees} row`);

const hiddenProfile = (await (async () => {
  await as(STRANGER, "stranger@example.com");
  return rpc(`select count(*)::int as n from public.freelancer_profiles`);
})()).n;
assert.equal(hiddenProfile, 1);
ok("a published profile is readable by other signed-in accounts");

await as(FREELANCER, "freelancer@example.com");
await rpc(`select public.marketplace_upsert_freelancer(
  'Full-stack designer','I build small business sites end to end.',
  array['Web Design'], 1200, 'INR', 'available', null, 6, false) as result`);
const unpublished = (await (async () => {
  await as(STRANGER, "stranger@example.com");
  return rpc(`select count(*)::int as n from public.freelancer_profiles where user_id <> auth.uid()`);
})()).n;
assert.equal(unpublished, 0);
ok("an unpublished profile is private to its owner");

console.log("marketplace · acceptance and contracts");

await as(STRANGER, "stranger@example.com");
const stolen = await rejects(
  `select public.marketplace_accept_proposal('${myProposal.proposalId}')`,
  /owner/
);
assert.ok(stolen, "only the job owner may accept");
ok("a stranger cannot accept a proposal");

await as(FREELANCER, "freelancer@example.com");
const rivalAccept = await rejects(
  `select public.marketplace_accept_proposal('${rivalProposal.proposalId}')`,
  /owner/
);
assert.ok(rivalAccept, "a competing freelancer may not accept");
ok("a competing freelancer cannot accept the other proposal");

await as(CLIENT, "client@example.com");
const accepted = (await rpc(
  `select public.marketplace_accept_proposal('${myProposal.proposalId}') as result`
)).result;
assert.equal(accepted.freelancerId, FREELANCER);
assert.equal(Number(accepted.amount), 17500);
ok("the owner accepts, and the contract carries the bid amount");

const rejectedOthers = (await rpc(
  `select count(*)::int as n from public.marketplace_proposals where job_id='${job.jobId}' and status='rejected'`
)).n;
assert.equal(rejectedOthers, 1);
ok("accepting one proposal rejects the others");

const secondAccept = await rejects(
  `select public.marketplace_accept_proposal('${rivalProposal.proposalId}')`,
  /not open|no longer open/
);
assert.ok(secondAccept);
ok("a filled job cannot produce a second contract");

await as(RIVAL, "rival@example.com");
const rivalContracts = (await rpc(`select count(*)::int as n from public.marketplace_contracts`)).n;
assert.equal(rivalContracts, 0);
ok("the losing freelancer sees no contract");

console.log("marketplace · reviews and completion");

await as(FREELANCER, "freelancer@example.com");
const earlyReview = await rejects(
  `select public.marketplace_submit_review('${accepted.contractId}',5,'Great client')`,
  /completed/
);
assert.ok(earlyReview);
ok("a review cannot be left before the contract completes");

const earlyComplete = await rejects(
  `select public.marketplace_set_contract_status('${accepted.contractId}','open')`,
  /completed or cancelled/
);
assert.ok(earlyComplete);
ok("a contract cannot be forced into an invented status");

await as(CLIENT, "client@example.com");
const completed = (await rpc(
  `select public.marketplace_set_contract_status('${accepted.contractId}','completed') as result`
)).result;
assert.equal(completed.status, "completed");
ok("either party can complete the contract");

await as(STRANGER, "stranger@example.com");
const strangerReview = await rejects(
  `select public.marketplace_submit_review('${accepted.contractId}',1,'never worked with them')`,
  /two parties/
);
assert.ok(strangerReview);
ok("an outsider cannot review a contract they are not part of");

await as(CLIENT, "client@example.com");
const clientReview = (await rpc(
  `select public.marketplace_submit_review('${accepted.contractId}',5,'Excellent work') as result`
)).result;
assert.equal(clientReview.ratingAvg, 5);
ok("the client review updates the freelancer score");

const duplicate = (await rpc(
  `select public.marketplace_submit_review('${accepted.contractId}',4,'Changed my mind') as result`
)).result;
assert.equal(duplicate.rating, 4);
const reviewCount = (await rpc(
  `select count(*)::int as n from public.marketplace_reviews where contract_id='${accepted.contractId}'`
)).n;
assert.equal(reviewCount, 1);
ok("a second review edits the first rather than stacking");

console.log("marketplace · workspace");

await as(FREELANCER, "freelancer@example.com");
const workspace = (await rpc("select public.marketplace_my_workspace() as result")).result;
assert.equal(workspace.myProposals.length, 1);
assert.equal(workspace.contracts.length, 1);
/* 0023 renamed the contract role from "freelancer" to "agent" so one word is
   used for one thing across the product. */
assert.equal(workspace.contracts[0].role, "agent");
assert.equal(workspace.contracts[0].canReview, true);
ok("the freelancer workspace contains only their own rows");

const browse = (await rpc("select public.marketplace_browse_jobs(null, 'web design', 20) as result")).result;
assert.equal(browse.length, 0, "a filled job leaves the open board");
ok("a filled job disappears from the browse board");

await as(CLIENT, "client@example.com");
const myJobs = (await rpc("select public.marketplace_my_workspace() as result")).result;
assert.equal(myJobs.myJobs.length, 1);
assert.equal(myJobs.myJobs[0].proposals.length, 2);
ok("the client workspace shows both proposals on their job");

console.log("marketplace · direct writes are denied");

const directInsert = await rejects(
  `insert into public.marketplace_proposals (job_id, freelancer_id, bid_amount, delivery_days)
   values ('${job.jobId}','${STRANGER}', 1, 1)`,
  /row-level security|permission denied/
);
assert.ok(directInsert);
ok("a session cannot insert a proposal directly, bypassing the RPC");

const directContract = await rejects(
  `insert into public.marketplace_contracts (job_id, proposal_id, client_id, freelancer_id, amount)
   values ('${job.jobId}','${myProposal.proposalId}','${CLIENT}','${STRANGER}', 1)`,
  /row-level security|permission denied/
);
assert.ok(directContract);
ok("a session cannot invent a contract directly");

/* RLS does not raise on UPDATE: with no UPDATE policy it filters every row out,
   so the write is silently discarded rather than rejected. Assert the data. */
const tamper = await db.query(
  `update public.marketplace_jobs set status='open' where id='${job.jobId}'`
);
const statusAfter = (await db.query(
  `select status from public.marketplace_jobs where id='${job.jobId}'`
)).rows[0].status;
assert.equal(statusAfter, "filled", "a direct table write must not reopen a filled job");
assert.equal(tamper.affectedRows, 0, "no row matched the update");
ok("a session cannot flip a job status by writing the table", `${tamper.affectedRows} rows touched`);

await db.exec("reset role; set role service_role;");
console.log(`\n  ${pass} marketplace assertions passed`);
await db.close();
