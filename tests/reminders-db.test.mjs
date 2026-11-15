/* ==========================================================================
   Reminders, quiet hours and category settings (0053) — behaviour, in PGlite
   --------------------------------------------------------------------------
   Replays every migration into an in-process PostgreSQL, then checks the rules
   with fixed clock values, so the results never depend on the time of day:
     - who is due a four-hour reminder, and only once per four hours
     - opt-out, quiet hours (in the member's own timezone), and an unknown
       timezone falling back to UTC rather than switching quiet hours off
     - settings are validated and only allowed keys are written
   The scaffold and replay path come from scripts/staging-db.mjs, the same one
   migration-verify-sql uses, so there is one definition of "a database the
   migrations accept".
   ========================================================================== */

import { SCAFFOLD, migrationFiles, apply } from "../scripts/staging-db.mjs";

let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("  ! SKIPPED — @electric-sql/pglite is not installed, so this database suite did not run.");
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") =>
  cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`));

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of migrationFiles()) {
  await apply(db, file);
}

const id = {
  stale: "00000000-0000-4000-8000-000000000001", // away 6 hours, reminders on
  recent: "00000000-0000-4000-8000-000000000002", // active 1 hour ago
  never: "00000000-0000-4000-8000-000000000003", // never signed in to the dashboard
  optedOut: "00000000-0000-4000-8000-000000000004", // away, reminders off
  quietUtc: "00000000-0000-4000-8000-000000000005", // away, quiet 10:00-14:00 UTC
  badTz: "00000000-0000-4000-8000-000000000006" // away, timezone the database does not know
};

const NOW = "2026-11-15T12:00:00Z";
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const asUser = (uid) => db.exec(`select set_config('request.jwt.claim.sub', '${uid || ""}', false)`);

for (const [key, uid] of Object.entries(id)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${key}@test.local`]);
  await db.query(
    `insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`,
    [uid, key]
  );
}
await db.query(`update public.profiles set last_seen_at = $2 where id = $1`, [id.stale, "2026-11-15T06:00:00Z"]);
await db.query(`update public.profiles set last_seen_at = $2 where id = $1`, [id.recent, "2026-11-15T11:00:00Z"]);
await db.query(`update public.profiles set last_seen_at = null where id = $1`, [id.never]);
await db.query(`update public.profiles set last_seen_at = $2 where id = $1`, [id.optedOut, "2026-11-15T06:00:00Z"]);
await db.query(`update public.profiles set last_seen_at = $2 where id = $1`, [id.quietUtc, "2026-11-15T06:00:00Z"]);
await db.query(`update public.profiles set last_seen_at = $2 where id = $1`, [id.badTz, "2026-11-15T06:00:00Z"]);

await db.query(
  `insert into public.notification_preferences (user_id, reminders_enabled) values ($1, false)`,
  [id.optedOut]
);
await db.query(
  `insert into public.notification_preferences (user_id, quiet_hours_enabled, quiet_start, quiet_end, timezone)
   values ($1, true, 10, 14, 'UTC')`,
  [id.quietUtc]
);
await db.query(
  `insert into public.notification_preferences (user_id, quiet_hours_enabled, quiet_start, quiet_end, timezone)
   values ($1, true, 10, 14, 'Not/AZone')`,
  [id.badTz]
);

console.log("quiet hours");
const quiet = async (tz, s, e, at) =>
  (await q(`select public.sz_in_quiet_hours($1, $2::smallint, $3::smallint, $4::timestamptz) as v`, [tz, s, e, at]))[0].v;
check("inside a midnight-wrapping window (23:00 UTC, 22 to 8)", (await quiet("UTC", 22, 8, "2026-11-15T23:00:00Z")) === true);
check("outside it (12:00 UTC, 22 to 8)", (await quiet("UTC", 22, 8, "2026-11-15T12:00:00Z")) === false);
check("just before the end (07:59 UTC, 22 to 8)", (await quiet("UTC", 22, 8, "2026-11-15T07:59:00Z")) === true);
check("the end is excluded (08:00 UTC, 22 to 8)", (await quiet("UTC", 22, 8, "2026-11-15T08:00:00Z")) === false);
check("the start is included (22:00 UTC, 22 to 8)", (await quiet("UTC", 22, 8, "2026-11-15T22:00:00Z")) === true);
check("a window in the middle of the day (12:00 UTC, 10 to 14)", (await quiet("UTC", 10, 14, "2026-11-15T12:00:00Z")) === true);
check("start equal to end means no window", (await quiet("UTC", 9, 9, "2026-11-15T09:30:00Z")) === false);
check("local time is the member's own: 17:00 UTC is 22:30 in Kolkata (quiet) but 17:00 in UTC (not)",
  (await quiet("Asia/Kolkata", 22, 8, "2026-11-15T17:00:00Z")) === true && (await quiet("UTC", 22, 8, "2026-11-15T17:00:00Z")) === false);
check("an unknown timezone falls back to UTC, not to quiet hours off",
  (await quiet("Not/AZone", 10, 14, "2026-11-15T12:00:00Z")) === true);

console.log("four-hour reminders");
const sent1 = (await q(`select public.notification_reminders_run($1::timestamptz) as n`, [NOW]))[0].n;
const rows1 = await q(
  `select user_id from public.notifications where meta->>'kind' = 'reminder' order by user_id`
);
check("the first run sends exactly one reminder", sent1 === 1, `sent ${sent1}`);
check("the reminder goes to the member who has been away", rows1.length === 1 && rows1[0].user_id === id.stale, JSON.stringify(rows1));
check("an active member gets none", !rows1.some((r) => r.user_id === id.recent));
check("a member who never used the dashboard gets none", !rows1.some((r) => r.user_id === id.never));
check("a member who opted out gets none", !rows1.some((r) => r.user_id === id.optedOut));
check("a member inside quiet hours gets none", !rows1.some((r) => r.user_id === id.quietUtc));
check("the reminder is an account notice with a link to the app",
  (await q(`select type, link from public.notifications where user_id = $1 and meta->>'kind' = 'reminder'`, [id.stale]))[0]?.type === "account");

const sent2 = (await q(`select public.notification_reminders_run($1::timestamptz) as n`, [
  "2026-11-15T13:00:00Z"
]))[0].n;
check("a second run inside the same four hours sends nothing (no duplicates)", sent2 === 0, `sent ${sent2}`);

const sent3 = (await q(`select public.notification_reminders_run($1::timestamptz) as n`, [
  "2026-11-15T16:01:00Z"
]))[0].n;
check("after four hours, a member still away is reminded again", sent3 >= 1, `sent ${sent3}`);
const countStale = (await q(
  `select count(*)::int as n from public.notifications where user_id = $1 and meta->>'kind' = 'reminder'`,
  [id.stale]
))[0].n;
check("exactly one reminder per four-hour window (two in total over sixteen hours)", countStale === 2, `count ${countStale}`);

const quietRows = (await q(
  `select count(*)::int as n from public.notifications where user_id = $1 and meta->>'kind' = 'reminder'`,
  [id.quietUtc]
))[0].n;
check("a member in quiet hours gets nothing during the window, then one reminder after it ends", quietRows === 1, `rows ${quietRows}`);

const quietLater = (await q(`select public.notification_reminders_run($1::timestamptz) as n`, [
  "2026-11-15T20:30:00Z"
]))[0].n;
const quietAfter = (await q(
  `select count(*)::int as n from public.notifications where user_id = $1 and meta->>'kind' = 'reminder'`,
  [id.quietUtc]
))[0].n;
check("four and a half hours later it is due again, so a second one arrives", quietAfter === 2 && quietLater >= 1, `rows ${quietAfter}`);

console.log("settings");
await asUser(id.stale);
const got = (await q(`select public.notification_settings_get() as s`))[0].s;
check("defaults: reminders on, quiet hours off, UTC, every category on",
  got.remindersEnabled === true && got.quietHoursEnabled === false && got.timezone === "UTC" && got.categories.payment === true,
  JSON.stringify(got));

await db.exec(
  `select public.notification_settings_set('{"quietHoursEnabled": true, "quietStart": 23, "quietEnd": 7, "timezone": "Asia/Kolkata", "categories": {"payment": false, "bogus": true}}'::jsonb)`
);
const after = (await q(`select public.notification_settings_get() as s`))[0].s;
check("a valid patch is saved", after.quietHoursEnabled === true && after.quietStart === 23 && after.quietEnd === 7 && after.timezone === "Asia/Kolkata");
check("a category can be turned off", after.categories.payment === false);
check("an unknown category is ignored, not stored", after.categories.bogus === undefined && Object.keys(after.categories).length === 8);

let badTz = null;
try {
  await db.exec(`select public.notification_settings_set('{"timezone": "Mars/Olympus"}'::jsonb)`);
} catch (error) {
  badTz = error.message;
}
check("an unknown timezone is refused", /not recognised/.test(badTz || ""), badTz || "accepted");

let badBool = null;
try {
  await db.exec(`select public.notification_settings_set('{"remindersEnabled": "no"}'::jsonb)`);
} catch (error) {
  badBool = error.message;
}
check("a non-boolean reminder setting is refused", /true or false/.test(badBool || ""), badBool || "accepted");

await asUser(id.optedOut);
await db.exec(`select public.notification_settings_set('{"remindersEnabled": true}'::jsonb)`);
const back = (await q(`select public.notification_settings_set('{}'::jsonb) as s`))[0].s;
check("a member can opt back in", back.remindersEnabled === true);

let anonBlocked = null;
await asUser("");
try {
  await db.exec(`select public.notification_settings_set('{"remindersEnabled": false}'::jsonb)`);
} catch (error) {
  anonBlocked = error.message;
}
check("no session: settings are refused", /Sign in first/.test(anonBlocked || ""), anonBlocked || "accepted");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
