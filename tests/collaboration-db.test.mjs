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
    ('11111111-1111-4111-8111-111111111111','owner@gmail.com'),
    ('22222222-2222-4222-8222-222222222222','freelancer@gmail.com'),
    ('33333333-3333-4333-8333-333333333333','agent@gmail.com');
  insert into public.businesses (owner_id,name,category) values
    ('11111111-1111-4111-8111-111111111111','Northstar Studio','services');
`);

const [business] = (await db.query("select id from public.businesses where owner_id='11111111-1111-4111-8111-111111111111'")).rows;
const owner = "11111111-1111-4111-8111-111111111111";
const freelancer = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";
const setUser = async (id, email) => db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false); select set_config('request.jwt.claim.email','${email}',false);`);
const rpc = async (sql) => (await db.query(sql)).rows[0];

await setUser(owner, "owner@gmail.com");
const invite1 = await rpc(`select public.team_invite_user('${business.id}','freelancer@gmail.com','freelancer') as result`);
assert.equal(invite1.result.alreadyMember, false);
assert.equal(invite1.result.userExists, true);
const invite2 = await rpc(`select public.team_invite_user('${business.id}','agent@gmail.com','agent') as result`);
assert.equal(invite2.result.role, "agent");
const search = await rpc(`select public.team_search_by_email('${business.id}','FREELANCER@gmail.com') as result`);
assert.equal(search.result[0].userId, freelancer, "exact case-insensitive email search finds the registered profile");

await setUser(freelancer, "freelancer@gmail.com");
const mine = await rpc("select public.team_my_invitations() as result");
assert.equal(mine.result.length, 1, "an invite is visible only for its exact signed-in email");
await rpc(`select public.team_accept_invite('${invite1.result.inviteId}') as result`);
const businessForMember = await rpc("select public.team_accessible_businesses() as result");
assert.equal(businessForMember.result[0].id, business.id, "accepted freelancer gets team workspace access without owning a business");
const role = await rpc("select public.team_update_my_profile('Freelancer One','agent') as result");
assert.equal(role.result.memberType, "agent", "member can edit their descriptive profile role");

await setUser(agent, "agent@gmail.com");
await rpc(`select public.team_accept_invite('${invite2.result.inviteId}') as result`);
await setUser(owner, "owner@gmail.com");
const direct = await rpc(`select public.team_chat_start('${business.id}', array['${freelancer}'::uuid], null) as result`);
assert.equal(direct.result.kind, "direct");
await rpc(`select public.team_chat_send('${direct.result.conversationId}','Hello team', '[]'::jsonb) as result`);
await rpc(`select public.team_chat_send('${direct.result.conversationId}','', '[{"path":"${direct.result.conversationId}/${owner}/attachment.pdf","name":"brief.pdf","mime":"application/pdf","size":1024}]'::jsonb) as result`);
const directThread = await rpc(`select public.team_chat_thread('${direct.result.conversationId}',200) as result`);
assert.equal(directThread.result.messages.length, 2, "direct chat stores text and PDF metadata");
assert.equal(directThread.result.messages[1].attachments[0].mime, "application/pdf");

const group = await rpc(`select public.team_chat_start('${business.id}', array['${freelancer}'::uuid,'${agent}'::uuid], 'Launch team') as result`);
assert.equal(group.result.kind, "group");
const listing = await rpc(`select public.team_chat_list('${business.id}') as result`);
assert.equal(listing.result.length, 2, "member sees only team conversations");
let denied = false;

await setUser(owner, "owner@gmail.com");
await rpc(`select public.team_revoke_member('${business.id}','${invite1.result.inviteId}') as result`);
await setUser(freelancer, "freelancer@gmail.com");
denied = false;
try { await rpc(`select public.team_chat_thread('${direct.result.conversationId}',200)`); }
catch (error) { denied = /not a member|42501|access/i.test(error.message); }
assert.equal(denied, true, "revoking team membership also removes access to prior conversations");

await setUser("44444444-4444-4444-8444-444444444444", "outside@gmail.com");
denied = false;
try { await rpc(`select public.team_chat_thread('${direct.result.conversationId}',200)`); }
catch (error) { denied = /not a member|42501|access/i.test(error.message); }
assert.equal(denied, true, "a non-member cannot open the conversation");

await db.exec("reset role; set role service_role;");
const requestKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const announcementSql = `select public.admin_create_announcement('${owner}','Maintenance notice','Service returns at 2 AM.','all','${requestKey}') as result`;
const firstAnnouncement = await rpc(announcementSql);
const retryAnnouncement = await rpc(announcementSql);
assert.equal(firstAnnouncement.result.announcement.id, retryAnnouncement.result.announcement.id, "retry reuses the original announcement");
assert.equal(retryAnnouncement.result.duplicate_request, true);
const delivery = await db.query(`select count(*)::int as n, count(distinct user_id)::int as recipients from public.notifications where meta->>'announcement_id'='${firstAnnouncement.result.announcement.id}'`);
const { rows: profileCount } = await db.query("select count(*)::int as n from public.profiles");
assert.equal(delivery.rows[0].n, profileCount[0].n, "one notification is created for each recipient");
assert.equal(delivery.rows[0].recipients, profileCount[0].n, "recipient fan-out has no duplicate users");

await setUser(owner, "owner@gmail.com");
await db.exec("update public.notifications set read_at=now() where user_id=auth.uid() and read_at is null");
const ownUnread = await rpc(`select count(*)::int as n from public.notifications where user_id='${owner}' and read_at is null`);
await db.exec("reset role; set role service_role;");
const othersUnread = await rpc(`select count(*)::int as n from public.notifications where user_id<>'${owner}' and read_at is null`);
assert.equal(ownUnread.n, 0, "mark-all read persists for the caller");
assert.ok(othersUnread.n > 0, "mark-all does not mark another user's notifications read");

console.log("  ✓ collaboration database: invites, email matching, team scoping, direct/group chat, media metadata, idempotent announcements and persistent per-user read state");
await db.close();
