/* ==========================================================================
   Web Push delivery — the half a database can be held responsible for
   --------------------------------------------------------------------------
   The brief says two things that pull against each other: closed-browser
   notifications must really work, and nothing may be claimed that was not
   tested. Delivery to a real browser cannot be tested from here — that needs a
   browser, a permission prompt and a human. What *can* be tested is everything
   up to the network:

     1. the shared secret is generated once, stored in the vault, and only the
        service role can compare against it
     2. a group notification queues exactly one call to the push function
     3. the call carries the secret and the notification id — and nothing else
     4. a notification that is not about a group queues nothing
     5. the trigger never loses a notification when push is not configured

   Node's real Postgres (PGlite) runs the real migration SQL; `net.http_post` is
   recorded instead of performed, which is precisely the boundary the trigger
   owns. Everything after it — encryption, the push service, the browser — is
   the Edge Function's job and is verified separately against production.
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

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP = "11111111-1111-4111-8111-111111111111";

await db.exec(`
  insert into auth.users (id, email) values ('${A}','push.owner@example.test');
  update public.profiles set full_name = 'Push Owner', username = 'push_owner' where id = '${A}';
  insert into public.community_groups (id, slug, name, owner_id)
  values ('${GROUP}', 'push-test', 'Push Test', '${A}');
`);

const secret = async () => {
  const { rows } = await db.query("select decrypted_secret from vault.decrypted_secrets where name = 'push_hook_secret'");
  return rows[0]?.decrypted_secret || "";
};

/* ------------------------------------------------------- 1. the shared secret */
await check("the shared secret is generated once and kept in the vault", async () => {
  const first = await secret();
  assert(first.length === 64, `expected 64 hex characters, got ${first.length}`);
  /* Re-applying the migration must not rotate it — every queued request would
     start failing to authenticate. */
  await apply(db, "0038_web_push_delivery.sql");
  const second = await secret();
  assert(first === second, "re-applying 0038 changed the secret");
  return "64 chars, stable across a re-run";
});

await check("push_hook_ok accepts the stored secret and nothing else", async () => {
  const good = await secret();
  const yes = await db.query("select public.push_hook_ok($1) as ok", [good]);
  const no = await db.query("select public.push_hook_ok($1) as ok", ["not-the-secret"]);
  const empty = await db.query("select public.push_hook_ok($1) as ok", [""]);
  const blank = await db.query("select public.push_hook_ok($1) as ok", ["   "]);
  assert(yes.rows[0].ok === true, "the real secret was rejected");
  assert(no.rows[0].ok === false, "a wrong secret was accepted");
  assert(empty.rows[0].ok === false, "an empty secret was accepted");
  assert(blank.rows[0].ok === false, "a whitespace secret was accepted");
});

await check("no browser role can call push_hook_ok", async () => {
  const { rows } = await db.query(`
    select
      has_function_privilege('anon', p.oid, 'execute') as anon_exec,
      has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
      has_function_privilege('service_role', p.oid, 'execute') as svc_exec
    from pg_proc p where p.proname = 'push_hook_ok'`);
  assert(rows[0].anon_exec === false, "anon can execute push_hook_ok");
  assert(rows[0].auth_exec === false, "authenticated can execute push_hook_ok");
  assert(rows[0].svc_exec === true, "service_role cannot execute push_hook_ok");
});

/* --------------------------------------------------------- 2 & 3. the trigger */
await db.exec("delete from net.requests");

const insertNotification = async (meta) =>
  db.query(
    `insert into public.notifications (user_id, type, title, body, link, meta)
     values ($1, 'group', 'Someone in a group', 'A preview', $2, $3::jsonb)
     returning id`,
    [A, `/app/?view=messages&group=${GROUP}`, JSON.stringify(meta)]
  );

await check("a group notification queues exactly one push call", async () => {
  const { rows } = await insertNotification({ groupId: GROUP, kind: "mention", groupName: "Push Test" });
  const queued = await db.query("select * from net.requests");
  assert(queued.rows.length === 1, `queued ${queued.rows.length} requests`);
  const request = queued.rows[0];
  assert(request.url.endsWith("/functions/v1/push"), `wrong url: ${request.url}`);
  assert(request.body.notification_id === rows[0].id, "the body does not carry the notification id");
  assert(
    request.timeout_milliseconds === 5000,
    `timeout should be bounded, got ${request.timeout_milliseconds}`
  );
  return `1 request for ${rows[0].id.slice(0, 8)}…`;
});

await check("the call presents the vault secret, not the service role key", async () => {
  const queued = await db.query("select headers from net.requests order by id desc limit 1");
  const headers = queued.rows[0].headers;
  const expected = await secret();
  assert(headers["x-push-key"] === expected, "x-push-key does not match the stored secret");
  const flat = JSON.stringify(headers);
  assert(!/authorization/i.test(flat), "an Authorization header was attached — the service role key must never leave here");
  assert(!/service_role/i.test(flat), "the service role key name appears in the headers");
});

await check("nothing else is sent — no message body, no names", async () => {
  const queued = await db.query("select body from net.requests order by id desc limit 1");
  const keys = Object.keys(queued.rows[0].body);
  assert(keys.length === 1 && keys[0] === "notification_id", `unexpected payload keys: ${keys.join(", ")}`);
});

await check("a non-group notification queues nothing", async () => {
  await db.exec("delete from net.requests");
  await db.query(
    `insert into public.notifications (user_id, type, title, body)
     values ($1, 'payment', 'Payment verified', 'A payment was confirmed.')`,
    [A]
  );
  const queued = await db.query("select count(*)::int as n from net.requests");
  assert(queued.rows[0].n === 0, `queued ${queued.rows[0].n} requests for a non-group notification`);
});

/* --------------------------------------------------- 5. never lose a message */
await check("with push unconfigured the notification is still stored", async () => {
  await db.exec("delete from net.requests");
  await db.exec("delete from vault.secrets where name = 'push_hook_secret'");
  const { rows } = await db.query(
    `insert into public.notifications (user_id, type, title, body, meta)
     values ($1, 'group', 'Still stored', 'A preview', $2::jsonb)
     returning id`,
    [A, JSON.stringify({ groupId: GROUP })]
  );
  const stored = await db.query("select count(*)::int as n from public.notifications where id = $1", [rows[0].id]);
  const queued = await db.query("select count(*)::int as n from net.requests");
  assert(stored.rows[0].n === 1, "the notification was lost");
  assert(queued.rows[0].n === 0, "a request was queued without a secret to sign it");
  return "stored, not queued, no error";
});

await check("the trigger is attached to notifications, once", async () => {
  const { rows } = await db.query(
    `select count(*)::int as n from pg_trigger where tgname = 'notifications_push_fanout' and not tgisinternal`
  );
  assert(rows[0].n === 1, `found ${rows[0].n} triggers`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
