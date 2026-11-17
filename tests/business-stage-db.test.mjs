/* ==========================================================================
   Business stage (0079) — behaviour, in PGlite
   --------------------------------------------------------------------------
   Replays migrations 0001–0078 into an in-process PostgreSQL, writes rows the
   way the live project holds them (legacy onboarding labels and one empty
   stage), then applies 0079 and checks:
     - legacy labels map once onto the four stages; empty stays empty
     - the database refuses any value outside the four stages
     - the owner can set a stage through business_set_stage, including a
       business that had no stage
     - another member, anon, and a bad value are all refused
     - a direct owner update to a legacy label is refused by the check
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

const STAGE_FILE = "0079_business_stage.sql";
const files = migrationFiles();
if (!files.includes(STAGE_FILE)) {
  console.log(`  ✗ ${STAGE_FILE} is missing`);
  process.exit(1);
}

const db = new PGlite();
await db.exec(SCAFFOLD);
for (const file of files) {
  if (file >= STAGE_FILE) break;
  await apply(db, file);
}

const ids = {
  idea: "00000000-0000-4000-8000-0000000000c1",
  starting: "00000000-0000-4000-8000-0000000000c2",
  operating: "00000000-0000-4000-8000-0000000000c3",
  growing: "00000000-0000-4000-8000-0000000000c4",
  none: "00000000-0000-4000-8000-0000000000c5",
  other: "00000000-0000-4000-8000-0000000000c6"
};
const biz = {
  idea: "00000000-0000-4000-8000-0000000000d1",
  starting: "00000000-0000-4000-8000-0000000000d2",
  operating: "00000000-0000-4000-8000-0000000000d3",
  growing: "00000000-0000-4000-8000-0000000000d4",
  none: "00000000-0000-4000-8000-0000000000d5",
  other: "00000000-0000-4000-8000-0000000000d6"
};

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

for (const [name, uid] of Object.entries(ids)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [uid, `${name}@stage.test`]);
  await db.query(`insert into public.profiles (id, full_name) values ($1, $2) on conflict (id) do nothing`, [uid, name]);
}

/* Legacy rows, written before 0079 exists, exactly as onboarding wrote them. */
const legacy = [
  ["idea", "idea"],
  ["starting", "starting"],
  ["operating", "operating"],
  ["growing", "growing"],
  ["none", null]
];
for (const [key, stage] of legacy) {
  await db.query(
    `insert into public.businesses (id, owner_id, name, stage) values ($1, $2, $3, $4)`,
    [biz[key], ids[key], `Legacy ${key}`, stage]
  );
}

await apply(db, STAGE_FILE);

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

/* True only when the operation fails with the expected SQLSTATE. */
const refused = async (fn, code) => {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
};

const stageOf = async (key) => (await q(`select stage from public.businesses where id = $1`, [biz[key]]))[0].stage;

console.log("mapping");
await asSystem();
check("idea becomes ideation", (await stageOf("idea")) === "ideation");
check("starting becomes mvp", (await stageOf("starting")) === "mvp");
check("operating becomes scaling", (await stageOf("operating")) === "scaling");
check("growing becomes established", (await stageOf("growing")) === "established");
check("an empty stage stays empty (no forced onboarding)", (await stageOf("none")) === null);

console.log("constraint");
await asSystem();
check(
  "a legacy label is refused on insert",
  await refused(
    () => db.query(`insert into public.businesses (owner_id, name, stage) values ($1, 'x', 'idea')`, [ids.other]),
    "23514"
  )
);
check(
  "an unknown value is refused on update",
  await refused(() => db.query(`update public.businesses set stage = 'enterprise' where id = $1`, [biz.none]), "23514")
);

console.log("business_set_stage");
await asUser(ids.none);
const set = await q(`select public.business_set_stage($1, 'MVP') as r`, [biz.none]);
check("owner sets a stage on a business that had none (case and spaces tolerated)", set[0].r.ok === true && set[0].r.stage === "mvp");
await asSystem();
check("the new stage is stored", (await stageOf("none")) === "mvp");

await asUser(ids.none);
check(
  "a bad value is refused by the function",
  await refused(() => db.query(`select public.business_set_stage($1, 'growing')`, [biz.none]), "22023")
);

await asUser(ids.other);
check(
  "another member cannot change someone else's stage",
  await refused(() => db.query(`select public.business_set_stage($1, 'scaling')`, [biz.none]), "42501")
);
await asSystem();
check("the refused change left the stage alone", (await stageOf("none")) === "mvp");

await asAnon();
check(
  "anon cannot call the function",
  await refused(() => db.query(`select public.business_set_stage($1, 'scaling')`, [biz.none]), "42501")
);

await asUser(ids.operating);
await db.query(`select public.business_set_stage($1, 'established')`, [biz.operating]);
await asSystem();
check("owner can move a business to Established", (await stageOf("operating")) === "established");

await asUser(ids.idea);
{
  let code = "none";
  try {
    await db.query(`update public.businesses set stage = 'starting' where id = $1`, [biz.idea]);
  } catch (error) {
    code = error?.code || "error";
  }
  /* Refused either by the table privileges (42501) or by the stage check (23514);
     either way the legacy label is not stored. */
  check("an owner's direct update to a legacy label is refused", code === "23514" || code === "42501", `got ${code}`);
  await asSystem();
  check("the legacy label was not stored", (await stageOf("idea")) === "ideation");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
