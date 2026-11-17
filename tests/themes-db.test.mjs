/* ==========================================================================
   Theme collections (0059, replaced by 0078: Glow and Elite) — behaviour, in PGlite
   --------------------------------------------------------------------------
   Replays every migration into an in-process PostgreSQL, then checks:
     - the retired 0059 collections are inactive and offer nothing to choose
     - a free member sees Glow and Elite locked, with preview addresses, and
       cannot apply any of their wallpapers
     - a Glow member unlocks Glow only; an Elite member unlocks Elite and Glow
     - a choice is refused when the caller's tier does not cover it
     - an inactive wallpaper cannot be chosen
     - a tier change keeps the saved choice, and the catalog reports it locked
     - a saved choice on a retired wallpaper falls back to the default
     - members see only their own choice
     - the browser cannot read or write the tables, and anon cannot call the RPCs
     - the URL and id constraints refuse bad input
   Uses the same scaffold and replay path as premium-db.test.mjs.
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

const ids = {
  free: "00000000-0000-4000-8000-0000000000f1",
  glow: "00000000-0000-4000-8000-0000000000a2",
  elite: "00000000-0000-4000-8000-0000000000a3",
  other: "00000000-0000-4000-8000-0000000000b4"
};

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}

const asUser = async (userId) => {
  await db.exec(`
    reset role;
    set role authenticated;
    select set_config('request.jwt.claim.sub','${userId}',false);
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claims','{"sub":"${userId}","role":"authenticated"}',false);
  `);
};
const asAnon = async () => {
  await db.exec(`
    reset role;
    set role anon;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claims','{"role":"anon"}',false);
  `);
};
const asSystem = async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claims','{"role":"service_role"}',false);
  `);
};

/* True only when the operation fails with the expected SQLSTATE. A broken query
   (wrong column, missing table) fails with some other code and does not count. */
const refused = async (fn, code = "42501") => {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
};

const catalog = async () => {
  const rows = await q(`select public.theme_catalog() as c`);
  return rows[0].c;
};
const collection = (cat, id) => cat.collections.find((c) => c.id === id);
const wallpaperId = async (title) => (await q(`select id from public.theme_wallpapers where title = $1`, [title]))[0].id;
let glowPick = null;
let elitePick = null;
let retired = null;

console.log("seed");
await asSystem();
const counts = await q(`select
  (select count(*)::int from public.theme_collections where active) as active_collections,
  (select count(*)::int from public.theme_collections where not active) as retired_collections,
  (select count(*)::int from public.theme_wallpapers where active) as active_wallpapers,
  (select count(*)::int from public.theme_wallpapers where not active) as retired_wallpapers`);
check("exactly two collections are active", counts[0].active_collections === 2, JSON.stringify(counts[0]));
check("the four 0059 collections are retired, not deleted", counts[0].retired_collections === 4, JSON.stringify(counts[0]));
check("eight wallpapers are active, four per collection", counts[0].active_wallpapers === 8, JSON.stringify(counts[0]));
check("the retired wallpapers are kept", counts[0].retired_wallpapers >= 8, JSON.stringify(counts[0]));

const tiers = await q(`select id, required_tier from public.theme_collections where active order by sort_order`);
check(
  "Glow needs the glow tier; Elite needs the elite tier",
  JSON.stringify(tiers.map((t) => [t.id, t.required_tier])) === JSON.stringify([["glow", "glow"], ["elite", "elite"]]),
  JSON.stringify(tiers)
);

console.log("free member");
glowPick = await wallpaperId("Glow I · Glass home");
elitePick = await wallpaperId("Elite I · Violet analytics");
retired = (await q(`select id from public.theme_wallpapers where not active limit 1`))[0].id;
await asUser(ids.free);
let cat = await catalog();
check("a free member sees exactly the two collections", cat.collections.length === 2);
check("both collections are locked for a free member", cat.collections.every((c) => c.locked === true));
check("a locked collection still shows preview addresses", cat.collections.every((c) => c.wallpapers.every((w) => typeof w.imageUrl === "string")));
check("every locked wallpaper is marked preview-only", cat.collections.every((c) => c.wallpapers.every((w) => w.previewOnly === true)));
check("a free member has no tier", cat.tier === null);
check("a free member cannot apply a Glow wallpaper", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [glowPick]), "42501"));
check("a free member cannot apply an Elite wallpaper", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [elitePick]), "42501"));
check("a retired wallpaper cannot be applied", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [retired]), "P0002"));

console.log("glow member");
await asSystem();
await db.query(`insert into public.profile_entitlements (user_id, tier) values ($1, 'glow') on conflict (user_id) do update set tier = 'glow'`, [ids.glow]);
await asUser(ids.glow);
cat = await catalog();
check("a Glow member's tier is glow", cat.tier === "glow");
check("Glow is unlocked for Glow", collection(cat, "glow").locked === false);
check("Elite stays locked for Glow", collection(cat, "elite").locked === true);
check("an unlocked collection shows its image URLs", collection(cat, "glow").wallpapers.every((w) => typeof w.imageUrl === "string" && w.previewOnly === false));
check("a locked Elite collection shows previews for Glow", collection(cat, "elite").wallpapers.every((w) => typeof w.imageUrl === "string" && w.previewOnly === true));
const chose = await db.query(`select public.theme_set_wallpaper($1) as r`, [glowPick]);
check("Glow can apply a Glow wallpaper", chose.rows[0].r.ok === true);
cat = await catalog();
check("the saved choice is reported back", cat.chosenWallpaperId === glowPick);
check("a Glow member cannot apply an Elite wallpaper", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [elitePick]), "42501"));

console.log("elite member");
await asSystem();
await db.query(`insert into public.profile_entitlements (user_id, tier) values ($1, 'elite') on conflict (user_id) do update set tier = 'elite'`, [ids.elite]);
await asUser(ids.elite);
cat = await catalog();
check("Elite unlocks both collections", cat.collections.every((c) => c.locked === false));
check("Elite includes the Glow collection", collection(cat, "glow").locked === false);
check("Elite can apply an Elite wallpaper", (await db.query(`select public.theme_set_wallpaper($1) as r`, [elitePick])).rows[0].r.ok === true);
check("Elite can apply a Glow wallpaper", (await db.query(`select public.theme_set_wallpaper($1) as r`, [glowPick])).rows[0].r.ok === true);

console.log("privacy and access");
await asUser(ids.glow);
cat = await catalog();
check("a member's choice is not visible to another member", cat.chosenWallpaperId === glowPick);
await asUser(ids.other);
cat = await catalog();
check("another member sees no choice of their own", cat.chosenWallpaperId === null);
check("another member is a free member", cat.tier === null);
check("a free member cannot read the wallpaper table directly", await refused(() => db.query(`select count(*) from public.theme_wallpapers`)));
check("a member cannot read the collection table directly", await refused(() => db.query(`select count(*) from public.theme_collections`)));
check("a member cannot write a choice directly", await refused(() => db.query(`insert into public.profile_theme_choices (user_id, wallpaper_id) values ($1, $2)`, [ids.other, glowPick])));
check("a member cannot read the choice table directly", await refused(() => db.query(`select count(*) from public.profile_theme_choices`)));
check("an unknown wallpaper is refused", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [ids.other.replace(/b4$/, "ff")]), "P0002"));
await asAnon();
check("anon cannot call the catalog", await refused(() => db.query(`select public.theme_catalog()`)));
check("anon cannot apply a wallpaper", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [glowPick])));

console.log("changes by the admin function");
await asSystem();
await db.query(`update public.theme_wallpapers set active = false where id = $1`, [glowPick]);
await asUser(ids.glow);
check("an inactive wallpaper cannot be applied", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [glowPick]), "P0002"));
cat = await catalog();
check("an inactive wallpaper leaves the catalog", !collection(cat, "glow").wallpapers.some((w) => w.id === glowPick));
await asSystem();
await db.query(`update public.theme_wallpapers set active = true where id = $1`, [glowPick]);
await db.query(`update public.theme_collections set required_tier = 'elite' where id = 'glow'`);
await asUser(ids.glow);
cat = await catalog();
check("raising a tier locks the collection for a member who chose it", collection(cat, "glow").locked === true);
check("raising a tier keeps the saved choice", cat.chosenWallpaperId === glowPick);
check("a locked saved choice cannot be re-applied", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [glowPick])));
await asSystem();
await db.query(`update public.theme_collections set required_tier = 'glow' where id = 'glow'`);

console.log("retired wallpapers");
await asSystem();
await db.query(`update public.profile_theme_choices set wallpaper_id = $2 where user_id = $1`, [ids.glow, retired]);
await asUser(ids.glow);
cat = await catalog();
check("a saved choice on a retired wallpaper is not in the catalog", !cat.collections.some((c) => c.wallpapers.some((w) => w.id === cat.chosenWallpaperId)));
check("a retired wallpaper cannot be re-applied", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [retired]), "P0002"));
await db.query(`select public.theme_clear_wallpaper()`);

console.log("clearing and input rules");
await asUser(ids.glow);
await db.query(`select public.theme_set_wallpaper($1)`, [glowPick]);
await db.query(`select public.theme_clear_wallpaper()`);
cat = await catalog();
check("clearing the wallpaper removes the choice", cat.chosenWallpaperId === null);
await asSystem();
const rows = await q(`select count(*)::int as n from public.profile_theme_choices where user_id = $1`, [ids.glow]);
check("the choice row is gone after clearing", rows[0].n === 0);
check(
  "a non-https, non-local image is refused",
  await refused(() => db.query(
    `insert into public.theme_wallpapers (collection_id, title, image_url) values ('glow', 'Bad link', 'javascript:alert(1)')`
  ), "23514")
);
check(
  "a plain http image is refused",
  await refused(() => db.query(
    `insert into public.theme_wallpapers (collection_id, title, image_url) values ('glow', 'Plain link', 'http://example.com/a.png')`
  ), "23514")
);
check(
  "an https image is accepted",
  !(await refused(() => db.query(
    `insert into public.theme_wallpapers (collection_id, title, image_url) values ('glow', 'Remote art', 'https://cdn.example.com/a.png')`
  ), "23514"))
);
check(
  "a collection id with capitals is refused",
  await refused(() => db.query(`insert into public.theme_collections (id, name) values ('Bad Id', 'Bad')`), "23514")
);

console.log("admin audit");
await asSystem();
const adminId = "00000000-0000-4000-8000-0000000000c5";
await db.query(`insert into auth.users (id, email) values ($1, 'admin@test.local') on conflict (id) do nothing`, [adminId]);
await db.query(`insert into public.admin_users (user_id, email, role) values ($1, 'admin@test.local', 'admin') on conflict (user_id) do update set role = 'admin'`, [adminId]);
const auditRow = await q(
  `select public.theme_admin_audit($1, 'theme_collection_update', 'theme_collections', null, 'Test change', '{"id":"glow"}'::jsonb, '{"id":"glow"}'::jsonb) as id`,
  [adminId]
);
const stored = await q(`select actor_id, actor_email, actor_role, action, reason from public.admin_audit where id = $1`, [auditRow[0].id]);
check("an administrator's theme change is recorded with the actor", stored[0]?.actor_id === adminId && stored[0]?.actor_role === "admin", JSON.stringify(stored[0]));
check("the audit row keeps the action and reason", stored[0]?.action === "theme_collection_update" && stored[0]?.reason === "Test change");
check(
  "a member cannot write an audit row as themselves",
  await refused(() => db.query(`select public.theme_admin_audit($1, 'x', 'theme_collections', null, 'x', null, null)`, [ids.other]), "42501")
);
check(
  "an unknown actor cannot write an audit row",
  await refused(() => db.query(`select public.theme_admin_audit($1, 'x', 'theme_collections', null, 'x', null, null)`, [adminId.replace(/c5$/, "ee")]), "42501")
);
await asUser(ids.glow);
check(
  "a member cannot call the audit function",
  await refused(() => db.query(`select public.theme_admin_audit($1, 'x', 'theme_collections', null, 'x', null, null)`, [adminId]))
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
