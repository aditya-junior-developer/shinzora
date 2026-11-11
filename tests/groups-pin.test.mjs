/* ==========================================================================
   The pinned message and message search — tested where they are enforced
   --------------------------------------------------------------------------
   Both features are one RPC each, and both are membership problems before they
   are UI problems. The hub draws a pin bar and a search box; this file proves
   the two things behind them:

     1. only the owner and admins may pin, and a member calling the RPC
        directly is refused by the database, not by a hidden button
     2. a message from another group cannot be pinned into this one
     3. unpinning clears the pin, and deleting the message clears it too
     4. search returns this group's matching messages and nothing else
     5. an outsider can neither read the pin nor search the group

   Real migration SQL, real Postgres (PGlite), signed in as each account.
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

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // owner
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // admin
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // member
const OUTSIDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

await db.exec(`
  insert into auth.users (id, email) values
    ('${A}','pin.owner@example.test'),
    ('${B}','pin.admin@example.test'),
    ('${C}','pin.member@example.test'),
    ('${OUTSIDER}','pin.outsider@example.test');
  update public.profiles set full_name = 'Pin Owner', username = 'pin_owner' where id = '${A}';
  update public.profiles set full_name = 'Pin Admin', username = 'pin_admin' where id = '${B}';
  update public.profiles set full_name = 'Pin Member', username = 'pin_member' where id = '${C}';
  update public.profiles set full_name = 'Outsider', username = 'pin_outsider' where id = '${OUTSIDER}';
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
    if (pattern && !pattern.test(error.message)) {
      throw new Error(`refused, but for the wrong reason: ${error.message}`);
    }
    return error.message;
  }
  throw new Error("the call was allowed when it should have been refused");
};

/* Two groups, so a message from one can be offered to the other. */
await setUser(A);
const G = (await rpc(`select public.group_create('pin-one', 'Pin One', null) as x`)).id;
const G2 = (await rpc(`select public.group_create('pin-two', 'Pin Two', null) as x`)).id;
await rpc(`select public.group_add_member('${G}', '${B}') as x`);
await rpc(`select public.group_add_member('${G}', '${C}') as x`);
await rpc(`select public.group_set_role('${G}', '${B}', 'admin') as x`);

await setUser(C);
const M1 = (await rpc(`select public.group_send('${G}', 'release notes for friday', '[]'::jsonb) as x`)).id;
const M2 = (await rpc(`select public.group_send('${G}', 'lunch is at one', '[]'::jsonb) as x`)).id;

await setUser(A);
await rpc(`select public.group_send('${G2}', 'other group business', '[]'::jsonb) as x`);
const FOREIGN = (await one(`select id from public.community_messages where group_id = '${G2}'`)).id;

/* ------------------------------------------------------------ 1. who may pin */

await check("a member cannot pin a message, even calling the RPC directly", async () => {
  await setUser(C);
  await rejects(`select public.group_pin('${G}', '${M1}')`, /owner and admins/i);
});

await check("an admin can pin", async () => {
  await setUser(B);
  const pinned = await rpc(`select public.group_pin('${G}', '${M1}') as x`);
  assert.equal(pinned.id, M1);
  assert.match(pinned.authorName, /Pin Member/, "the pin carries who wrote it");
  return "pinned by the admin";
});

await check("the pin is visible to every member", async () => {
  await setUser(C);
  const pinned = await rpc(`select public.group_pinned('${G}') as x`);
  assert.equal(pinned.id, M1);
  assert.equal(pinned.body, "release notes for friday");
});

await check("a second pin replaces the first — one pin per group", async () => {
  await setUser(A);
  await rpc(`select public.group_pin('${G}', '${M2}') as x`);
  const pinned = await rpc(`select public.group_pinned('${G}') as x`);
  assert.equal(pinned.id, M2);
});

/* ------------------------------------------------------- 2. what may be pinned */

await check("a message from another group cannot be pinned into this one", async () => {
  await setUser(A);
  await rejects(`select public.group_pin('${G}', '${FOREIGN}')`, /not in this group/i);
});

await check("an outsider can neither read the pin nor pin anything", async () => {
  await setUser(OUTSIDER);
  await rejects(`select public.group_pinned('${G}')`, /not a member/i);
  await rejects(`select public.group_pin('${G}', '${M1}')`, /not a member/i);
  return "refused on both";
});

/* ------------------------------------------------------------- 3. clearing it */

await check("unpinning clears the bar", async () => {
  await setUser(A);
  await rpc(`select public.group_unpin('${G}') as x`);
  const pinned = await rpc(`select public.group_pinned('${G}') as x`);
  assert.equal(pinned, null);
});

await check("a member cannot unpin", async () => {
  await setUser(C);
  await rejects(`select public.group_unpin('${G}')`, /owner and admins/i);
});

await check("deleting the pinned message clears the pin instead of leaving it dangling", async () => {
  await setUser(B);
  await rpc(`select public.group_pin('${G}', '${M1}') as x`);
  const third = (await rpc(`select public.group_send('${G}', 'temporary note', '[]'::jsonb) as x`)).id;
  await rpc(`select public.group_pin('${G}', '${third}') as x`);
  await db.exec(`reset role; delete from public.community_messages where id = '${third}';`);
  await setUser(B);
  const pinned = await rpc(`select public.group_pinned('${G}') as x`);
  assert.equal(pinned, null, "the pin must clear with the message");
  return "cleared by the foreign key";
});

/* ------------------------------------------------------------------ 4. search */

await check("search finds this group's matching messages", async () => {
  await setUser(C);
  const rows = await rpc(`select public.group_messages_search('${G}', 'release') as x`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, M1);
  assert.match(rows[0].body, /release notes/);
});

await check("search is case-insensitive and trims", async () => {
  await setUser(C);
  const rows = await rpc(`select public.group_messages_search('${G}', '  LUNCH  ') as x`);
  assert.equal(rows.length, 1, "the second message matched");
});

await check("a one-character query returns nothing rather than everything", async () => {
  await setUser(C);
  const rows = await rpc(`select public.group_messages_search('${G}', 'l') as x`);
  assert.deepEqual(rows, []);
});

await check("search never leaks another group's messages", async () => {
  await setUser(C);
  const rows = await rpc(`select public.group_messages_search('${G}', 'other group') as x`);
  assert.deepEqual(rows, [], "G2's message must not appear");
});

await check("an outsider cannot search a group", async () => {
  await setUser(OUTSIDER);
  await rejects(`select public.group_messages_search('${G}', 'lunch')`, /not a member/i);
});

await check("all four functions are security definer with a pinned search_path", async () => {
  /* The harness above grants EXECUTE on every function to anon so the other
     suites can call things, which masks the migration's own REVOKEs. What is
     asserted instead is the property that makes those REVOKEs meaningful: the
     body runs as the definer with `search_path` pinned, so a caller cannot
     redirect the membership check at a table of their own. */
  const { rows } = await db.query(`
    select p.proname, p.prosecdef, p.proconfig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('group_pin', 'group_unpin', 'group_pinned', 'group_messages_search')
    order by p.proname
  `);
  assert.equal(rows.length, 4, `expected four functions, found ${rows.length}`);
  for (const row of rows) {
    assert.equal(row.prosecdef, true, `${row.proname} must be security definer`);
    assert.match(
      String(row.proconfig || ""),
      /search_path=public/,
      `${row.proname} must pin search_path`
    );
  }
  return "definer + pinned search_path";
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
