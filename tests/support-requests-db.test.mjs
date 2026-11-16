/* ==========================================================================
   Customer Support requests (0076) — behaviour in PGlite
   --------------------------------------------------------------------------
     - a signed-in user can open a chat or a call request, with the rules
       enforced by the database (channel, subject, message, phone number)
     - a call request has no chat thread; a chat request starts with its message
     - a user sees only their own requests, messages and AI history
     - only an administrator can change a status, reply as the team or save the
       response-time note
     - a closed request takes no more replies from the user
     - nobody can write to the tables directly; the browser uses the RPCs
     - the response-time note is empty by default and never invented
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
  bob: "00000000-0000-4000-8000-0000000000b2",
  admin: "00000000-0000-4000-8000-0000000000c3"
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`update public.profiles set full_name = $2 where id = $1`, [uid, name]);
}
await db.query(`insert into public.admin_users (user_id, email, role) values ($1, 'admin@test.local', 'admin')`, [ids.admin]);

await db.exec(`
  grant usage on schema public to authenticated, anon;
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
const asAnon = async () => {
  await db.exec(`
    reset role;
    set role anon;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claim.role','anon',false);
    select set_config('request.jwt.claims','{"role":"anon"}',false);
  `);
};
const asSystem = async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claims','{"role":"service_role"}',false);
  `);
};
const errorCode = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error.code || error.message;
  }
};

/* ---- Creating requests -------------------------------------------------- */

await asSystem();
check("the note is empty by default (no response time is invented)", (await q(`select value from public.support_settings where key='response_time_note'`))[0]?.value === "");

await asUser(ids.alice);
let chat;
{
  const rows = await q(
    `select * from public.support_request_create('chat', 'Cannot publish', 'My site will not publish after I click Publish.')`
  );
  chat = rows[0];
}
check("a chat request is created as received", chat?.status === "received" && chat?.channel === "chat");
check("the chat request belongs to the caller", chat?.user_id === ids.alice);
const openingMsgs = await q(`select author_role, body from public.support_request_messages where request_id = $1`, [chat.id]);
check("a chat request starts with its first message from the user", openingMsgs.length === 1 && openingMsgs[0].author_role === "user");

let call;
{
  const rows = await q(
    `select * from public.support_request_create('call', 'Billing question', 'I need help with my plan.', '+91 98765 43210', 'Weekdays after 6 pm')`
  );
  call = rows[0];
}
check("a call request is created with the phone number and best time", call?.channel === "call" && call?.phone === "+91 98765 43210" && call?.best_time === "Weekdays after 6 pm");
check("a call request has no chat thread", (await q(`select count(*)::int as n from public.support_request_messages where request_id = $1`, [call.id]))[0].n === 0);

check(
  "a call request without a phone number is refused",
  (await errorCode(() => db.query(`select * from public.support_request_create('call','A','B', null, null)`))) === "22023"
);
check(
  "a call request with a letters-only phone number is refused",
  (await errorCode(() => db.query(`select * from public.support_request_create('call','A','B','call me maybe',null)`))) === "22023"
);
check(
  "an unknown channel is refused",
  (await errorCode(() => db.query(`select * from public.support_request_create('email','A','B',null,null)`))) === "22023"
);
check(
  "an empty subject is refused",
  (await errorCode(() => db.query(`select * from public.support_request_create('chat','   ','B',null,null)`))) === "22023"
);
check(
  "a message over 4000 characters is refused",
  (await errorCode(() => db.query(`select * from public.support_request_create('chat','A',$1,null,null)`, ["x".repeat(4001)]))) === "22023"
);

await asAnon();
check(
  "a signed-out visitor cannot open a request",
  (await errorCode(() => db.query(`select * from public.support_request_create('chat','A','B',null,null)`))) === "42501"
);

await asUser(ids.alice);
check(
  "a user cannot insert a request directly into the table",
  (await errorCode(() => db.query(`insert into public.support_requests (user_id, channel, subject, message) values ($1,'chat','x','y')`, [ids.alice]))) === "42501"
);

/* ---- Reading: own rows only --------------------------------------------- */

const aliceSees = (await q(`select id from public.support_requests`)).map((r) => r.id);
check("a user sees their own requests", aliceSees.includes(chat.id) && aliceSees.includes(call.id));
await asUser(ids.bob);
check("another user sees none of Alice's requests", (await q(`select id from public.support_requests`)).length === 0);
check("another user sees none of Alice's messages", (await q(`select id from public.support_request_messages`)).length === 0);
await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${ids.admin}',false); select set_config('request.jwt.claims','{"sub":"${ids.admin}","role":"authenticated"}',false);`);
check("the administrator (through their own session and RLS) sees every request", (await q(`select id from public.support_requests`)).length >= 2);

/* ---- Replies ------------------------------------------------------------- */

await asUser(ids.bob);
check(
  "another user cannot reply to Alice's request",
  (await errorCode(() => db.query(`select * from public.support_request_reply($1,'hello')`, [chat.id]))) === "P0002"
);

await asUser(ids.alice);
const userReply = (await q(`select * from public.support_request_reply($1,'Here is the error message.')`, [chat.id]))[0];
check("the owner's reply is stored as a user message", userReply?.author_role === "user");
check(
  "a call request refuses a chat reply",
  (await errorCode(() => db.query(`select * from public.support_request_reply($1,'hello')`, [call.id]))) === "22023"
);
check(
  "a user cannot change a request's status",
  (await errorCode(() => db.query(`select * from public.support_request_update($1,'resolved',null)`, [chat.id]))) === "42501"
);
check(
  "a user cannot save the response-time note",
  (await errorCode(() => db.query(`select * from public.support_settings_save('We reply fast')`))) === "42501"
);

await asSystem();
// The administrator is the admin_users row, and is_admin() reads it through auth.uid().
await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${ids.admin}',false); select set_config('request.jwt.claims','{"sub":"${ids.admin}","role":"authenticated"}',false);`);
const adminReply = (await q(`select * from public.support_request_reply($1,'Thanks, we are looking into it.')`, [chat.id]))[0];
check("an administrator's reply is stored as a team message", adminReply?.author_role === "admin");
const updated = (await q(`select * from public.support_request_update($1,'in_progress','Checking the publish logs')`, [chat.id]))[0];
check("an administrator can set the status and an internal note", updated?.status === "in_progress" && updated?.admin_note === "Checking the publish logs");
check(
  "an unknown status is refused",
  (await errorCode(() => db.query(`select * from public.support_request_update($1,'banana',null)`, [chat.id]))) === "22023"
);
const saved = (await q(`select * from public.support_settings_save($1)`, ["We usually review requests on working days."]))[0];
check("an administrator can save the response-time note", saved?.value === "We usually review requests on working days.");
check(
  "a note over 300 characters is refused",
  (await errorCode(() => db.query(`select * from public.support_settings_save($1)`, ["x".repeat(301)]))) === "22023"
);
await db.query(`select * from public.support_settings_save('')`);
check("the note can be cleared again (nothing is shown)", (await q(`select value from public.support_settings where key='response_time_note'`))[0].value === "");

await db.query(`select * from public.support_request_update($1,'resolved',null)`, [chat.id]);
await asUser(ids.alice);
check(
  "a resolved request takes no more replies from the user",
  (await errorCode(() => db.query(`select * from public.support_request_reply($1,'still there?')`, [chat.id]))) === "22023"
);
check(
  "a resolved request still shows its status to the owner",
  (await q(`select status from public.support_requests where id = $1`, [chat.id]))[0].status === "resolved"
);

/* ---- Direct writes are closed ------------------------------------------- */

check(
  "a user cannot write a reply directly",
  (await errorCode(() => db.query(`insert into public.support_request_messages (request_id, author_role, body) values ($1,'user','x')`, [call.id]))) === "42501"
);
check(
  "a user cannot write the response-time note directly",
  (await errorCode(() => db.query(`update public.support_settings set value = 'free text' where key = 'response_time_note'`))) === "42501"
);
check(
  "a user cannot write AI history directly",
  (await errorCode(() => db.query(`insert into public.support_ai_messages (user_id, role, body) values ($1,'user','x')`, [ids.alice]))) === "42501"
);
check("a user can read only their own AI history", (await q(`select id from public.support_ai_messages`)).length === 0);

/* ---- Statuses and the defaults ------------------------------------------- */

await asSystem();
const cols = await q(`select column_name from information_schema.columns where table_schema='public' and table_name='support_requests'`);
check("support_requests has no response-time or deadline column", !cols.some((c) => /response|deadline|sla/i.test(c.column_name)));
const statusCheck = await q(`select pg_get_constraintdef(oid) as d from pg_constraint where conrelid='public.support_requests'::regclass and contype='c'`);
check("statuses are received, in_progress, resolved, closed", statusCheck.some((c) => /received/.test(c.d) && /in_progress/.test(c.d) && /resolved/.test(c.d) && /closed/.test(c.d)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
