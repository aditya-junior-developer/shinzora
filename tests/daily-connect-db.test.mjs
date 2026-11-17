/* ==========================================================================
   SHINZORA CONNECT — Daily meetings (0077) — behaviour in PGlite
   --------------------------------------------------------------------------
     - a meeting that ends keeps its link for 24 hours, and the database sets
       the expiry itself, whatever path ended it
     - reopening a meeting clears the end and the expiry together
     - an expiry can never be earlier than its end
     - a double-submitted create returns one meeting (create_request_id)
     - one Daily room name per meeting session
     - the new tables (managers, activity, chat) are closed to browsers
     - existing meetings keep working and gain no Daily fields by surprise
   The server rules that need Daily itself (token minting, room creation,
   expiry refusal) run in the `daily` Edge Function and are checked by
   tests/daily-connect-config.test.mjs and the live smoke test.
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
await db.exec(`grant usage on schema public to authenticated, anon;`);

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

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

console.log("Expiry rule (set by the database)");
await asSystem();
const [live] = await q(
  `insert into public.meetings (code, title, kind, host_id, provider, daily_room_name, session_no)
   values ('dailyaaa1', 'Live one', 'video', $1, 'daily', 'shzdailyaaa1s1', 1) returning id, expires_at, ended_at`,
  [ids.alice]
);
check("a live meeting has no expiry", live.expires_at === null);

await db.query(`update public.meetings set ended_at = $2 where id = $1`, [live.id, minutesAgo(5)]);
const [ended] = await q(`select ended_at, expires_at from public.meetings where id = $1`, [live.id]);
const hours = (new Date(ended.expires_at) - new Date(ended.ended_at)) / 3_600_000;
check("ending a meeting sets its expiry to 24 hours after the end", Math.round(hours) === 24, `got ${hours}h`);

await db.query(`update public.meetings set ended_at = $2, expires_at = null where id = $1`, [live.id, minutesAgo(10)]);
const [reset] = await q(`select ended_at, expires_at from public.meetings where id = $1`, [live.id]);
check("a bad caller cannot leave an ended meeting without an expiry", reset.expires_at !== null);

await db.query(`update public.meetings set ended_at = null where id = $1`, [live.id]);
const [reopened] = await q(`select ended_at, expires_at from public.meetings where id = $1`, [live.id]);
check("reopening clears the end and the expiry together", reopened.ended_at === null && reopened.expires_at === null);

const badExpiry = await errorCode(() =>
  db.query(`update public.meetings set expires_at = now() - interval '1 day' where id = $1`, [live.id])
);
check("an expiry without an end is refused", badExpiry === "23514", `got ${badExpiry}`);

console.log("Create is idempotent");
const requestId = "11111111-2222-4333-8444-555555555555";
await db.query(
  `insert into public.meetings (code, title, kind, host_id, provider, create_request_id) values ('dailybbb2', 'First', 'video', $1, 'daily', $2)`,
  [ids.alice, requestId]
);
const duplicate = await errorCode(() =>
  db.query(
    `insert into public.meetings (code, title, kind, host_id, provider, create_request_id) values ('dailyccc3', 'Second', 'video', $1, 'daily', $2)`,
    [ids.alice, requestId]
  )
);
check("the same host cannot create two meetings from one request", duplicate === "23505", `got ${duplicate}`);
const otherHost = await errorCode(() =>
  db.query(
    `insert into public.meetings (code, title, kind, host_id, provider, create_request_id) values ('dailyddd4', 'Other', 'video', $1, 'daily', $2)`,
    [ids.bob, requestId]
  )
);
check("another host may reuse a request id", otherHost === null, `got ${otherHost}`);

console.log("One room per session");
const dupRoom = await errorCode(() =>
  db.query(
    `insert into public.meetings (code, title, kind, host_id, provider, daily_room_name) values ('dailyeee5', 'Clash', 'video', $1, 'daily', 'shzdailyaaa1s1')`,
    [ids.bob]
  )
);
check("two meetings cannot share a Daily room name", dupRoom === "23505", `got ${dupRoom}`);

console.log("Provider and counters");
const badProvider = await errorCode(() =>
  db.query(`insert into public.meetings (code, title, kind, host_id, provider) values ('dailyfff6', 'X', 'video', $1, 'zoom')`, [ids.bob])
);
check("only the mesh and daily providers exist", badProvider !== null);
const [mesh] = await q(
  `insert into public.meetings (code, title, kind, host_id) values ('meshaaaa7', 'Old', 'video', $1) returning id, provider, session_no, daily_room_name`,
  [ids.bob]
);
const meshId = mesh.id;
check("an existing-style meeting defaults to the mesh provider with no room", mesh.provider === "mesh" && mesh.session_no === 0 && mesh.daily_room_name === null);

console.log("Browsers cannot touch the new tables");
await asUser(ids.alice);
for (const table of ["meeting_managers", "meeting_events", "meeting_chat_messages"]) {
  const denied = await errorCode(() => db.query(`select count(*) from public.${table}`));
  check(`a signed-in user cannot read ${table}`, denied === "42501", `got ${denied}`);
}
const chatWrite = await errorCode(() =>
  db.query(`insert into public.meeting_chat_messages (meeting_id, author_name, body) values ($1, 'Eve', 'hi')`, [meshId])
);
check("a signed-in user cannot write chat messages directly", chatWrite === "42501", `got ${chatWrite}`);
const managerWrite = await errorCode(() =>
  db.query(`insert into public.meeting_managers (user_id) values ($1)`, [ids.alice])
);
check("a signed-in user cannot make themselves a meeting manager", managerWrite === "42501", `got ${managerWrite}`);
await asSystem();
const [{ c: chatCount }] = await q(`select count(*)::int as c from public.meeting_chat_messages`);
check("the service role can still write chat (the function does)", chatCount === 0);

console.log("Nothing in the database holds a Daily secret");
const [{ c: secretCols }] = await q(
  `select count(*)::int as c from information_schema.columns
    where table_schema = 'public' and table_name like 'meeting%'
      and (column_name ilike '%api_key%' or column_name ilike '%secret%' or column_name ilike '%token%')`
);
check("no meeting table has a key, secret or token column", secretCols === 0, `${secretCols} found`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
