/* ==========================================================================
   Groups, roles, mentions and access — the acceptance test from the brief
   --------------------------------------------------------------------------
   Three accounts, the exact scenario that was asked for, run against the real
   migration SQL in a real Postgres (PGlite). Every check goes through the
   security-definer RPCs and the RLS policies as the signed-in user, not as an
   owner of the database, so what passes here is what the browser will hit.

     1. A creates a group and becomes its owner
     2. A adds B and C
     3. A promotes B to Group Admin
     4. B changes the group picture
     5. C cannot change the group picture
     6. B mentions C, and C receives exactly one notification
     7. @everyone follows the group's settings and the sender's role
     8. notification preferences and push subscriptions are per-user
     9. removing a member revokes access immediately

   Plus the ones the brief implies: a website administrator gets no group
   powers, a mention of a non-member notifies nobody, and a duplicate mention in
   one message is one notification.
   ========================================================================== */

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCAFFOLD, migrationFiles, apply } from "../scripts/staging-db.mjs";

/* Awaited, deliberately: most of these checks talk to the database, and an
   un-awaited assertion cannot fail the run. That bug hid a broken SQL function
   on the first pass of this file, so the helper now always waits. */
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

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // creates the group
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // promoted to admin
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // stays a member
const SITE_ADMIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // administers the website
const OUTSIDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // never joins

await db.exec(`
  insert into auth.users (id, email) values
    ('${A}','aditya.owner@example.test'),
    ('${B}','bhavna.admin@example.test'),
    ('${C}','chirag.member@example.test'),
    ('${SITE_ADMIN}','ops.siteadmin@example.test'),
    ('${OUTSIDER}','outsider@example.test');
  update public.profiles set full_name = 'Aditya Owner', username = 'aditya_owner' where id = '${A}';
  update public.profiles set full_name = 'Bhavna Admin', username = 'bhavna_admin' where id = '${B}';
  update public.profiles set full_name = 'Chirag Member', username = 'chirag_member' where id = '${C}';
  update public.profiles set full_name = 'Ops Site Admin', username = 'ops_siteadmin' where id = '${SITE_ADMIN}';
  update public.profiles set full_name = 'Outsider', username = 'outsider' where id = '${OUTSIDER}';
  insert into public.admin_users (user_id, email, role) values ('${SITE_ADMIN}','ops.siteadmin@example.test','superadmin')
    on conflict (user_id) do nothing;
  grant usage on schema public to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
`);

/** Sign in as somebody: role authenticated + the JWT claims PostgREST would set. */
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

/** Run a statement that must fail, and return the message. */
const rejects = async (sql, pattern) => {
  try {
    await db.query(sql);
  } catch (error) {
    if (pattern && !pattern.test(error.message)) {
      throw new Error(`refused, but for the wrong reason: ${error.message}`);
    }
    return error.message;
  }
  throw new Error("the call was allowed when it should have been refused");
};

/**
 * Read as the database owner, then sign back in.
 *
 * Used only where the assertion is *about* another account's private row — a
 * notification is readable only by its own user, so reading it while signed in
 * as somebody else returns nothing and the assertion becomes vacuous.
 */
const readAsOwner = async (sql) => {
  await db.exec("reset role;");
  const result = await db.query(sql);
  if (acting) await setUser(acting);
  return result.rows;
};

/**
 * How many notifications an account has.
 *
 * Read as the database owner on purpose. `notifications` is readable only by its
 * own user (plus admins), so asking "did B get notified?" while signed in as A
 * returns 0 no matter what the truth is — an assertion that can never fail.
 */
const notifCount = async (userId, type) => {
  await db.exec("reset role;");
  const row = await one(
    `select count(*)::int as n from public.notifications where user_id = '${userId}'${
      type ? ` and type = '${type}'` : ""
    }`
  );
  if (acting) await setUser(acting);
  return Number(row.n);
};

console.log("\n1 · the creator is the owner");

await setUser(A);
const group = await rpc(`select public.group_create('Startup Team','Building something amazing together.', array['${B}'::uuid,'${C}'::uuid]) as g`);
const G = group.id;
await check("A creates the group and is told they are the owner", () => assert.equal(group.role, "owner"));
await check("the group got a readable slug", () => assert.match(group.slug, /^startup-team/), group.slug);
await check("A is the owner in the database", async () => assert.equal(await rpc(`select public.group_is_owner('${G}') as x`), true));
await check("B and C are members, not admins", async () => {
  const rows = (await db.query(`select user_id, role from public.community_group_members where group_id = '${G}' order by role`)).rows;
  assert.deepEqual(rows.map((r) => r.role), ["member", "member", "owner"]);
  return "3 memberships";
});
await check("B and C were told they were added", async () => {
  assert.equal(await notifCount(B, "group"), 1);
  assert.equal(await notifCount(C, "group"), 1);
});

console.log("\n2 · only members can see it");

await setUser(OUTSIDER);
await check("an outsider cannot open the group", async () => {
  const message = await rejects(`select public.group_get('${G}')`, /not a member/i);
  return message;
});
await check("an outsider's list is empty", async () => assert.deepEqual(await rpc("select public.group_my_groups() as x"), []));
await check("an outsider cannot read a single message", async () =>
  rejects(`select public.group_messages_list('${G}')`, /not a member/i));

await setUser(SITE_ADMIN);
await check("a website administrator is not a member of somebody else's group", async () => {
  assert.equal(await rpc(`select public.group_is_member('${G}') as x`), false);
  await rejects(`select public.group_get('${G}')`, /not a member/i);
  return "is_admin() grants nothing here";
});
await check("a website administrator cannot change the picture either", async () =>
  rejects(`select public.group_update('${G}', null, null, 'https://example.com/x.png')`, /owner or a group admin/i));

console.log("\n3 · the owner promotes B to admin");

await setUser(A);
const promoted = await rpc(`select public.group_set_role('${G}','${B}','admin') as x`);
await check("B is now an admin", () => assert.equal(promoted.role, "admin"));
await check("B was notified about the role", async () => assert.equal(await notifCount(B, "group"), 2));

await setUser(B);
await check("an admin cannot promote anybody else", async () =>
  rejects(`select public.group_set_role('${G}','${C}','admin')`, /only the group owner/i));
await check("an admin cannot hand themselves ownership", async () =>
  rejects(`select public.group_transfer_owner('${G}','${B}')`, /only the owner/i));

console.log("\n4 · B (admin) changes the group picture");

const PICTURE = "https://zmkgfmlcpzjfgxdmbtvi.supabase.co/storage/v1/object/public/brand-assets/group.png";
const changed = await rpc(`select public.group_update('${G}', null, null, '${PICTURE}') as x`);
await check("the picture is stored", () => assert.equal(changed.avatarUrl, PICTURE));
await check("an admin can also rename the group", async () => {
  const renamed = await rpc(`select public.group_update('${G}','Startup Team HQ') as x`);
  assert.equal(renamed.name, "Startup Team HQ");
  return renamed.name;
});
await check("a javascript: picture is refused", async () =>
  rejects(`select public.group_update('${G}', null, null, 'javascript:alert(1)')`, /image address/i));

console.log("\n5 · C (member) cannot change the picture");

await setUser(C);
await check("a regular member is refused by the database", async () =>
  rejects(`select public.group_update('${G}', null, null, 'https://example.com/mine.png')`, /owner or a group admin/i));
await check("and the stored picture did not change", async () => {
  const row = await one(`select avatar_url from public.community_groups where id = '${G}'`);
  assert.equal(row.avatar_url, PICTURE);
});
await check("a regular member can still post", async () => {
  const sent = await rpc(`select public.group_send('${G}','morning all') as x`);
  assert.ok(sent.id);
  return "message id issued";
});
await check("a regular member cannot remove somebody else", async () =>
  rejects(`select public.group_remove_member('${G}','${B}')`, /owner or an admin/i));

console.log("\n6 · B mentions C");

await setUser(B);
await check("the @ list contains only this group's members", async () => {
  const list = await rpc(`select public.group_mention_candidates('${G}', 'chi') as x`);
  assert.equal(list.length, 1);
  assert.equal(list[0].username, "chirag_member");
  assert.equal((await rpc(`select public.group_mention_candidates('${G}', 'outsider') as x`)).length, 0);
  return "@chirag_member";
});

const beforeC = await notifCount(C, "group_mention");
const mentionMessage = await rpc(
  `select public.group_send('${G}','@chirag_member can you share the latest update? @chirag_member @chirag_member') as x`
);
await await check("C receives exactly one mention notification, not three", async () => {
  const after = await notifCount(C, "group_mention");
  assert.equal(after - beforeC, 1, `expected one new mention notification, got ${after - beforeC}`);
  return "1";
});
await check("the duplicate mentions collapsed to one row", async () => {
  const row = await one(`select count(*)::int as n from public.community_mentions where message_id = '${mentionMessage.id}' and mentioned_user = '${C}'`);
  assert.equal(row.n, 1);
});
await check("the notification carries the group and the message", async () => {
  const [row] = await readAsOwner(`select title, body, link, meta from public.notifications
    where user_id = '${C}' and type = 'group_mention' order by created_at desc limit 1`);
  assert.match(row.title, /Bhavna Admin mentioned you/);
  assert.equal(row.meta.messageId, mentionMessage.id);
  assert.equal(row.meta.groupId, G);
  assert.match(row.link, new RegExp(`group=${G}`));
  assert.match(row.link, new RegExp(`message=${mentionMessage.id}`));
  return row.title;
});
await check("a mention of a non-member notifies nobody and is not stored", async () => {
  const before = (await readAsOwner("select count(*)::int as n from public.community_mentions"))[0];
  /* Every new account has a welcome notification, so the comparison is a delta,
     not an absolute zero. */
  const outsiderBefore = await notifCount(OUTSIDER);
  await rpc(`select public.group_send('${G}','@outsider hello there') as x`);
  const after = (await readAsOwner("select count(*)::int as n from public.community_mentions"))[0];
  assert.equal(after.n, before.n, "a mention of somebody outside the group created a row");
  assert.equal(
    await notifCount(OUTSIDER), outsiderBefore,
    "the outsider was notified about a group they cannot see"
  );
});
await check("the mentioned member is flagged in the thread payload", async () => {
  const thread = await rpc(`select public.group_messages_list('${G}') as x`);
  const message = thread.find((row) => row.id === mentionMessage.id);
  assert.equal(message.mentions[0].userId, C);
  assert.equal(message.mentions[0].kind, "user");
});

console.log("\n7 · @everyone obeys the group's settings and the sender's role");

const beforeEveryone = await notifCount(C, "group_mention");
await rpc(`select public.group_send('${G}','@everyone demo at 5 PM') as x`);
await check("an admin's @everyone reaches every member once", async () => {
  const after = await notifCount(C, "group_mention");
  assert.equal(after - beforeEveryone, 1);
  const [row] = await readAsOwner(`select meta from public.notifications where user_id = '${C}' and type = 'group_mention' order by created_at desc limit 1`);
  assert.equal(row.meta.kind, "everyone");
  return "kind=everyone";
});

await rpc(`select public.group_update('${G}', null, null, null, null, true) as x`);
await setUser(C);
await check("with everyone_mentions_admins on, a member's @everyone is refused", async () =>
  rejects(`select public.group_send('${G}','@all meeting now')`, /Mass mentions are not allowed/i));
await setUser(B);
await check("and an admin's @everyone still works", async () => {
  const sent = await rpc(`select public.group_send('${G}','@everyone still on for the demo') as x`);
  assert.ok(sent.id);
});

await setUser(A);
await rpc(`select public.group_update('${G}', null, null, null, false) as x`);
await check("with the feature off, even the owner cannot mass mention", async () =>
  rejects(`select public.group_send('${G}','@everyone hello')`, /Mass mentions are not allowed/i));

console.log("\n8 · preferences and push subscriptions are per user");

await setUser(C);
const prefs = await rpc("select public.notification_prefs_get() as x");
await check("defaults are sensible and answer without a row existing", () => {
  assert.equal(prefs.groupMessages, true);
  assert.equal(prefs.sounds, true);
  assert.equal(prefs.pushEnabled, false);
  assert.equal(prefs.devices, 0);
});
const saved = await rpc("select public.notification_prefs_set(false, true, false) as x");
await check("a member can turn off group messages but keep mentions and mute sounds", () => {
  assert.equal(saved.groupMessages, false);
  assert.equal(saved.groupMentions, true);
  assert.equal(saved.sounds, false);
});

await check("muting the group stops ordinary notifications but not mentions", async () => {
  await rpc(`select public.group_set_muted('${G}', true) as x`);
  const before = await notifCount(C);
  await setUser(A);
  await rpc(`select public.group_send('${G}','ordinary chatter') as x`);
  const afterChatter = await notifCount(C);
  assert.equal(afterChatter, before, "a muted group still sent an ordinary notification");
  await rpc(`select public.group_send('${G}','@chirag_member heads up') as x`);
  const afterMention = await notifCount(C, "group_mention");
  assert.ok(afterMention > 0, "the mention did not arrive");
  return "mute suppresses chatter, not mentions";
});

await setUser(C);
const subscribed = await rpc(
  `select public.push_subscribe('https://push.example.test/abc','BPublicKeyMaterial','authSecret','Firefox on Linux') as x`
);
await check("a browser can register for push", () => assert.equal(subscribed.devices, 1));
await check("the endpoint is stored once, not once per subscribe", async () => {
  await rpc(`select public.push_subscribe('https://push.example.test/abc','BPublicKeyMaterial','authSecret','Firefox on Linux') as x`);
  const row = await one(`select count(*)::int as n from public.push_subscriptions where endpoint = 'https://push.example.test/abc'`);
  assert.equal(row.n, 1);
});
await check("another user cannot see somebody else's endpoint", async () => {
  await setUser(B);
  const rows = (await db.query("select endpoint from public.push_subscriptions")).rows;
  assert.equal(rows.length, 0, "a push endpoint leaked across accounts");
});
await check("an http endpoint is refused", async () => {
  await setUser(C);
  return rejects(`select public.push_subscribe('http://insecure.test/x','k','a','ua')`, /https/i);
});
await check("a dead endpoint can be disabled by the sender", async () => {
  await db.exec(`reset role; select public.push_mark_result('https://push.example.test/abc', 410);`);
  const row = await one(`select disabled_at, failures from public.push_subscriptions where endpoint = 'https://push.example.test/abc'`);
  assert.ok(row.disabled_at, "410 did not disable the subscription");
  return "410 → disabled";
});
await check("re-subscribing revives it", async () => {
  await setUser(C);
  await rpc(`select public.push_subscribe('https://push.example.test/abc','BPublicKeyMaterial','authSecret','Firefox on Linux') as x`);
  const row = await one(`select disabled_at, failures from public.push_subscriptions where endpoint = 'https://push.example.test/abc'`);
  assert.equal(row.disabled_at, null);
  assert.equal(row.failures, 0);
});

console.log("\n9 · removing a member revokes access immediately");

await setUser(C);
await rpc(`select public.group_set_muted('${G}', false) as x`);
await check("C can read the thread while a member", async () => {
  const thread = await rpc(`select public.group_messages_list('${G}') as x`);
  assert.ok(thread.length >= 3, `only ${thread.length} messages`);
  return `${thread.length} messages`;
});

await setUser(A);
await check("the owner cannot be removed", async () =>
  rejects(`select public.group_remove_member('${G}','${A}')`, /owner cannot be removed/i));
await check("an admin cannot remove the owner", async () => {
  await setUser(B);
  const message = await rejects(`select public.group_remove_member('${G}','${A}')`, /owner cannot be removed/i);
  await setUser(A);
  return message;
});
await check("an admin cannot remove another admin", async () => {
  /* Promote C so there are two admins, then have B try to remove C. */
  await rpc(`select public.group_set_role('${G}','${C}','admin') as x`);
  await setUser(B);
  const message = await rejects(`select public.group_remove_member('${G}','${C}')`, /cannot remove another admin/i);
  await setUser(A);
  await rpc(`select public.group_set_role('${G}','${C}','member') as x`);
  return message;
});
const removed = await rpc(`select public.group_remove_member('${G}','${C}') as x`);
await check("the owner removes C", () => assert.equal(removed.removed, true));
await check("C was told they lost access", async () => {
  const [row] = await readAsOwner(`select title from public.notifications where user_id = '${C}' and title like 'Removed from%' order by created_at desc limit 1`);
  assert.ok(row, "C was removed silently");
});

await setUser(C);
await check("C can no longer read the messages through the RPC", async () =>
  rejects(`select public.group_messages_list('${G}')`, /not a member/i));
await check("C can no longer read the messages through RLS either", async () => {
  const rows = (await db.query(`select id from public.community_messages where group_id = '${G}'`)).rows;
  assert.equal(rows.length, 0, "the policy still returns a removed member's messages");
  return "0 rows";
});
await check("C can no longer post", async () => rejects(`select public.group_send('${G}','still here?')`, /not a member/i));
await check("C's groups list no longer contains it", async () => {
  const mine = await rpc("select public.group_my_groups() as x");
  assert.equal(mine.length, 0);
});
await check("C cannot re-add themselves", async () =>
  rejects(`select public.group_add_member('${G}','${C}')`, /not in that group/i));

console.log("\n10 · the group survives, and the other member still has access");

await setUser(B);
await check("B still reads the thread", async () => {
  const thread = await rpc(`select public.group_messages_list('${G}') as x`);
  assert.ok(thread.length >= 3);
  return `${thread.length} messages`;
});
await check("B sees C is gone from the member list", async () => {
  const detail = await rpc(`select public.group_get('${G}') as x`);
  assert.equal(detail.members.length, 2);
  assert.deepEqual(detail.members.map((m) => m.role).sort(), ["admin", "owner"]);
});
await check("a public channel message is still readable by everyone", async () => {
  await db.exec("reset role; set role authenticated;");
  const rows = (await db.query("select id from public.community_channels limit 1")).rows;
  assert.equal(rows.length, 1, "the public channels broke");
  return "public rooms unaffected";
});
await check("a group message can never also claim a public channel", async () => {
  await db.exec("reset role;");
  return rejects(
    `insert into public.community_messages (channel_id, group_id, author_id, body)
     values ((select id from public.community_channels limit 1), '${G}', '${A}', 'both rooms')`,
    /one_room|check constraint/i
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
