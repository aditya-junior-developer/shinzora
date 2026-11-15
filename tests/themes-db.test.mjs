/* ==========================================================================
   Theme collections (0059) — behaviour, in PGlite
   --------------------------------------------------------------------------
   Replays every migration into an in-process PostgreSQL, then checks:
     - a free member sees every collection locked, with no image URLs
     - a Glow member unlocks Glow collections only; Elite unlocks all of them
     - a choice is refused when the caller's tier does not cover it
     - an inactive wallpaper cannot be chosen
     - a tier change keeps the saved choice, and the catalog reports it locked
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
let petal = null;
let neon = null;

console.log("seed");
await asSystem();
const counts = await q(`select
  (select count(*)::int from public.theme_collections) as collections,
  (select count(*)::int from public.theme_wallpapers) as wallpapers`);
check("four collections are seeded", counts[0].collections === 4, JSON.stringify(counts[0]));
check("eight wallpapers are seeded, two per collection", counts[0].wallpapers === 8, JSON.stringify(counts[0]));

const tiers = await q(`select id, required_tier from public.theme_collections order by sort_order`);
check(
  "Anime and Ghibli-inspired need Glow; Cyberpunk and Trending 2026 need Elite",
  JSON.stringify(tiers.map((t) => [t.id, t.required_tier])) ===
    JSON.stringify([
      ["anime", "glow"],
      ["ghibli-inspired", "glow"],
      ["cyberpunk", "elite"],
      ["trending-2026", "elite"]
    ]),
  JSON.stringify(tiers)
);

console.log("free member");
petal = await wallpaperId("Petal sky");
neon = await wallpaperId("Neon grid");
await asUser(ids.free);
let cat = await catalog();
check("a free member sees all four collections", cat.collections.length === 4);
check("every collection is locked for a free member", cat.collections.every((c) => c.locked === true));
check("a locked collection carries no image URLs", cat.collections.every((c) => c.wallpapers.every((w) => w.imageUrl === null)));
check("a free member has no tier", cat.tier === null);
check(
  "a free member cannot choose an Anime wallpaper",
  await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [petal]), "42501")
);

console.log("glow member");
await asSystem();
await db.query(`insert into public.profile_entitlements (user_id, tier) values ($1, 'glow') on conflict (user_id) do update set tier = 'glow'`, [ids.glow]);
await asUser(ids.glow);
cat = await catalog();
check("a Glow member's tier is glow", cat.tier === "glow");
check("Anime is unlocked for Glow", collection(cat, "anime").locked === false);
check("Cyberpunk stays locked for Glow", collection(cat, "cyberpunk").locked === true);
check("an unlocked collection shows its image URLs", collection(cat, "anime").wallpapers.every((w) => typeof w.imageUrl === "string"));
check("a locked collection still hides its URLs for Glow", collection(cat, "cyberpunk").wallpapers.every((w) => w.imageUrl === null));

const chose = await db.query(`select public.theme_set_wallpaper($1) as r`, [petal]);
check("Glow can choose an Anime wallpaper", chose.rows[0].r.ok === true);
cat = await catalog();
check("the saved choice is reported back", cat.chosenWallpaperId === petal);
check("a Glow member cannot choose Cyberpunk", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [neon]), "42501"));

console.log("elite member");
await asSystem();
await db.query(`insert into public.profile_entitlements (user_id, tier) values ($1, 'elite') on conflict (user_id) do update set tier = 'elite'`, [ids.elite]);
await asUser(ids.elite);
cat = await catalog();
check("Elite unlocks every collection", cat.collections.every((c) => c.locked === false));
check("Elite includes Glow collections", collection(cat, "anime").locked === false);
check("Elite can choose a Cyberpunk wallpaper", (await db.query(`select public.theme_set_wallpaper($1) as r`, [neon])).rows[0].r.ok === true);

console.log("privacy and access");
await asUser(ids.glow);
cat = await catalog();
check("a member's choice is not visible to another member", cat.chosenWallpaperId === petal);
await asUser(ids.other);
cat = await catalog();
check("another member sees no choice of their own", cat.chosenWallpaperId === null);
check("another member is a free member", cat.tier === null);
check("a free member cannot read the wallpaper table directly", await refused(() => db.query(`select count(*) from public.theme_wallpapers`)));
check("a member cannot read the collection table directly", await refused(() => db.query(`select count(*) from public.theme_collections`)));
check("a member cannot write a choice directly", await refused(() => db.query(`insert into public.profile_theme_choices (user_id, wallpaper_id) values ($1, $2)`, [ids.other, petal])));
check("a member cannot read the choice table directly", await refused(() => db.query(`select count(*) from public.profile_theme_choices`)));
check("an unknown wallpaper is refused", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, ["00000000-0000-4000-8000-0000000000ff"]), "P0002"));

await asAnon();
check("anon cannot call the catalog", await refused(() => db.query(`select public.theme_catalog()`)));
check("anon cannot choose a wallpaper", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [petal])));

console.log("changes by the admin function");
await asSystem();
await db.query(`update public.theme_wallpapers set active = false where id = $1`, [petal]);
await asUser(ids.glow);
check("an inactive wallpaper cannot be chosen", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [petal]), "P0002"));
cat = await catalog();
check("an inactive wallpaper leaves the catalog", !collection(cat, "anime").wallpapers.some((w) => w.id === petal));
await asSystem();
await db.query(`update public.theme_wallpapers set active = true where id = $1`, [petal]);

await db.query(`update public.theme_collections set required_tier = 'elite' where id = 'anime'`);
await asUser(ids.glow);
cat = await catalog();
check("raising a tier locks the collection for a member who chose it", collection(cat, "anime").locked === true);
check("raising a tier keeps the saved choice", cat.chosenWallpaperId === petal);
check("a locked saved choice cannot be re-chosen", await refused(() => db.query(`select public.theme_set_wallpaper($1)`, [petal])));
await asSystem();
await db.query(`update public.theme_collections set required_tier = 'glow' where id = 'anime'`);

console.log("clearing and input rules");
await asUser(ids.glow);
await db.query(`select public.theme_clear_wallpaper()`);
cat = await catalog();
check("clearing the wallpaper removes the choice", cat.chosenWallpaperId === null);
await asSystem();
const rows = await q(`select count(*)::int as n from public.profile_theme_choices where user_id = $1`, [ids.glow]);
check("the choice row is gone after clearing", rows[0].n === 0);

check(
  "a non-https, non-local image is refused",
  await refused(() => db.query(
    `insert into public.theme_wallpapers (collection_id, title, image_url) values ('anime', 'Bad link', 'javascript:alert(1)')`
  ), "23514")
);
check(
  "a plain http image is refused",
  await refused(() => db.query(
    `insert into public.theme_wallpapers (collection_id, title, image_url) values ('anime', 'Plain link', 'http://example.com/a.png')`
  ), "23514")
);
check(
  "an https image is accepted",
  !(await refused(() => db.query(
    `insert into public.theme_wallpapers (collection_id, title, image_url) values ('anime', 'Remote art', 'https://cdn.example.com/a.png')`
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
  `select public.theme_admin_audit($1, 'theme_collection_update', 'theme_collections', null, 'Test change', '{"id":"anime"}'::jsonb, '{"id":"anime"}'::jsonb) as id`,
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
  await refused(() => db.query(`select public.theme_admin_audit($1, 'x', 'theme_collections', null, 'x', null, null)`, ["00000000-0000-4000-8000-0000000000ee"]), "42501")
);
await asUser(ids.glow);
check(
  "a member cannot call the audit function",
  await refused(() => db.query(`select public.theme_admin_audit($1, 'x', 'theme_collections', null, 'x', null, null)`, [adminId]))
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
