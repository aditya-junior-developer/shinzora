/* ==========================================================================
   A ringing phone needs a stored ring
   --------------------------------------------------------------------------
   A call used to exist only as Realtime broadcast, which cannot reach a phone
   with the screen off. These checks hold the invite to its promises: a row that
   expires, one notification per person being rung, and silence for a group the
   person muted or a caller who is not a member.
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
const OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GROUP = "11111111-1111-4111-8111-111111111111";

await db.exec(`
  insert into auth.users (id, email) values
    ('${OWNER}','call.owner@example.test'),
    ('${ASHA}','call.asha@example.test'),
    ('${OUTSIDER}','call.outsider@example.test');
  update public.profiles set full_name = 'Aditya', username = 'call_owner' where id = '${OWNER}';
  update public.profiles set full_name = 'Asha', username = 'call_asha' where id = '${ASHA}';

  insert into public.community_groups (id, slug, name, owner_id)
  values ('${GROUP}', 'call-test', 'Design team', '${OWNER}');
  insert into public.community_group_members (group_id, user_id, role) values
    ('${GROUP}', '${OWNER}', 'owner'),
    ('${GROUP}', '${ASHA}', 'member');
`);

/* Run the RPC as a given person, which is what auth.uid() reads. */
const as = async (user, fn) => {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
  await db.exec(`set local role authenticated`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role`);
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
};

await db.exec(`delete from public.notifications`);

await check("starting a call writes a row and rings the other member", async () => {
  const out = await as(OWNER, async () => {
    const { rows } = await db.query(
      `select public.call_invite_start($1, $2, $3, null) as result`,
      ["call:group:" + GROUP, "video", GROUP]
    );
    return rows[0].result;
  });
  assert(out.rung === 1, `one person rung, got ${out.rung}`);
  const { rows: invites } = await db.query(`select topic, kind, expires_at from public.call_invites`);
  assert(invites.length === 1, "one invite row");
  assert(invites[0].kind === "video", "the kind is recorded");
  assert(new Date(invites[0].expires_at).getTime() > Date.now(), "the ring has not already expired");

  const { rows: notes } = await db.query(
    `select title, body, link, type, meta from public.notifications
      where user_id = $1 and type = 'call'`,
    [ASHA]
  );
  assert(notes.length === 1, `Asha has one call notification, has ${notes.length}`);
  assert(notes[0].type === "call", "typed as a call");
  assert(/Aditya/.test(notes[0].title), `names the caller: ${notes[0].title}`);
  assert(/video/i.test(notes[0].title), "says video");
  assert(notes[0].meta.callTopic === "call:group:" + GROUP, "carries the topic to join");
  return "1 row, 1 notification";
});

await check("the caller is never rung by their own call", async () => {
  const { rows } = await db.query(
    `select count(*)::int as n from public.notifications where user_id = $1 and type = 'call'`,
    [OWNER]
  );
  assert(rows[0].n === 0, "the caller has no call notification");
  return "0";
});

await check("a muted member is not rung", async () => {
  await db.exec(`delete from public.notifications`);
  await db.exec(`update public.community_group_members set muted = true where user_id = '${ASHA}'`);
  await as(OWNER, () => db.query(`select public.call_invite_start($1, 'voice', $2, null)`, ["call:muted", GROUP]));
  const { rows } = await db.query(
    `select count(*)::int as n from public.notifications where user_id = $1`,
    [ASHA]
  );
  assert(rows[0].n === 0, "muted stays quiet, even for a call");
  await db.exec(`update public.community_group_members set muted = false where user_id = '${ASHA}'`);
  return "0";
});

await check("a non-member cannot ring the group at all", async () => {
  let refused = false;
  try {
    await as(OUTSIDER, () => db.query(`select public.call_invite_start($1, 'voice', $2, null)`, ["call:outsider", GROUP]));
  } catch (error) {
    refused = /not in that group/i.test(String(error.message));
  }
  assert(refused, "the database refuses an outsider");
  return "42501";
});

await check("hanging up removes the ring", async () => {
  await as(OWNER, () => db.query(`select public.call_invite_end($1)`, ["call:group:" + GROUP]));
  const { rows } = await db.query(
    `select count(*)::int as n from public.call_invites where topic = $1`,
    ["call:group:" + GROUP]
  );
  assert(rows[0].n === 0, "the invite row is gone, so nothing keeps ringing");
  return "deleted";
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
