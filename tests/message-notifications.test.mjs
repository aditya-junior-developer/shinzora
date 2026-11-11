/* ==========================================================================
   A message is a notification
   --------------------------------------------------------------------------
   The owner's report was "messages getting no notification outside of the
   website". The cause was not the push function or the browser: an ordinary
   message never produced a notification row, and Web Push hangs off those rows.
   These checks hold the new triggers to the rules that make them liveable:

     1. a direct message notifies the other participant, not the sender
     2. a muted group notifies nobody
     3. a mention still arrives in a muted group, and only once
     4. the member's own "new messages" switch can silence it
     5. a message with no text and one attachment still says something
   ========================================================================== */

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
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) await apply(db, file);

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASHA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHIRAG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GROUP = "11111111-1111-4111-8111-111111111111";
const CONVO = "22222222-2222-4222-8222-222222222222";

await db.exec(`
  insert into auth.users (id, email) values
    ('${OWNER}','owner@message.test'),
    ('${ASHA}','asha@message.test'),
    ('${CHIRAG}','chirag@message.test');
  update public.profiles set full_name = 'Aditya', username = 'aditya' where id = '${OWNER}';
  update public.profiles set full_name = 'Asha', username = 'asha' where id = '${ASHA}';
  update public.profiles set full_name = 'Chirag', username = 'chirag' where id = '${CHIRAG}';

  insert into public.businesses (id, owner_id, name)
  values ('33333333-3333-4333-8333-333333333333', '${OWNER}', 'Klyr');

  insert into public.community_groups (id, slug, name, owner_id)
  values ('${GROUP}', 'notify-test', 'Design team', '${OWNER}');
  insert into public.community_group_members (group_id, user_id, role, muted) values
    ('${GROUP}', '${OWNER}', 'owner', false),
    ('${GROUP}', '${ASHA}', 'member', false),
    ('${GROUP}', '${CHIRAG}', 'member', false);

  insert into public.team_conversations (id, business_id, kind, created_by)
  values ('${CONVO}', '33333333-3333-4333-8333-333333333333', 'direct', '${OWNER}');
  insert into public.team_conversation_members (conversation_id, user_id) values
    ('${CONVO}', '${OWNER}'), ('${CONVO}', '${ASHA}');
`);

const countFor = async (user) => {
  const { rows } = await db.query(
    `select count(*)::int as n from public.notifications where user_id = $1`,
    [user]
  );
  return rows[0].n;
};
const clear = async () => db.exec(`delete from public.notifications`);
const sendDm = async (body) =>
  db.query(
    `insert into public.team_chat_messages (conversation_id, sender_id, body, attachments)
     values ($1, $2, $3, '[]'::jsonb)`,
    [CONVO, OWNER, body]
  );
const sendGroup = async (body, attachments = "[]", author = OWNER) =>
  db.query(
    `insert into public.community_messages (group_id, author_id, body, attachments)
     values ($1, $2, $3, $4::jsonb)`,
    [GROUP, author, body, attachments]
  );

/* ------------------------------------------------------------------ 1. DM */

await check("a direct message notifies the other participant, once", async () => {
  await clear();
  await sendDm("the banner draft is up");
  assert((await countFor(ASHA)) === 1, `Asha should have 1 notification, has ${await countFor(ASHA)}`);
  assert((await countFor(OWNER)) === 0, "the sender is not notified of their own message");
  const { rows } = await db.query(
    `select title, message, link, meta from public.notifications where user_id = $1`,
    [ASHA]
  );
  assert(rows[0].message.includes("banner draft"), `body carries the message: ${rows[0].message}`);
  assert(rows[0].title.includes("Aditya"), `title names the sender: ${rows[0].title}`);
  assert(rows[0].link.includes("conversation="), `link opens the conversation: ${rows[0].link}`);
  assert(rows[0].meta.messageId, "meta carries the message id");
  return "1 row, named sender, deep link";
});

/* --------------------------------------------------------------- 2. groups */

await check("a group message notifies every member who is not muted", async () => {
  await clear();
  await sendGroup("review moved to Thursday");
  assert((await countFor(ASHA)) === 1, "Asha is notified");
  assert((await countFor(CHIRAG)) === 1, "Chirag is notified");
  assert((await countFor(OWNER)) === 0, "the author is not");
  return "2 rows";
});

await check("muting a group silences it for that member only", async () => {
  await clear();
  await db.exec(`update public.community_group_members set muted = true where user_id = '${CHIRAG}'`);
  await sendGroup("one more thing");
  assert((await countFor(CHIRAG)) === 0, "the muted member gets nothing");
  assert((await countFor(ASHA)) === 1, "the member who did not mute still does");
  await db.exec(`update public.community_group_members set muted = false where user_id = '${CHIRAG}'`);
  return "mute is per member";
});

await check("a mention in a muted group still arrives, exactly once", async () => {
  await clear();
  await db.exec(`update public.community_group_members set muted = true where user_id = '${CHIRAG}'`);
  /* Mirror what group_send does: insert the message, then the mention row and
     its notification. The trigger is deferred, so it must see this and stand
     aside rather than write a second notification. */
  const { rows } = await db.query(
    `insert into public.community_messages (group_id, author_id, body, attachments)
     values ($1, $2, '@chirag can you look at the banner?', '[]'::jsonb) returning id`,
    [GROUP, ASHA]
  );
  const messageId = rows[0].id;
  await db.exec(`
    insert into public.community_mentions (message_id, group_id, mentioned_user, kind)
    values ('${messageId}', '${GROUP}', '${CHIRAG}', 'user');
    select public.notify_user('${CHIRAG}', 'group', 'Design team · Asha',
      '@chirag can you look at the banner?',
      '/app/?view=messages&group=${GROUP}',
      jsonb_build_object('messageId', '${messageId}', 'groupId', '${GROUP}', 'kind', 'mention'));
  `);
  const { rows: after } = await db.query(
    `select count(*)::int as n from public.notifications where user_id = $1`,
    [CHIRAG]
  );
  assert(after[0].n === 1, `exactly one notification, got ${after[0].n}`);
  await db.exec(`update public.community_group_members set muted = false where user_id = '${CHIRAG}'`);
  return "1 row, not 2";
});

/* ------------------------------------------------------- 3. own preferences */

await check("the member's own switch can silence message alerts", async () => {
  await clear();
  await db.exec(`
    insert into public.notification_preferences (user_id, group_messages)
    values ('${ASHA}', false)
    on conflict (user_id) do update set group_messages = false;
  `);
  await sendGroup("anyone about?");
  assert((await countFor(ASHA)) === 0, "a switched-off member gets nothing");
  assert((await countFor(CHIRAG)) === 1, "and does not silence anyone else");
  await db.exec(`update public.notification_preferences set group_messages = true where user_id = '${ASHA}'`);
  return "per person";
});

/* ------------------------------------------------------------- 4. the words */

await check("a message that is only an attachment still says something", async () => {
  await clear();
  await sendGroup("", JSON.stringify([{ kind: "media", path: "x/y.png", name: "banner.png" }]));
  const { rows } = await db.query(
    `select message from public.notifications where user_id = $1`,
    [ASHA]
  );
  assert(rows[0], "the notification exists");
  assert(/photo|video/i.test(rows[0].message), `a readable preview, got "${rows[0].message}"`);
  return `"${rows[0].message}"`;
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
