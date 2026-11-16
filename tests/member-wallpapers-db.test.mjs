/* ==========================================================================
   Member wallpapers (0067) — behaviour in PGlite
   --------------------------------------------------------------------------
     - a free member cannot upload, register or use a wallpaper
     - a Glow member can; Elite can too
     - storage refuses an insert outside the caller's folder, and for a free member
     - register refuses an object outside the caller's folder, over 5 MB, not
       PNG or GIF, or missing; it removes the bad object
     - the count is capped at 5
     - use and delete refuse someone else's upload
     - delete works without a tier, so a lapsed member can remove their file
     - a saved upload and a catalogue wallpaper are exclusive
     - the uploads table is not readable by the browser at all
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
  free: "00000000-0000-4000-8000-0000000000f1",
  glow: "00000000-0000-4000-8000-0000000000a2",
  elite: "00000000-0000-4000-8000-0000000000e3",
  other: "00000000-0000-4000-8000-0000000000b4"
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@test.local`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}
await db.query(
  `insert into public.profile_entitlements (user_id, tier, accent, granted_at, updated_at)
   values ($1, 'glow', null, now(), now()), ($2, 'elite', 'rose', now(), now()), ($3, 'glow', null, now(), now())`,
  [ids.glow, ids.elite, ids.other]
);
await db.query(`insert into public.theme_collections (id, name, required_tier) values ('open', 'Open', null)`);
await db.query(
  `insert into public.theme_wallpapers (id, collection_id, title, image_url) values
   ('11111111-0000-4000-8000-000000000001', 'open', 'Plain', '/assets/themes/plain.svg')`
);

await db.exec(`
  grant usage on schema public to authenticated, anon;
  grant usage on schema storage to authenticated, anon;
  grant select, insert, delete on storage.objects to authenticated;
  grant select on storage.buckets to authenticated;
  alter table storage.objects enable row level security;
  grant select on public.profile_theme_choices to authenticated;
`);

const asUser = async (userId) => {
  await db.exec(`
    reset role;
    set role authenticated;
    select set_config('request.jwt.claim.sub','${userId}',false);
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claims','{"sub":"${userId}","role":"authenticated"}',false);
  `);
};
const asSystem = async () => {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub','',false);
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claims','{"role":"service_role"}',false);
  `);
};
const errorOf = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/* Put a stored object in place as the service role (the upload itself is made by the storage API). */
const putObject = async (path, { size = 120000, mimetype = "image/png" } = {}) => {
  await asSystem();
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('member-wallpapers', $1, $2::jsonb)`,
    [path, JSON.stringify({ size, mimetype })]
  );
};

/* 1. Free members are refused at every step. */
await putObject(`${ids.free}/${uuid(1)}.png`);
await asUser(ids.free);
check("a free member is refused a register", (await errorOf(() => q(`select member_wallpaper_register($1)`, [`${ids.free}/${uuid(1)}.png`])))?.code === "42501");
const freeState = (await q(`select member_wallpaper_state() as s`))[0].s;
check("a free member's state says the tier is not held", freeState.tierOk === false && freeState.chosenPath === null);

const freeInsert = await errorOf(() => db.query(
  `insert into storage.objects (bucket_id, name, metadata) values ('member-wallpapers', $1, '{"size":10,"mimetype":"image/png"}')`,
  [`${ids.free}/${uuid(2)}.png`]
));
check("storage refuses a free member's insert", freeInsert !== null && /row-level security|42501/i.test(`${freeInsert.code} ${freeInsert.message}`), JSON.stringify(freeInsert));

/* 2. Glow and Elite can upload. (ids.other also holds Glow, so the ownership checks below are the ones tested.) */
await putObject(`${ids.glow}/${uuid(3)}.png`, { size: 2048, mimetype: "image/png" });
await asUser(ids.glow);
const glowInsert = await errorOf(() => db.query(
  `insert into storage.objects (bucket_id, name, metadata) values ('member-wallpapers', $1, '{"size":10,"mimetype":"image/png"}')`,
  [`${ids.glow}/${uuid(30)}.png`]
));
check("storage accepts a Glow member's insert in their own folder", glowInsert === null, JSON.stringify(glowInsert));
await db.query(`delete from storage.objects where name = $1`, [`${ids.glow}/${uuid(30)}.png`]).catch(() => undefined);

const glowReg = await q(`select member_wallpaper_register($1) as r`, [`${ids.glow}/${uuid(3)}.png`]);
check("a Glow member registers their PNG", glowReg[0].r.ok === true && typeof glowReg[0].r.id === "string");
const glowId = glowReg[0].r.id;

await putObject(`${ids.elite}/${uuid(4)}.gif`, { size: 4000, mimetype: "image/gif" });
await asUser(ids.elite);
const eliteReg = await q(`select member_wallpaper_register($1) as r`, [`${ids.elite}/${uuid(4)}.gif`]);
check("an Elite member registers their GIF", eliteReg[0].r.ok === true);

/* 3. Register refuses what it should. */
await putObject(`${ids.glow}/${uuid(5)}.png`, { size: 6 * 1024 * 1024, mimetype: "image/png" });
await asUser(ids.glow);
const big = await errorOf(() => q(`select member_wallpaper_register($1)`, [`${ids.glow}/${uuid(5)}.png`]));
check("register refuses an object over 5 MB", big?.code === "22001", JSON.stringify(big));
await asSystem();
const bigRows = await q(`select count(*)::int as n from public.member_wallpapers where storage_path = $1`, [`${ids.glow}/${uuid(5)}.png`]);
check("the oversized object is not registered", bigRows[0].n === 0);

await putObject(`${ids.glow}/${uuid(6)}.png`, { size: 900, mimetype: "image/jpeg" });
await asUser(ids.glow);
const jpeg = await errorOf(() => q(`select member_wallpaper_register($1)`, [`${ids.glow}/${uuid(6)}.png`]));
check("register refuses a file whose real type is not PNG or GIF", jpeg?.code === "22023", JSON.stringify(jpeg));

await asUser(ids.glow);
const missing = await errorOf(() => q(`select member_wallpaper_register($1)`, [`${ids.glow}/${uuid(99)}.png`]));
check("register refuses an upload that is not there", missing?.code === "P0002");

await putObject(`${ids.other}/${uuid(7)}.png`);
await asUser(ids.glow);
const elsewhere = await errorOf(() => q(`select member_wallpaper_register($1)`, [`${ids.other}/${uuid(7)}.png`]));
check("register refuses a file in someone else's folder", elsewhere?.code === "42501");

await asUser(ids.glow);
const again = await errorOf(() => q(`select member_wallpaper_register($1)`, [`${ids.glow}/${uuid(3)}.png`]));
check("the same object cannot be registered twice", again !== null);

/* 4. The count is capped at 5 (glow already has 1). */
for (let n = 10; n <= 13; n++) {
  await putObject(`${ids.glow}/${uuid(n)}.png`, { size: 500, mimetype: "image/png" });
  await asUser(ids.glow);
  await q(`select member_wallpaper_register($1)`, [`${ids.glow}/${uuid(n)}.png`]);
}
await putObject(`${ids.glow}/${uuid(20)}.png`, { size: 500, mimetype: "image/png" });
await asUser(ids.glow);
const sixth = await errorOf(() => q(`select member_wallpaper_register($1)`, [`${ids.glow}/${uuid(20)}.png`]));
check("a sixth upload is refused", sixth?.code === "53400", JSON.stringify(sixth));

/* 5. Use, delete, and exclusivity. */
await asUser(ids.glow);
const state = (await q(`select member_wallpaper_state() as s`))[0].s;
check("the state lists the caller's own uploads", state.uploads.length === 5 && state.tierOk === true && state.limit === 5);
await q(`select member_wallpaper_use($1)`, [glowId]);
const chosen = (await q(`select member_wallpaper_state() as s`))[0].s;
check("using an upload shows it as chosen with its path", chosen.chosenId === glowId && chosen.chosenPath === `${ids.glow}/${uuid(3)}.png`, JSON.stringify(chosen.chosenPath));

await q(`select theme_set_wallpaper('11111111-0000-4000-8000-000000000001')`);
const afterCatalog = (await q(`select member_wallpaper_state() as s`))[0].s;
check("choosing a catalogue wallpaper clears the upload", afterCatalog.chosenId === null && afterCatalog.chosenPath === null);
await q(`select member_wallpaper_use($1)`, [glowId]);
await asSystem();
const catalogAfter = (await q(`select wallpaper_id, member_wallpaper_id from public.profile_theme_choices where user_id = $1`, [ids.glow]))[0];
await asUser(ids.glow);
check("using an upload clears the catalogue choice", catalogAfter.wallpaper_id === null && catalogAfter.member_wallpaper_id === glowId);

await asUser(ids.other);
const strangerUse = await errorOf(() => q(`select member_wallpaper_use($1)`, [glowId]));
check("someone else cannot use the upload", strangerUse?.code === "P0002", JSON.stringify(strangerUse));
const strangerDelete = await errorOf(() => q(`select member_wallpaper_delete($1)`, [glowId]));
check("someone else cannot delete the upload", strangerDelete?.code === "P0002");
const directRead = await errorOf(() => q(`select id from public.member_wallpapers`));
check("the uploads table is not readable by a browser session", directRead?.code === "42501", JSON.stringify(directRead));

/* 6. Delete clears the choice, and works without a tier. */
await asUser(ids.glow);
const deleted = await q(`select member_wallpaper_delete($1) as d`, [glowId]);
check("delete returns the stored path so the file can be removed", deleted[0].d.path === `${ids.glow}/${uuid(3)}.png`);
const afterDelete = (await q(`select member_wallpaper_state() as s`))[0].s;
check("deleting the chosen upload clears the choice", afterDelete.chosenId === null);

await asSystem();
await db.query(`update public.profile_entitlements set tier = 'glow' where user_id = $1`, [ids.elite]);
await asUser(ids.elite);
const eliteOwn = (await q(`select member_wallpaper_state() as s`))[0].s;
check("an Elite member still sees their own uploads", eliteOwn.uploads.length === 1);
await asSystem();
await db.query(`delete from public.profile_entitlements where user_id = $1`, [ids.elite]);
await asUser(ids.elite);
const lapsed = (await q(`select member_wallpaper_state() as s`))[0].s;
check("a member who no longer holds a tier is shown no chosen path", lapsed.tierOk === false && lapsed.chosenPath === null);
await asSystem();
const eliteUploadId = (await q(`select id from public.member_wallpapers where owner_id = $1 limit 1`, [ids.elite]))[0].id;
await asUser(ids.elite);
const lapsedDelete = await errorOf(() => q(`select member_wallpaper_delete($1)`, [eliteUploadId]));
check("a lapsed member can still delete their own file", lapsedDelete === null, JSON.stringify(lapsedDelete));

await asSystem();
const acl = await q(`select has_function_privilege('anon','public.member_wallpaper_state()','execute') as anon_exec, has_function_privilege('authenticated','public.member_wallpaper_state()','execute') as auth_exec`);
check("anon has no execute right on the wallpaper functions", acl[0].anon_exec === false);
check("authenticated has execute right on the wallpaper functions", acl[0].auth_exec === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
