/* ==========================================================================
   Group attachments — what the database will and will not accept
   --------------------------------------------------------------------------
   The composer is a convenience; these rules are the feature. A file a member
   sends must be filed under the group it was sent to, be one of the five
   allowed types, and cannot be used to point a message at another group's
   object. The public Community rooms stay text-only.

   Everything runs through `group_send` as the signed-in member, against the
   real migration SQL in PGlite.
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
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GROUP = "11111111-1111-4111-8111-111111111111";
const OTHER_GROUP = "22222222-2222-4222-8222-222222222222";

await db.exec(`
  insert into auth.users (id, email) values
    ('${A}','files.owner@example.test'),
    ('${B}','files.member@example.test'),
    ('${OUTSIDER}','files.outsider@example.test');
  update public.profiles set full_name = 'Owner', username = 'files_owner' where id = '${A}';
  update public.profiles set full_name = 'Member', username = 'files_member' where id = '${B}';
  update public.profiles set full_name = 'Outsider', username = 'files_outsider' where id = '${OUTSIDER}';
  insert into public.community_groups (id, slug, name, owner_id) values
    ('${GROUP}', 'files-test', 'Files Test', '${A}'),
    ('${OTHER_GROUP}', 'files-other', 'Other Group', '${A}');
  insert into public.community_group_members (group_id, user_id, role) values
    ('${GROUP}', '${A}', 'owner'),
    ('${GROUP}', '${B}', 'member');
`);

/* PGlite reads the older `request.jwt.claim.*` settings, which is what the
   harness elsewhere in this repo uses too. Setting both spellings keeps this
   working whichever one a future PGlite prefers. */
const asUser = async (userId) => {
  await db.exec(`
    reset role;
    set role authenticated;
    select set_config('request.jwt.claim.sub','${userId}',false);
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claims','{"sub":"${userId}","role":"authenticated"}',false);
  `);
};
const asOwner = async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claims','{}',false);
  `);
};

const file = (overrides = {}) => ({
  path: `${GROUP}/${A}/${"11111111-1111-4111-8111-aaaaaaaaaaaa"}-photo.jpg`,
  name: "photo.jpg",
  mime: "image/jpeg",
  size: 240000,
  ...overrides
});

const send = async (group, body, attachments) => {
  const { rows } = await db.query("select public.group_send($1, $2, $3::jsonb) as out", [
    group,
    body,
    JSON.stringify(attachments || [])
  ]);
  return rows[0].out;
};

/* ------------------------------------------------------------------- tests */

await check("a picture with no text is a valid message now", async () => {
  await asUser(A);
  const out = await send(GROUP, "", [file()]);
  assert.ok(out.id, "no message id returned");
  /* Read back as the owner: the write went through the member's RPC, but the
     table itself is not directly readable by `authenticated`, which is the
     point of routing every write through a function. */
  await asOwner();
  const { rows } = await db.query(
    "select attachments, body from public.community_messages where id = $1",
    [out.id]
  );
  assert.equal(rows[0].attachments.length, 1, "the attachment was not stored");
  assert.equal(rows[0].body, "", "the body should be empty, not invented");
  return "body empty, one file stored";
});

await check("text and a file together both survive", async () => {
  await asUser(A);
  const out = await send(GROUP, "here is the banner", [file({ name: "banner.png", mime: "image/png" })]);
  await asOwner();
  const { rows } = await db.query("select body, attachments from public.community_messages where id = $1", [out.id]);
  assert.equal(rows[0].body, "here is the banner");
  assert.equal(rows[0].attachments[0].name, "banner.png");
});

await check("an empty message with no file is still refused", async () => {
  await asUser(A);
  await assert.rejects(() => send(GROUP, "   ", []), /Write something or attach a file/);
});

await check("a file filed under another group is refused", async () => {
  await asUser(A);
  const stolen = file({ path: `${OTHER_GROUP}/${A}/sneaky.jpg` });
  await assert.rejects(() => send(GROUP, "look", [stolen]), /does not belong to this group/);
});

await check("an executable is refused by type", async () => {
  await asUser(A);
  await assert.rejects(
    () => send(GROUP, "", [file({ name: "setup.exe", mime: "application/x-msdownload" })]),
    /JPEG, PNG, WebP, GIF or PDF/
  );
});

await check("a file over 20 MB is refused", async () => {
  await asUser(A);
  await assert.rejects(() => send(GROUP, "", [file({ size: 21 * 1024 * 1024 })]), /under 20 MB/);
});

await check("six files in one message is refused", async () => {
  await asUser(A);
  const six = Array.from({ length: 6 }, (_, index) => file({ path: `${GROUP}/${A}/f${index}.jpg` }));
  await assert.rejects(() => send(GROUP, "", six), /Five files at most/);
});

await check("a non-member cannot send a file at all", async () => {
  await asUser(OUTSIDER);
  await assert.rejects(() => send(GROUP, "", [file()]), /not a member of that group/);
});

await check("the thread returns the attachments it stored", async () => {
  await asUser(B);
  const { rows } = await db.query("select public.group_messages_list($1, null, 20) as out", [GROUP]);
  const messages = rows[0].out;
  const withFiles = messages.filter((message) => (message.attachments || []).length);
  assert.ok(withFiles.length >= 2, `expected stored attachments, found ${withFiles.length}`);
  assert.equal(withFiles[0].attachments[0].mime.startsWith("image/") || withFiles[0].attachments[0].mime === "application/pdf", true);
  return `${withFiles.length} messages carry files`;
});

await check("public Community rooms are still text-only", async () => {
  await asOwner();
  /* The constraint is the guarantee: a row with a channel and no text cannot
     exist, so no future RPC can slip an attachment into a text-only room. */
  await assert.rejects(
    () =>
      db.query(
        `insert into public.community_messages (channel_id, author_id, body, attachments)
         values ((select id from public.community_channels limit 1), $1, '', $2::jsonb)`,
        [A, JSON.stringify([file()])]
      ),
    /community_messages_body_check/
  );
});

await check("a picture in a group cannot exceed the per-message array rule", async () => {
  await asOwner();
  await assert.rejects(
    () =>
      db.query(
        `insert into public.community_messages (group_id, author_id, body, attachments)
         values ($1, $2, 'x', $3::jsonb)`,
        [GROUP, A, JSON.stringify(Array.from({ length: 9 }, () => file()))]
      ),
    /community_messages_attachments_array/
  );
});

await check("the storage policy names the group and the uploader", async () => {
  await asOwner();
  const { rows } = await db.query(
    `select policyname, with_check from pg_policies
     where tablename = 'objects' and policyname like 'group files%' order by policyname`
  );
  assert.equal(rows.length, 2, `expected 2 storage policies, found ${rows.length}`);
  const insertPolicy = rows.find((row) => row.policyname === "group files own upload");
  assert.match(String(insertPolicy.with_check), /group_is_member/, "the upload policy must check membership");
  assert.match(String(insertPolicy.with_check), /auth\.uid\(\)/, "the upload policy must check the uploader");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
