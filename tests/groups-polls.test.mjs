/* ==========================================================================
   Polls and the wider attachment rules — checked in a real database
   --------------------------------------------------------------------------
   The composer offers four kinds of attachment now. Two of them are new rules
   the server has to hold:

     1. video, audio and documents are accepted, and anything else is still
        refused — the list lives in one function so the picker and the server
        cannot drift
     2. a poll is a message with a poll attached: it lands in the thread, only
        members can see or vote on it, one vote per person per option, and a
        single-choice poll replaces rather than accumulates
     3. a poll cannot be forged into a group it does not belong to
   ========================================================================== */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCAFFOLD, migrationFiles, apply } from "../scripts/staging-db.mjs";

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try {
    const out = await fn();
    pass += 1;
    console.log(`  ✓ ${name}${out ? `  (${out})` : ""}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${String(error.message || error).split("\n")[0]}`);
  }
};

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) await apply(db, file);

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

await db.exec(`
  insert into auth.users (id, email) values
    ('${A}','poll.owner@example.test'),
    ('${B}','poll.member@example.test'),
    ('${OUTSIDER}','poll.outsider@example.test');
  update public.profiles set full_name = 'Poll Owner', username = 'poll_owner' where id = '${A}';
  update public.profiles set full_name = 'Poll Member', username = 'poll_member' where id = '${B}';
  update public.profiles set full_name = 'Outsider', username = 'poll_outsider' where id = '${OUTSIDER}';
  grant usage on schema public to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
`);

let acting = null;
const setUser = async (id) => {
  acting = id;
  return db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.role','authenticated',false);`
  );
};
const one = async (sql) => (await db.query(sql)).rows[0];
const rpc = async (sql) => {
  const row = await one(sql);
  return row ? Object.values(row)[0] : null;
};
const rejects = async (sql, pattern) => {
  try {
    await db.query(sql);
  } catch (error) {
    if (pattern && !pattern.test(error.message)) throw new Error(`refused, but for the wrong reason: ${error.message}`);
    return error.message;
  }
  throw new Error("the call was allowed when it should have been refused");
};

await setUser(A);
const G = (await rpc(`select public.group_create('poll-group', 'Poll Group', null) as x`)).id;
const G2 = (await rpc(`select public.group_create('poll-other', 'Poll Other', null) as x`)).id;
await rpc(`select public.group_add_member('${G}', '${B}') as x`);

/* --------------------------------------------------- 1. what may be attached */

await check("video, audio and documents are now allowed", async () => {
  const { rows } = await db.query(`
    select public.attachment_mime_ok('video/mp4') as mp4,
           public.attachment_mime_ok('video/webm') as webm,
           public.attachment_mime_ok('audio/mpeg') as mp3,
           public.attachment_mime_ok('audio/ogg') as ogg,
           public.attachment_mime_ok('application/pdf') as pdf,
           public.attachment_mime_ok('text/csv') as csv,
           public.attachment_mime_ok('image/png') as png
  `);
  for (const [key, ok] of Object.entries(rows[0])) assert.equal(ok, true, `${key} should be allowed`);
});

await check("an executable or a script is still refused", async () => {
  const { rows } = await db.query(`
    select public.attachment_mime_ok('application/x-msdownload') as exe,
           public.attachment_mime_ok('text/html') as html,
           public.attachment_mime_ok('image/svg+xml') as svg,
           public.attachment_mime_ok('') as empty
  `);
  for (const [key, ok] of Object.entries(rows[0])) assert.equal(ok, false, `${key} must stay refused`);
});

await check("group_send refuses an HTML file at the database, not just in the picker", async () => {
  await setUser(A);
  return rejects(
    `select public.group_send('${G}', null, '[{"path":"${G}/${A}/x.html","name":"x.html","mime":"text/html","size":10}]'::jsonb)`,
    /file type cannot be attached/i
  );
});

await check("the bucket lists the same types the function allows", async () => {
  /* Read as the database owner: the signed-in member has no rights on the
     storage schema, which is itself the point — the bucket rules are applied by
     the storage API, not by the member. */
  await db.exec("reset role;");
  const row = await one(`select allowed_mime_types, file_size_limit from storage.buckets where id = 'group-chat-files'`);
  await setUser(A);
  const types = row.allowed_mime_types;
  assert.ok(types.includes("video/mp4"), "video is in the bucket list");
  assert.ok(types.includes("audio/mpeg"), "audio is in the bucket list");
  assert.equal(types.includes("text/html"), false, "html is not");
  assert.equal(Number(row.file_size_limit), 52428800, "and the size limit matches the function");
});

/* --------------------------------------------------------- 2. making a poll */

await setUser(A);
const created = await rpc(
  `select public.group_poll_create('${G}', 'Where should we meet?', '["Office","Cafe","Call"]'::jsonb, false) as x`
);
const POLL = created.poll.id;

await check("a poll lands in the thread as a message", async () => {
  assert.ok(created.message.id, "a message was created");
  const msg = (await db.query(`select body, attachments from public.community_messages where id = '${created.message.id}'`)).rows[0];
  assert.equal(msg.body, "Where should we meet?");
  assert.equal(msg.attachments[0].kind, "poll");
  assert.equal(msg.attachments[0].pollId, POLL);
  return `message ${created.message.id} carries poll ${POLL}`;
});

await check("the poll starts empty with every option at zero", async () => {
  const payload = await rpc(`select public.group_poll_get('${POLL}') as x`);
  assert.deepEqual(payload.options.map((o) => o.count), [0, 0, 0]);
  assert.deepEqual(payload.mine, []);
  assert.equal(payload.totalVoters, 0);
});

await check("fewer than two options is refused", async () => {
  await setUser(A);
  return rejects(`select public.group_poll_create('${G}', 'Only one?', '["Yes"]'::jsonb, false)`, /at least two options/i);
});

await check("blank options are dropped, not fatal", async () => {
  const made = await rpc(`select public.group_poll_create('${G}', 'Lunch?', '["Pizza", "  ", "Sushi"]'::jsonb, false) as x`);
  assert.equal(made.poll.options.length, 2, "the blank line went away");
  return "two real options";
});

/* ------------------------------------------------------------- 3. voting */

await check("a member votes and the tally follows", async () => {
  await setUser(B);
  const after = await rpc(`select public.group_poll_vote('${POLL}', 1, true) as x`);
  assert.equal(after.options[1].count, 1);
  assert.deepEqual(after.mine, [1]);
  assert.equal(after.totalVoters, 1);
});

await check("voting again for the same option does not double count", async () => {
  await setUser(B);
  const after = await rpc(`select public.group_poll_vote('${POLL}', 1, true) as x`);
  assert.equal(after.options[1].count, 1, "still one vote");
});

await check("a single-choice poll replaces the previous vote", async () => {
  await setUser(B);
  const after = await rpc(`select public.group_poll_vote('${POLL}', 2, true) as x`);
  assert.deepEqual(after.options.map((o) => o.count), [0, 0, 1]);
  assert.deepEqual(after.mine.sort(), [2]);
});

await check("a vote can be taken back", async () => {
  await setUser(B);
  const after = await rpc(`select public.group_poll_vote('${POLL}', 2, false) as x`);
  assert.equal(after.totalVoters, 0);
  assert.deepEqual(after.mine, []);
});

await check("an outsider can neither see nor vote on a poll", async () => {
  await setUser(OUTSIDER);
  await rejects(`select public.group_poll_get('${POLL}')`, /not a member/i);
  await rejects(`select public.group_poll_vote('${POLL}', 0, true)`, /not a member/i);
  return "refused on both";
});

await check("an option that is not in the poll is refused", async () => {
  await setUser(B);
  return rejects(`select public.group_poll_vote('${POLL}', 9, true)`, /not in this poll/i);
});

await check("two members see the same tally", async () => {
  await setUser(A);
  await rpc(`select public.group_poll_vote('${POLL}', 0, true) as x`);
  await setUser(B);
  await rpc(`select public.group_poll_vote('${POLL}', 0, true) as x`);
  const seen = await rpc(`select public.group_poll_get('${POLL}') as x`);
  assert.equal(seen.options[0].count, 2);
  assert.equal(seen.totalVoters, 2);
  return "2 votes for Office";
});

/* --------------------------------------------------- 4. a forged poll is refused */

await check("a poll from another group cannot be attached to this one", async () => {
  await setUser(A);
  const foreign = await rpc(`select public.group_poll_create('${G2}', 'Not yours', '["a","b"]'::jsonb, false) as x`);
  return rejects(
    `select public.group_send('${G}', 'look', jsonb_build_array(jsonb_build_object(
       'kind','poll','mime','application/x-shinzora-poll','pollId','${foreign.poll.id}',
       'path','poll:${foreign.poll.id}','name','x','size',1)))`,
    /not in this group/i
  );
});

await check("a poll is not a file: it cannot be signed out of storage", async () => {
  const row = await one(`select attachments from public.community_messages where attachments->0->>'pollId' = '${POLL}'`);
  assert.equal(row.attachments[0].path, `poll:${POLL}`, "the path is a marker, not an object key");
  return "path is poll:<id>";
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
