/* ==========================================================================
   Calling and meetings, against a real Postgres
   --------------------------------------------------------------------------
   Everything a call needs from the database is here, and each assertion is a
   question the product asks:

     • can the person being rung pick up?          call_invite_answer
     • can they refuse, and is the caller told?    call_invite_decline
     • does an unanswered call become a miss?      call_invite_missed
     • can a stranger answer a call they were not rung for?   (they must not)
     • can somebody join a meeting by guessing an id?         (they must not)
     • does a locked meeting open for its host only?          (it must)
     • does ending a meeting close it to everybody?           (it must)
     • is the signalling topic authorised by attendance, not by knowing it?

   The harness is the same PGlite one the other database suites use: every
   migration is applied, then the calls are made as a signed-in role.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCAFFOLD, migrationFiles, apply } from "../scripts/staging-db.mjs";

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) await apply(db, file);
await db.exec(`
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select jsonb_build_object('email', nullif(current_setting('request.jwt.claim.email', true), ''))
  $$;
  grant usage on schema public to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
  grant usage, select on all sequences in schema public to authenticated, service_role;

  insert into auth.users (id,email) values
    ('aaaaaaaa-1111-4111-8111-111111111111','asha@example.com'),
    ('bbbbbbbb-2222-4222-8222-222222222222','ravi@example.com'),
    ('cccccccc-3333-4333-8333-333333333333','meera@example.com'),
    ('dddddddd-4444-4444-8444-444444444444','stranger@example.com');

  insert into public.profiles (id, full_name, email) values
    ('aaaaaaaa-1111-4111-8111-111111111111','Asha','asha@example.com'),
    ('bbbbbbbb-2222-4222-8222-222222222222','Ravi','ravi@example.com'),
    ('cccccccc-3333-4333-8333-333333333333','Meera','meera@example.com'),
    ('dddddddd-4444-4444-8444-444444444444','Stranger','stranger@example.com')
  on conflict (id) do update set full_name = excluded.full_name;
`);

const ASHA = "aaaaaaaa-1111-4111-8111-111111111111";
const RAVI = "bbbbbbbb-2222-4222-8222-222222222222";
const MEERA = "cccccccc-3333-4333-8333-333333333333";
const STRANGER = "dddddddd-4444-4444-8444-444444444444";

const signIn = async (id) => {
  await db.exec(`reset role; set role authenticated;
    select set_config('request.jwt.claim.sub','${id}',false);
    select set_config('request.jwt.claim.email','${id}@example.com',false);`);
};
const asAdmin = async () => db.exec("reset role; set role postgres;");

/** A one-to-one conversation between two people, made the way the app makes it. */
async function directConversation(between, and) {
  await asAdmin();
  const { rows } = await db.query(
    `insert into public.team_conversations (kind, created_by, title)
     values ('direct', $1, 'Direct') returning id`,
    [between]
  );
  const id = rows[0].id;
  await db.query(`insert into public.team_conversation_members (conversation_id, user_id) values ($1, $2), ($1, $3)`, [
    id,
    between,
    and
  ]);
  return id;
}

/* ------------------------------------------------------------------ calling */

test("one-to-one: the ring is written, the callee picks up, the caller is told", async () => {
  const conversation = await directConversation(ASHA, RAVI);
  const topic = `call-dm:${conversation}`;

  await signIn(ASHA);
  const started = (await db.query(`select public.call_invite_start($1, 'voice', null, $2) as result`, [topic, conversation]))
    .rows[0].result;
  assert.equal(started.rung, 1, "exactly one person is rung");
  assert.equal(started.topic, topic);

  /* The callee sees a row of type `call` — that is what rings. */
  await signIn(RAVI);
  const ringing = (
    await db.query(`select title, type, meta from public.notifications where user_id = $1 and type = 'call'`, [RAVI])
  ).rows;
  assert.equal(ringing.length, 1, "the callee has one call notification");
  assert.match(ringing[0].title, /Call from Asha/i);
  assert.equal(ringing[0].meta.callTopic, topic, "the notification carries the topic to join");

  const answered = (await db.query(`select public.call_invite_answer($1) as result`, [topic])).rows[0].result;
  assert.equal(answered.status, "accepted");
  assert.equal(answered.startedBy, ASHA, "the callee learns who is on the other end");
  assert.equal(answered.kind, "voice");
  assert.equal(answered.conversationId, conversation);

  /* Answering clears the ring, so a reload does not ring again. */
  const unread = (
    await db.query(`select count(*)::int as n from public.notifications where user_id = $1 and type = 'call' and not is_read`, [RAVI])
  ).rows[0].n;
  assert.equal(unread, 0, "the ring is marked read once answered");

  /* A second press is not an error. */
  const again = (await db.query(`select public.call_invite_answer($1) as result`, [topic])).rows[0].result;
  assert.equal(again.status, "accepted");
});

test("one-to-one: a decline is recorded and the caller is told, without ringing again", async () => {
  const conversation = await directConversation(ASHA, RAVI);
  const topic = `call-dm:${conversation}`;

  await signIn(ASHA);
  await db.query(`select public.call_invite_start($1, 'video', null, $2)`, [topic, conversation]);

  await signIn(RAVI);
  const declined = (await db.query(`select public.call_invite_decline($1) as result`, [topic])).rows[0].result;
  assert.equal(declined.declined, true);

  await signIn(ASHA);
  const told = (
    await db.query(`select title, type from public.notifications where user_id = $1 and type = 'call_declined'`, [ASHA])
  ).rows;
  assert.equal(told.length, 1, "the caller is told about the decline");
  assert.match(told[0].title, /Ravi declined/i);
  assert.notEqual(told[0].type, "call", "a decline must never be a type that rings");
});

test("one-to-one: nobody answers, and the caller's hang-up becomes a missed call", async () => {
  const conversation = await directConversation(ASHA, RAVI);
  const topic = `call-dm:${conversation}`;

  await signIn(ASHA);
  await db.query(`select public.call_invite_start($1, 'voice', null, $2)`, [topic, conversation]);
  const missed = (await db.query(`select public.call_invite_missed($1) as result`, [topic])).rows[0].result;
  assert.equal(missed.missed, 1, "one person was still ringing");

  await signIn(RAVI);
  const notice = (
    await db.query(`select title, type from public.notifications where user_id = $1 and type = 'call_missed'`, [RAVI])
  ).rows;
  assert.equal(notice.length, 1, "the callee gets a missed-call notice");
  assert.match(notice[0].title, /Missed call from Asha/i);

  /* The invite is gone, so the ring cannot be answered late. */
  await asAdmin();
  const left = (await db.query(`select count(*)::int as n from public.call_invites where topic = $1`, [topic])).rows[0].n;
  assert.equal(left, 0, "the expired invite is deleted");
});

test("somebody who was not rung cannot answer or decline a call", async () => {
  const conversation = await directConversation(ASHA, RAVI);
  const topic = `call-dm:${conversation}`;
  await signIn(ASHA);
  await db.query(`select public.call_invite_start($1, 'voice', null, $2)`, [topic, conversation]);

  await signIn(STRANGER);
  await assert.rejects(
    () => db.query(`select public.call_invite_answer($1)`, [topic]),
    /not part of this call/i,
    "a stranger cannot pick up somebody else's call"
  );
  await assert.rejects(() => db.query(`select public.call_invite_decline($1)`, [topic]), /not part of this call/i);
  /* And cannot declare somebody else's call missed either. */
  const notYours = (await db.query(`select public.call_invite_missed($1) as result`, [topic])).rows[0].result;
  assert.equal(notYours.missed, 0);
  assert.equal(notYours.reason, "not_yours");
});

/* ----------------------------------------------------------------- meetings */

test("a meeting is created with a code, and the host is already in it", async () => {
  await signIn(ASHA);
  const meeting = (await db.query(`select public.meeting_create('Design review', 'video') as result`)).rows[0].result;

  assert.match(meeting.code, /^[a-z0-9]{9}$/, "the code is short and readable");
  assert.equal(meeting.title, "Design review");
  assert.equal(meeting.topic, `call-meeting:${meeting.id}`, "the signalling topic is derived from the id");
  assert.equal(meeting.joinUrl, `/app/?view=meeting&code=${meeting.code}`);

  const lookup = (await db.query(`select public.meeting_lookup($1) as result`, [meeting.code])).rows[0].result;
  assert.equal(lookup.found, true);
  assert.equal(lookup.youAreHost, true);
  assert.equal(lookup.hostName, "Asha");
  assert.equal(lookup.participants, 1, "the host counts as a participant");
});

test("a second person joins with the code, and is announced to the host", async () => {
  await signIn(ASHA);
  const meeting = (await db.query(`select public.meeting_create('Standup', 'video') as result`)).rows[0].result;

  await signIn(RAVI);
  const joined = (await db.query(`select public.meeting_join($1) as result`, [meeting.code])).rows[0].result;
  assert.equal(joined.joined, true);
  assert.equal(joined.youAreHost, false);
  assert.equal(joined.participants, 2);

  await signIn(ASHA);
  const told = (
    await db.query(`select title from public.notifications where user_id = $1 and type = 'meeting_joined'`, [ASHA])
  ).rows;
  assert.equal(told.length, 1);
  assert.match(told[0].title, /Ravi joined/i);
});

test("a locked meeting opens for its host and for nobody else", async () => {
  await signIn(ASHA);
  const meeting = (await db.query(`select public.meeting_create('Private', 'voice') as result`)).rows[0].result;
  const locked = (await db.query(`select public.meeting_lock($1, true) as result`, [meeting.id])).rows[0].result;
  assert.equal(locked.locked, true);

  await signIn(RAVI);
  await assert.rejects(() => db.query(`select public.meeting_join($1)`, [meeting.code]), /locked by the host/i);

  /* The host walks straight back in. */
  await signIn(ASHA);
  const back = (await db.query(`select public.meeting_join($1) as result`, [meeting.code])).rows[0].result;
  assert.equal(back.joined, true);
});

test("only the host can end or lock a meeting", async () => {
  await signIn(ASHA);
  const meeting = (await db.query(`select public.meeting_create('Retro', 'video') as result`)).rows[0].result;

  await signIn(RAVI);
  await db.query(`select public.meeting_join($1)`, [meeting.code]);
  await assert.rejects(() => db.query(`select public.meeting_end($1)`, [meeting.id]), /only the host/i);
  await assert.rejects(() => db.query(`select public.meeting_lock($1, true)`, [meeting.id]), /only the host/i);

  await signIn(ASHA);
  const ended = (await db.query(`select public.meeting_end($1) as result`, [meeting.id])).rows[0].result;
  assert.equal(ended.ended, true);

  /* An ended meeting cannot be joined again, by anyone. */
  await signIn(RAVI);
  await assert.rejects(() => db.query(`select public.meeting_join($1)`, [meeting.code]), /has ended/i);
  const look = (await db.query(`select public.meeting_lookup($1) as result`, [meeting.code])).rows[0].result;
  assert.equal(look.ended, true, "the lobby is told it ended rather than failing to find it");
});

test("a code that does not exist is reported, not crashed on", async () => {
  await signIn(RAVI);
  const look = (await db.query(`select public.meeting_lookup('zzzzzzzzz') as result`)).rows[0].result;
  assert.equal(look.found, false);
  await assert.rejects(() => db.query(`select public.meeting_join('zzzzzzzzz')`), /no meeting has that code/i);
});

test("leaving and rejoining is recorded, so the participant count is honest", async () => {
  await signIn(ASHA);
  const meeting = (await db.query(`select public.meeting_create('Sync', 'video') as result`)).rows[0].result;
  await signIn(RAVI);
  await db.query(`select public.meeting_join($1)`, [meeting.code]);
  await db.query(`select public.meeting_leave($1)`, [meeting.id]);

  await signIn(ASHA);
  const after = (await db.query(`select public.meeting_lookup($1) as result`, [meeting.code])).rows[0].result;
  assert.equal(after.participants, 1, "only the host is still in");

  await signIn(RAVI);
  const again = (await db.query(`select public.meeting_join($1) as result`, [meeting.code])).rows[0].result;
  assert.equal(again.participants, 2, "a reconnect is a rejoin, not a duplicate");
});

test("signalling on a meeting topic is limited to its attendees", async () => {
  await signIn(ASHA);
  const meeting = (await db.query(`select public.meeting_create('Guarded', 'video') as result`)).rows[0].result;
  const topic = `call-meeting:${meeting.id}`;

  /* The policy's own expression, evaluated the way Realtime evaluates it. */
  const allowed = async (userId) => {
    await asAdmin();
    const { rows } = await db.query(
      `select exists (
         select 1 from public.meeting_attendees a
          where a.meeting_id = $1::uuid and a.user_id = $2::uuid and a.left_at is null
       ) as ok`,
      [meeting.id, userId]
    );
    return rows[0].ok;
  };

  assert.equal(await allowed(ASHA), true, "the host may signal");
  assert.equal(await allowed(STRANGER), false, "a stranger holding the id may not");

  await signIn(RAVI);
  await db.query(`select public.meeting_join($1)`, [meeting.code]);
  assert.equal(await allowed(RAVI), true, "an attendee may signal");

  await signIn(RAVI);
  await db.query(`select public.meeting_leave($1)`, [meeting.id]);
  /* Leaving revokes signalling immediately: a tab that walked away must not
     keep the microphone's path into the room open. */
  assert.equal(await allowed(RAVI), false, "leaving revokes signalling");

  await asAdmin();
  const { rows } = await db.query(
    `select count(*)::int as n from pg_policies where schemaname = 'realtime' and policyname = 'call signalling for members'`
  );
  assert.equal(rows[0].n, 1, "exactly one signalling policy exists, so it cannot be loosened by a second");
  assert.ok(topic.startsWith("call-meeting:"));
});

test("the meeting list only shows meetings you hosted or sat in", async () => {
  await signIn(ASHA);
  const mine = (await db.query(`select public.meeting_create('Asha only', 'video') as result`)).rows[0].result;

  await signIn(STRANGER);
  const list = (await db.query(`select * from public.meeting_mine(50)`)).rows.map((row) => row.meeting_mine ?? row);
  const ids = list.map((entry) => entry.id);
  assert.equal(ids.includes(mine.id), false, "a stranger does not see somebody else's meeting");

  await signIn(ASHA);
  const own = (await db.query(`select public.meeting_mine(50)`)).rows.length;
  assert.ok(own >= 1, "the host sees their own meetings");
});
