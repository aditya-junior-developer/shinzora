/* ==========================================================================
   Presence, direct messages, referrals — the rules that must not drift
   --------------------------------------------------------------------------
   Three features that are easy to get subtly wrong and hard to notice:

     presence   one definition of "active", or the team list and the admin list
                disagree about the same person
     messages   a personal thread must be reachable by username and only by its
                two members; the support channel is gone from the inbox
     referrals  ten credits a month for three months, once per account, never
                your own code

   The SQL half is checked against the migration text (the staging harness runs
   the real thing); the presence arithmetic is checked directly.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { presenceState, presenceDot, presenceLabel, avatarWithPresence, ACTIVE_WINDOW_MS, RECENT_WINDOW_MS } from "../public/js/ui/presence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(repo, rel), "utf8");

const T0 = Date.parse("2026-11-04T10:00:00Z");
const at = (secondsAgo) => new Date(T0 - secondsAgo * 1000).toISOString();

/* ------------------------------------------------------------------ presence */

test("green, amber, gone — with the boundaries the user asked for", () => {
  assert.equal(presenceState(at(0), T0), "active");
  assert.equal(presenceState(at(60), T0), "active");
  assert.equal(presenceState(at(89), T0), "active");
  /* Just past the heartbeat window: recently seen, not active. */
  assert.equal(presenceState(at(Math.ceil(ACTIVE_WINDOW_MS / 1000) + 1), T0), "recent");
  /* Three minutes is the outer edge of "recently". */
  assert.equal(presenceState(at(179), T0), "recent");
  assert.equal(presenceState(at(181), T0), "offline");
  assert.equal(presenceState(null, T0), "offline");
  assert.equal(presenceState("not a date", T0), "offline");
  assert.ok(ACTIVE_WINDOW_MS < RECENT_WINDOW_MS);
});

test("a clock that is slightly ahead is active, not offline", () => {
  const future = new Date(T0 + 5000).toISOString();
  assert.equal(presenceState(future, T0), "active");
});

test("the dot carries its state in the markup, not only in colour", () => {
  const active = presenceDot(at(10), { now: T0, size: 9 });
  assert.match(active, /presence-active/);
  assert.match(active, /data-presence="active"/);
  assert.match(active, /aria-label="Active now"/);
  assert.match(active, /width:9px/);

  assert.match(presenceDot(at(120), { now: T0 }), /presence-recent/);
  const offline = presenceDot(null, { now: T0 });
  assert.match(offline, /presence-offline/);
  assert.match(offline, /aria-label="Offline"/);
  assert.equal(presenceLabel("offline"), "Offline");
});

test("an avatar puts the dot under-left of the picture", () => {
  const html = avatarWithPresence({ name: "Manglam Pandey", lastSeenAt: at(5), now: T0, size: 36 });
  assert.match(html, /presence-avatar/);
  assert.match(html, /MP/);
  assert.match(html, /presence-active/);
  const css = read("public/css/theme-light.css");
  assert.match(css, /\.presence-avatar \.presence\s*\{[^}]*left:\s*-1px[^}]*bottom:\s*-1px/s);
});

/* ------------------------------------------------------------------ database */

test("a personal conversation is allowed to have no business", () => {
  const sql = read("supabase/migrations/0030_presence_dm_and_referrals.sql");
  assert.match(sql, /alter table public\.team_conversations alter column business_id drop not null/);
  /* Membership alone is the permission for a personal thread... */
  assert.match(sql, /c\.business_id is null or public\.is_business_team_member\(c\.business_id, p_user\)/);
  /* ...and the send path uses it rather than re-deriving access. */
  assert.match(sql, /create or replace function public\.team_chat_send/);
  assert.match(sql, /not public\.is_team_conversation_member\(p_conversation, actor\)/);
});

test("search is by handle and name, never by email", () => {
  const sql = read("supabase/migrations/0030_presence_dm_and_referrals.sql");
  const fn = sql.slice(sql.indexOf("function public.dm_search_people"), sql.indexOf("function public.dm_start"));
  assert.match(fn, /lower\(p\.username\) like q \|\| '%'/);
  assert.match(fn, /lower\(coalesce\(p\.full_name, ''\)\) like/);
  assert.doesNotMatch(fn, /email/);
  /* A handle is required: an account with no handle is not findable. */
  assert.match(fn, /coalesce\(p\.username, ''\) <> ''/);
});

test("opening a direct message is idempotent and refuses yourself", () => {
  const sql = read("supabase/migrations/0030_presence_dm_and_referrals.sql");
  const fn = sql.slice(sql.indexOf("function public.dm_start"), sql.indexOf("function public.dm_inbox"));
  assert.match(fn, /where c\.business_id is null/);
  assert.match(fn, /count\(\*\) from public\.team_conversation_members x where x\.conversation_id = c\.id\) = 2/);
  assert.match(fn, /You cannot message yourself/);
  assert.match(fn, /No member uses that username/);
});

test("the inbox shows one list of personal and team conversations", () => {
  const sql = read("supabase/migrations/0030_presence_dm_and_referrals.sql");
  const fn = sql.slice(sql.indexOf("function public.dm_inbox"), sql.indexOf("function public.team_chat_thread"));
  assert.match(fn, /'kind', case when c\.business_id is null then 'personal' else c\.kind end/);
  /* A business room the caller was removed from is not in their inbox. */
  assert.match(fn, /where c\.business_id is null or public\.is_business_team_member\(c\.business_id, actor\)/);
  assert.match(fn, /'lastSeenAt', peer\.last_seen_at/);
});

test("the heartbeat writes only the caller's row, and presence is readable", () => {
  const sql = read("supabase/migrations/0030_presence_dm_and_referrals.sql");
  const fn = sql.slice(sql.indexOf("function public.presence_touch"), sql.indexOf("function public.presence_for"));
  assert.match(fn, /update public\.profiles set last_seen_at = stamped where id = actor/);
  assert.match(sql, /grant execute on function public\.presence_touch\(\) to authenticated/);
  assert.match(sql, /revoke all on function public\.presence_touch\(\) from public, anon/);
});

/* ----------------------------------------------------------------- referrals */

test("a referral is ten credits a month for three months, once per account", () => {
  const sql = read("supabase/migrations/0030_presence_dm_and_referrals.sql");
  assert.match(sql, /bonus_credits int not null default 10/);
  assert.match(sql, /months_total int not null default 3/);
  assert.match(sql, /unique \(referee_id\)/);
  assert.match(sql, /check \(referee_id <> referrer_id\)/);
  assert.match(sql, /You cannot redeem your own code/);
  assert.match(sql, /You have already redeemed a referral code/);
  /* Both sides are credited, and the limit is what the AI function reads. */
  assert.match(sql, /ai_credits_limit = coalesce\(ai_credits_limit, 30\) \+ row_ref\.bonus_credits/);
  assert.match(sql, /perform public\.referral_grant_one\(created\.id, 'referrer'\)/);
});

test("the later months are granted by a tick, not by a promise", () => {
  const sql = read("supabase/migrations/0030_presence_dm_and_referrals.sql");
  assert.match(sql, /create or replace function public\.referral_bonus_tick/);
  assert.match(sql, /where r\.months_granted < r\.months_total/);
  const boot = read("public/js/ui/heartbeat.js");
  assert.match(boot, /referral_bonus_tick/);
});

/* ------------------------------------------------------------------ surfaces */

test("Messages is one inbox: the support channel is gone", () => {
  const view = read("public/js/modules/dashboard/views/messages.js");
  /* Strip the block comment: the file explains what was removed, which is not
     the same as still offering it. */
  const code = view.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /Shinzora support/);
  assert.doesNotMatch(view, /data-channel/);
  assert.match(view, /mountInbox/);
  const inbox = read("public/js/modules/messaging/team-chat.js");
  assert.match(inbox, /dm_inbox/);
  assert.match(inbox, /dm_search_people/);
  assert.match(inbox, /Find a member by username/);
});

test("a teammate can be messaged straight from their row", () => {
  const team = read("public/js/modules/dashboard/views/team.js");
  assert.match(team, /data-team-message/);
  assert.match(team, /dm_start/);
  assert.match(team, /view=messages&c=/);
});

test("the dashboard beats a heartbeat and stops when the tab is hidden", () => {
  const shell = read("public/js/modules/dashboard/shell.js");
  assert.match(shell, /startPresence\(\)/);
  const beat = read("public/js/ui/heartbeat.js");
  assert.match(beat, /document\.visibilityState === "visible"/);
  assert.match(beat, /pagehide/);
  /* A test environment with no client must not start a timer. */
  assert.match(beat, /typeof sb\?\.rpc !== "function"/);
});

test("three themes, one preference, applied before paint", () => {
  const app = read("public/app/index.html");
  assert.match(app, /localStorage\.getItem\("shinzora:theme"\)/);
  assert.match(app, /theme-light\.css/);
  assert.match(app, /data-tone/, "the pre-paint script sets the tone as well as the theme");

  const theme = read("public/js/ui/theme.js");
  assert.match(theme, /export function applyTheme/);
  for (const id of ["midnight", "blossom", "daylight"]) {
    assert.match(theme, new RegExp(`id: "${id}"`), `${id} is offered`);
  }

  /* Each theme is a token override, not a second stylesheet of components. */
  const light = read("public/css/theme-light.css");
  assert.match(light, /:root\[data-theme="blossom"\]/);
  assert.match(light, /:root\[data-theme="daylight"\]/);
  assert.match(light, /--base:\s*#fbf7f4/, "daylight is warm paper");
  assert.match(light, /--base:\s*#fdfbff/, "blossom is white, with a rose-violet cast");
  /* Neither light theme paints body text on pure white. */
  assert.doesNotMatch(light, /--base:\s*#ffffff/);
  /* Two light themes share one set of corrections. */
  assert.match(light, /:root\[data-tone="light"\] \.card/);
});

test("admin splits business accounts from freelancers, both with presence", () => {
  const shell = read("public/js/modules/admin/shell.js");
  assert.match(shell, /id: "freelancers"/);
  assert.match(shell, /views\/freelancers\.js/);

  const customers = read("public/js/modules/admin/views/customers.js");
  assert.match(customers, /account_type !== "agent"/);
  assert.match(customers, /presenceDot\(row\.last_seen_at/);

  const freelancers = read("public/js/modules/admin/views/freelancers.js");
  assert.match(freelancers, /account_type === "agent"/);
  assert.match(freelancers, /presenceDot\(row\.last_seen_at/);
});
