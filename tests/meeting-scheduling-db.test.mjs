/* ==========================================================================
   Meeting scheduling (P8, 0057) — behaviour in PGlite
   Replays every migration, then checks the scheduling rules the browser shows:
     - a meeting can be booked for a future time and gets a code and link
     - a time in the past, or more than a year ahead, is refused
     - a signed-out caller is refused
     - upcoming lists only the caller's own bookings, soonest first, and drops
       meetings that ended or passed more than a day ago
     - the host can join the booked meeting early, and a locked one still refuses
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
for (const file of migrationFiles()) await apply(db, file);

const ids = {
  host: "00000000-0000-4000-8000-0000000000e1",
  guest: "00000000-0000-4000-8000-0000000000e2"
};
for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}

await db.exec(`grant usage on schema public to authenticated, anon;`);
const asUser = async (uid) =>
  db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); select set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated"}',false);`);
const asAnon = async () =>
  db.exec(`reset role; set role anon; select set_config('request.jwt.claim.sub','',false);`);
const asSystem = async () => db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`);

const errorCode = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error?.code || error?.message || "unknown";
  }
};
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

console.log("booking");
await asUser(ids.host);
const { rows: booked } = await db.query(`select public.meeting_schedule('Design review', 'video', $1::timestamptz) as r`, [inMinutes(60)]);
const meeting = booked[0].r;
check("a future booking returns an id, code and link", Boolean(meeting.id && meeting.code && meeting.joinUrl?.includes(meeting.code)));
check("the code is nine characters, as instant meetings are", /^[a-z0-9]{9}$/.test(meeting.code));
check("the title and kind are kept", meeting.title === "Design review" && meeting.kind === "video");

check("a time in the past is refused", (await errorCode(() => db.query(`select public.meeting_schedule('Late', 'video', $1::timestamptz)`, [inMinutes(-5)]))) === "22023");
check("a time less than a minute ahead is refused", (await errorCode(() => db.query(`select public.meeting_schedule('Soon', 'video', $1::timestamptz)`, [inMinutes(0.2)]))) === "22023");
check("a time more than a year ahead is refused", (await errorCode(() => db.query(`select public.meeting_schedule('Far', 'video', $1::timestamptz)`, [inMinutes(60 * 24 * 400)]))) === "22023");
check("no time at all is refused", (await errorCode(() => db.query(`select public.meeting_schedule('None', 'video', null::timestamptz)`))) === "22023");

await asAnon();
check("a signed-out caller is refused", (await errorCode(() => db.query(`select public.meeting_schedule('Anon', 'video', $1::timestamptz)`, [inMinutes(60)]))) !== null);

await asUser(ids.guest);
const { rows: guestBooks } = await db.query(`select public.meeting_schedule('Guest booking', 'voice', $1::timestamptz) as r`, [inMinutes(120)]);
check("any signed-in user may book their own meeting", guestBooks[0].r.kind === "voice");

console.log("upcoming");
await asUser(ids.host);
const { rows: mine } = await db.query(`select r from public.meeting_upcoming(20) as r`);
check("the host sees their own booking", mine.some((row) => row.r.id === meeting.id));
check("the host does not see another person's booking", !mine.some((row) => row.r.title === "Guest booking"));

await asUser(ids.guest);
const { rows: theirs } = await db.query(`select r from public.meeting_upcoming(20) as r`);
check("another user sees only their own bookings", theirs.length === 1 && theirs[0].r.title === "Guest booking");

await asSystem();
await db.query(`insert into public.meetings (code, title, kind, host_id, scheduled_for) values ('oldmeet01', 'Old', 'video', $1, now() - interval '3 days')`, [ids.host]);
await db.query(`insert into public.meetings (code, title, kind, host_id, scheduled_for, ended_at) values ('endedmt01', 'Ended', 'video', $1, now() + interval '2 hours', now())`, [ids.host]);
await db.query(`insert into public.meetings (code, title, kind, host_id, scheduled_for) values ('laterm001', 'Later', 'video', $1, now() + interval '5 hours')`, [ids.host]);
await asUser(ids.host);
const { rows: order } = await db.query(`select r->>'title' as t from public.meeting_upcoming(20) as r`);
const titles = order.map((row) => row.t);
check("a meeting that passed more than a day ago is dropped", !titles.includes("Old"));
check("an ended meeting is dropped", !titles.includes("Ended"));
check("upcoming is soonest first", titles.indexOf("Design review") < titles.indexOf("Later"), titles.join(", "));

console.log("joining");
await asSystem();
await db.query(`update public.meetings set is_locked = false, ended_at = null where code = $1`, [meeting.code]);
await asUser(ids.guest);
check("a guest may join the booked meeting before it starts", (await errorCode(() => db.query(`select public.meeting_join($1)`, [meeting.code]))) === null);
await asSystem();
await db.query(`update public.meetings set is_locked = true where code = $1`, [meeting.code]);
await asUser(ids.guest);
check("a locked booking still refuses a guest", (await errorCode(() => db.query(`select public.meeting_join($1)`, [meeting.code]))) !== null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
