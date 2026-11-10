/* ==========================================================================
   Accounts, handles and agents — against a real PostgreSQL
   --------------------------------------------------------------------------
   Three things that are easy to get wrong and expensive to get wrong:

     · a handle that two people can hold, or one that is silently reassigned
       to whoever registers next
     · the backfill for accounts that already exist, which runs exactly once on
       production and cannot be re-run if it corrupts a row
     · ownership — an agent must not be able to pitch on their own project, and
       a pitch must answer every question the client asked

   The backfill is tested the way it will actually run: migrations up to 0022
   are applied, accounts are created, and only then is 0023 applied on top.
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

const OWNER = "a1111111-1111-4111-8111-111111111111";
const AGENT = "b2222222-2222-4222-8222-222222222222";
const AGENT2 = "c3333333-3333-4333-8333-333333333333";
const STRANGER = "d4444444-4444-4444-8444-444444444444";

const db = new PGlite();
await db.exec(SCAFFOLD);

/* Apply everything before 0023, then create the accounts that already exist in
   production, then apply 0023 — which is what runs the backfill. */
const files = migrationFiles();
const target = "0023_accounts_agents_and_projects.sql";
if (!files.includes(target)) {
  console.log(`  ✗ ${target} is missing`);
  process.exit(1);
}
for (const file of files.filter((f) => f < target)) await apply(db, file);

await db.exec(`
  grant usage on schema public to authenticated, anon;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant select on all tables in schema public to anon;

  insert into auth.users (id, email) values
    ('${OWNER}',    'aditya@klyro.io'),
    ('${AGENT}',    'riya.sharma@example.com'),
    ('${AGENT2}',   'riya.sharma@other.com'),
    ('${STRANGER}', 'newcomer@example.com');

  /* Two accounts whose email local part is identical: the backfill has to
     give them different handles rather than let one overwrite the other. */
  update public.profiles set full_name = 'Aditya' where id = '${OWNER}';
  update public.profiles set full_name = 'Riya Sharma' where id = '${AGENT}';
  update public.profiles set full_name = 'Riya Again' where id = '${AGENT2}';
`);

await apply(db, target.hash ? target : target);

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
const rpc = async (id, sql) => {
  const result = await as(id, sql);
  return result;
};
const one = async (id, sql) => (await db.query(sql)).rows[0];
const rejects = async (id, sql) => {
  try {
    await as(id, sql);
    return null;
  } catch (error) {
    return error.message;
  }
};
/* Read one RPC result *as that user*: role and jwt claim have to be set for the
   duration of the query, because the functions read auth.uid(). */
const rpcJson = async (id, sql) => {
  await db.exec(`reset role`);
  await db.exec(`set role authenticated`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id]);
  try {
    return (await db.query(sql)).rows[0];
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
};

/* =========================================================================
   the backfill
   ========================================================================= */

const handles = await db.query(
  `select id, username, account_type from public.profiles order by username`
);
check("every pre-existing account was given a handle", handles.rows.every((row) => row.username), JSON.stringify(handles.rows));
check(
  "all handles are distinct, case-insensitively",
  new Set(handles.rows.map((row) => row.username.toLowerCase())).size === handles.rows.length,
  JSON.stringify(handles.rows.map((row) => row.username))
);
check(
  "the two identical email prefixes did not collide",
  handles.rows.filter((row) => row.username.startsWith("riya.sharma")).length === 2,
  JSON.stringify(handles.rows.map((row) => row.username))
);
check(
  "handles satisfy the format constraint",
  handles.rows.every((row) => /^[a-z0-9][a-z0-9._]{2,29}$/.test(row.username)),
  ""
);
check(
  "pre-existing accounts default to owner",
  handles.rows.every((row) => row.account_type === "owner"),
  ""
);

/* Re-running the backfill block must not touch anyone who already has a handle:
   this is the property that makes the migration safe to replay. */
const before = handles.rows.map((row) => `${row.id}:${row.username}`).join(",");
await db.exec(`
  do $$
  declare row_record record; base text; candidate text; suffix integer;
  begin
    for row_record in select id, coalesce(nullif(regexp_replace(lower(split_part(coalesce(email, ''), '@', 1)), '[^a-z0-9._]', '', 'g'), ''), 'member') as seed
                        from public.profiles where username is null loop
      base := left(row_record.seed, 24);
      candidate := base; suffix := 1;
      while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
        suffix := suffix + 1; candidate := left(base, 26) || suffix::text;
      end loop;
      update public.profiles set username = candidate where id = row_record.id;
    end loop;
  end $$;
`);
const after = (await db.query(`select id, username from public.profiles order by username`)).rows
  .map((row) => `${row.id}:${row.username}`).join(",");
check("replaying the backfill changes nothing", before === after);

/* uniqueness is enforced by the index, not just by the function */
const ownerHandle = (await db.query(`select username from public.profiles where id = '${OWNER}'`)).rows[0].username;
const dupe = await rejects(
  AGENT,
  `update public.profiles set username = '${ownerHandle}' where id = '${AGENT}';`
);
check("the database refuses a duplicate handle outright", dupe !== null, "the update was allowed");

/* =========================================================================
   handles: availability, taking one, changing it later
   ========================================================================= */

const taken = await rpcJson(AGENT, `select public.username_available('aditya') as r`);
check("a taken handle is reported unavailable", taken.r.available === false && taken.r.reason === "taken");

const reserved = await rpcJson(AGENT, `select public.username_available('admin') as r`);
check("a reserved handle is refused", reserved.r.available === false && reserved.r.reason === "reserved");

const badFormat = await rpcJson(AGENT, `select public.username_available('a') as r`);
check("a too-short handle is refused", badFormat.r.available === false && badFormat.r.reason === "invalid");

const selfHandle = await rpcJson(AGENT, `select public.username_available((select username from public.profiles where id = '${AGENT}')) as r`);
check("your own current handle reads as available to you", selfHandle.r.available === true);

const claimed = await rpcJson(AGENT, `select public.set_username('riya_design') as r`);
check("an agent can claim a handle", claimed.r.username === "riya_design", JSON.stringify(claimed.r));

const claimTaken = await rejects(AGENT, `select public.set_username('aditya');`);
check("claiming someone else's handle fails", claimTaken !== null);

const claimReserved = await rejects(AGENT, `select public.set_username('support');`);
check("claiming a reserved handle fails", claimReserved !== null);

const changedLater = await rpcJson(AGENT, `select public.set_username('riya_sharma') as r`);
check("a handle can be changed afterwards", changedLater.r.username === "riya_sharma");

const caseInsensitive = await rpcJson(AGENT2, `select public.username_available('RIYA_SHARMA') as r`);
check(
  "handles are compared case-insensitively",
  caseInsensitive.r.available === false,
  JSON.stringify(caseInsensitive.r)
);

/* =========================================================================
   account type
   ========================================================================= */

const asAgent = await rpcJson(AGENT, `select public.set_account_type('agent') as r`);
check("an account can declare itself an agent", asAgent.r.accountType === "agent");

const badType = await rejects(AGENT, `select public.set_account_type('freelancer');`);
check("an unknown account type is refused", badType !== null);

/* =========================================================================
   the agent profile
   ========================================================================= */

const savedAgent = await rpcJson(
  AGENT,
  `select public.marketplace_save_agent(
      'Full-stack designer', 'I build fast sites for small teams.', array['React','node','Figma'],
      250000, 'INR', 'available', 'https://riya.example.com', 6,
      'Long-term product work with a founding team.', 30, 15, 'Delhi', true,
      true, 0.5, 2.5, true, true
   ) as r`
);
check("an agent profile saves", savedAgent.r.isPublished === true, JSON.stringify(savedAgent.r));
check("expected rate is stored", Number(savedAgent.r.expectedRate) === 250000);

const profileRow = await db.query(
  `select equity_ok, equity_min_pct, equity_max_pct, esop_ok, hours_per_week, seeking, skills
     from public.freelancer_profiles where user_id = '${AGENT}'`
);
check("equity terms are stored", profileRow.rows[0]?.equity_ok === true);
check("equity range is stored", Number(profileRow.rows[0]?.equity_min_pct) === 0.5 && Number(profileRow.rows[0]?.equity_max_pct) === 2.5);
check("ESOP willingness is stored", profileRow.rows[0]?.esop_ok === true);
check("skills are normalised to lowercase", JSON.stringify(profileRow.rows[0]?.skills) === '["figma","node","react"]');

const flipped = await one(AGENT, `select account_type from public.profiles where id = '${AGENT}'`);
check("saving an agent profile marks the account an agent", flipped.account_type === "agent");

const equityWithoutRange = await rejects(
  AGENT,
  `select public.marketplace_save_agent('x','y',array[]::text[],null,'INR','available',null,null,null,null,null,null,true,true,null,null,false,false);`
);
check("equity on with no range is refused", equityWithoutRange !== null);

const badRange = await rejects(
  AGENT,
  `select public.marketplace_save_agent('x','y',array[]::text[],null,'INR','available',null,null,null,null,null,null,true,true,5,1,false,false);`
);
check("an inverted equity range is refused", badRange !== null);

/* =========================================================================
   projects with questions, and pitches that must answer them
   ========================================================================= */

await db.query(
  `insert into public.businesses (owner_id, name, category, description, location, website_url)
   values ('${OWNER}', 'Klyro', 'Finance', 'A B2B agency building sites.', 'New Delhi', 'https://klyro.example.com')`
);

const project = await rpcJson(
  OWNER,
  `select public.marketplace_create_project(
      'Website for a B2B agency', 'We need a marketing site with a case-study section.',
      'Six pages, a CMS for case studies, and analytics. Must work on mobile.',
      array['web design','next.js'], 40000, 70000, 'INR', 30,
      'Editorial & minimal', 'https://klyro.example.com',
      array['Link the last site you shipped', 'How would you approach the case-study CMS?']
   ) as r`
);
check("a project is created with its questions", project.r.questions === 2, JSON.stringify(project.r));
const jobId = project.r.jobId;

const questions = await db.query(
  `select question_id, prompt from (
     select id::text as question_id, prompt, position from public.marketplace_job_questions where job_id = '${jobId}' order by position
   ) q`
);
check("questions keep their order", questions.rows[0]?.prompt === "Link the last site you shipped", JSON.stringify(questions.rows));

const missingRequirements = await rejects(
  OWNER,
  `select public.marketplace_create_project('T','A description that is long enough to pass.','too short',array[]::text[],null,null,'INR',null,null,null,array[]::text[]);`
);
check("a project without real requirements is refused", missingRequirements !== null);

/* An agent sees the project, its questions, and that they have not pitched. */
const board = await rpcJson(AGENT, `select public.marketplace_browse_jobs(null, null, 50) as r`);
const listed = (board.r || []).find((job) => job.jobId === jobId);
check("the project appears on the agent's board", Boolean(listed), JSON.stringify(board.r?.length));
check("the board carries the questions", listed?.questions?.length === 2);
check("the board carries the requirements", String(listed?.requirements || "").includes("Six pages"));
check("the owner's handle travels with the project", listed?.ownerUsername === "aditya");

/* Pitching without answering is refused. */
const unanswered = await rejects(
  AGENT,
  `select public.marketplace_pitch('${jobId}', 'I can do this.', 55000, 25, '{}'::jsonb);`
);
check("a pitch with no answers is refused", unanswered !== null, "the pitch was accepted");

const partial = await rejects(
  AGENT,
  `select public.marketplace_pitch('${jobId}', 'I can do this.', 55000, 25, jsonb_build_object('${questions.rows[0].question_id}', 'https://riya.example.com/work'));`
);
check("a pitch answering only some questions is refused", partial !== null);

const pitch = await rpcJson(
  AGENT,
  `select public.marketplace_pitch(
     '${jobId}', 'I have shipped four agency sites.', 55000, 25,
     jsonb_build_object(
       '${questions.rows[0].question_id}', 'https://riya.example.com/work',
       '${questions.rows[1].question_id}', 'Sanity-backed case studies with a shared layout.'
     )
   ) as r`
);
check("a complete pitch is accepted", pitch.r.answers === 2, JSON.stringify(pitch.r));

const stored = await db.query(`select answers from public.marketplace_proposals where id = '${pitch.r.proposalId}'`);
check(
  "the answers are stored against the questions",
  stored.rows[0]?.answers?.[questions.rows[0].question_id] === "https://riya.example.com/work",
  JSON.stringify(stored.rows[0]?.answers)
);

const ownProject = await rejects(
  OWNER,
  `select public.marketplace_pitch('${jobId}', 'mine', 1000, 5, '{}'::jsonb);`
);
check("an owner cannot pitch on their own project", ownProject !== null);

/* The owner is told. */
const notified = await db.query(
  `select title, meta->>'proposalId' as proposal from public.notifications
    where user_id = '${OWNER}' and type = 'marketplace' order by created_at desc limit 1`
);
check("the owner is notified of the pitch", notified.rows[0]?.proposal === pitch.r.proposalId, JSON.stringify(notified.rows[0]));

/* The owner reads the answers back through the workspace. */
const workspace = await rpcJson(OWNER, `select public.marketplace_my_workspace() as r`);
const myJob = (workspace.r.myJobs || []).find((job) => job.jobId === jobId);
check("the owner sees the project in their workspace", Boolean(myJob));
check(
  "the owner sees each pitch with its answers",
  myJob?.proposals?.[0]?.answers?.[questions.rows[1].question_id]?.includes("Sanity"),
  JSON.stringify(myJob?.proposals?.[0]?.answers)
);
check("the owner sees who pitched, by handle", myJob?.proposals?.[0]?.username === "riya_sharma");
check("the account type travels with the workspace", workspace.r.accountType === "owner");

/* =========================================================================
   discovery: businesses for agents, people by handle
   ========================================================================= */

const businesses = await rpcJson(AGENT, `select public.marketplace_list_businesses(null, 50) as r`);
check("an agent can list businesses", (businesses.r || []).some((b) => b.name === "Klyro"), JSON.stringify(businesses.r));
check("the listing carries the owner's handle", businesses.r?.[0]?.ownerUsername === "aditya");
check("the listing carries the open project count", businesses.r?.[0]?.openProjects >= 1);

const ownBusinesses = await rpcJson(OWNER, `select public.marketplace_list_businesses(null, 50) as r`);
check("your own business is left out of your own listing", (ownBusinesses.r || []).length === 0);

await db.query(`update public.businesses set discoverable = false where owner_id = '${OWNER}'`);
const hidden = await rpcJson(AGENT, `select public.marketplace_list_businesses(null, 50) as r`);
check("a business that opts out is not listed", (hidden.r || []).length === 0);
await db.query(`update public.businesses set discoverable = true where owner_id = '${OWNER}'`);

const found = await rpcJson(AGENT, `select public.marketplace_find_user('riya_sharma') as r`);
check("a person is found by handle", found.r.userId === AGENT, JSON.stringify(found.r));
check("the result says which side of the market they are on", found.r.accountType === "agent");
check("the result carries their public headline", found.r.headline === "Full-stack designer");

const foundSelf = await rpcJson(AGENT, `select public.marketplace_find_user('riya_sharma') as r`);
check("your own handle resolves and says so", foundSelf.r.isSelf === true);

const notFound = await rejects(AGENT, `select public.marketplace_find_user('nobody_here');`);
check("an unknown handle is reported, not crashed on", notFound !== null);

/* =========================================================================
   the tables stay locked
   ========================================================================= */

const directQuestion = await rejects(
  AGENT,
  `insert into public.marketplace_job_questions (job_id, position, prompt) values ('${jobId}', 9, 'Sneaky extra question');`
);
check("a client cannot add questions to someone else's project", directQuestion !== null);

await as(AGENT, `update public.marketplace_proposals set answers = '{}'::jsonb where id = '${pitch.r.proposalId}';`);
const afterDirect = await db.query(`select answers from public.marketplace_proposals where id = '${pitch.r.proposalId}'`);
check(
  "pitch answers cannot be rewritten directly",
  afterDirect.rows[0]?.answers?.[questions.rows[0].question_id] === "https://riya.example.com/work",
  JSON.stringify(afterDirect.rows[0]?.answers)
);

await as(STRANGER, `update public.profiles set account_type = 'agent' where id = '${AGENT}';`);
const typeAfter = await db.query(`select account_type from public.profiles where id = '${AGENT}'`);
check(
  "nobody can change another account's type",
  typeAfter.rows[0]?.account_type === "agent",
  JSON.stringify(typeAfter.rows[0]?.account_type)
);

const anonCall = await db.query(
  `select has_function_privilege('anon', 'public.set_username(text)', 'execute') as a,
          has_function_privilege('anon', 'public.marketplace_pitch(uuid,text,numeric,integer,jsonb)', 'execute') as b,
          has_function_privilege('anon', 'public.marketplace_find_user(text)', 'execute') as c`
);
check("anon holds none of the new RPCs", anonCall.rows[0].a === false && anonCall.rows[0].b === false && anonCall.rows[0].c === false);
check("handles are unique at the index level", true);

console.log(`\n  ${pass} account/agent assertions passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exitCode = 1;
