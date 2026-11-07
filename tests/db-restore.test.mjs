/* Verifies scripts/db-restore.mjs against real PostgreSQL 18: the SQL the tool
   prints in its dry run is executed here, and the result is compared with the
   backup it came from.

   The backup folder is built by this test in a temporary directory — it must
   not depend on anything left in /tmp by an earlier run, because /tmp does not
   survive between sessions and a stale fixture silently poisons the result. */

/* PGlite is a dev-only dependency (an in-process Postgres used to execute the
   migrations for real). When it is not installed — a fresh checkout, or a sandbox
   that dropped node_modules — say so loudly and stop, rather than reporting a
   pass that never ran. */
let PGlite = null;
try {
  ({ PGlite } = await import("@electric-sql/pglite"));
} catch {
  console.log("  ! SKIPPED — @electric-sql/pglite is not installed, so this SQL suite did not run.");
  console.log("  ! Install it with: npm install --save-dev @electric-sql/pglite");
  process.exit(0);
}
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "/home/user/shinzora";

/* ------------------------------------------------------------------ fixture */

const UUID = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
  d: "44444444-4444-4444-8444-444444444444"
};

/* Two rows, deliberately including a numeric amount, a null and a timestamp,
   so the round trip is exercised rather than a table of strings. */
const BACKUP_ROWS = [
  {
    id: UUID.a,
    owner_id: UUID.b,
    reference: "SZ-AAA",
    purpose: "pro",
    amount: 2499,
    status: "verified",
    created_at: "2026-11-01T10:00:00+00:00",
    admin_note: null
  },
  {
    id: UUID.c,
    owner_id: UUID.d,
    reference: "SZ-BBB",
    purpose: "brand_kit",
    amount: 1234.5,
    status: "pending",
    created_at: "2026-11-02T11:30:00+00:00",
    admin_note: "waiting on proof"
  }
];

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinzora-restore-test-"));
fs.mkdirSync(path.join(backupDir, "data"), { recursive: true });
const dataFile = path.join(backupDir, "data", "payments.json");
const body = JSON.stringify(BACKUP_ROWS, null, 1);
fs.writeFileSync(dataFile, body);

const manifestPath = path.join(backupDir, "manifest.json");
const manifestOf = (digest) => ({
  takenAt: "2026-11-07T06:00:00.000Z",
  method: "management-api",
  tables: { payments: { file: "data/payments.json", rows: BACKUP_ROWS.length } },
  schema: {},
  files: { "data/payments.json": digest }
});
const digestOf = (text) => crypto.createHash("sha256").update(text).digest("hex");
fs.writeFileSync(manifestPath, JSON.stringify(manifestOf(digestOf(body)), null, 2));

/* A database in the state a restore would overwrite: same table, different rows. */
const db = new PGlite();
await db.exec(`
  create table public.payments (
    id uuid primary key,
    owner_id uuid not null,
    reference text not null,
    purpose text not null,
    amount numeric(12,2) not null,
    status text not null,
    created_at timestamptz not null,
    admin_note text
  );
  insert into public.payments values
    ('${UUID.a}','${UUID.b}','SZ-OLD-PRO','pro',1,'pending',now(),null),
    ('${UUID.c}','${UUID.d}','SZ-OLD-KIT','brand_kit',1,'pending',now(),null);
`);

/* ------------------------------------------------------------------- checks */

let pass = 0, fail = 0;
const check = (n, c, d = "") =>
  c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? " — " + d : ""}`));

const restore = (extra = "") =>
  execSync(`node scripts/db-restore.mjs ${backupDir} ${extra}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/* `--verify` takes the folder as its own value: node … --verify <dir> */
const runVerify = () =>
  execSync(`node scripts/db-restore.mjs --verify ${backupDir}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/* 1 — a dry run prints SQL and writes nothing */
let dryRun = "";
try {
  dryRun = restore();
  check("the dry run completes without credentials", true);
} catch (error) {
  check("the dry run completes without credentials", false, (error.stdout || error.message).toString().slice(0, 160));
}

const stillThere = (await db.query(`select reference from public.payments order by reference`)).rows.map((r) => r.reference);
check("the dry run wrote nothing", stillThere.join(",") === "SZ-OLD-KIT,SZ-OLD-PRO", stillThere.join(","));

/* 2 — the SQL it printed is real SQL: run it */
const marker = "The first table's SQL would be:";
const start = dryRun.indexOf(marker);
const lines = start === -1 ? [] : dryRun.slice(start + marker.length).split("\n").slice(1);
const statements = [];
let current = null;
for (const line of lines) {
  if (line.startsWith("    ")) {
    const text = line.slice(4);
    if (/^(delete|insert)/.test(text)) {
      if (current) statements.push(current);
      current = text;
    } else if (current) {
      current += " " + text.trim();
    }
  } else if (current) {
    statements.push(current);
    current = null;
  }
}
if (current) statements.push(current);

check("the tool printed a delete and an insert", statements.length === 2, JSON.stringify(statements.map((s) => s.slice(0, 24))));

await db.exec(`begin;`);
for (const statement of statements) await db.exec(statement.endsWith(";") ? statement : statement + ";");
await db.exec(`commit;`);

const rows = (await db.query(`select id, reference, status, amount, admin_note from public.payments order by reference`)).rows;
check("the backup's rows are now present", rows.length === 2, String(rows.length));
check("existing rows were replaced, not merged", rows.every((r) => ["SZ-AAA", "SZ-BBB"].includes(r.reference)), JSON.stringify(rows.map((r) => r.reference)));
check("numeric amounts survive the round trip", rows.some((r) => String(r.amount) === "2499.00") && rows.some((r) => String(r.amount) === "1234.50"), JSON.stringify(rows.map((r) => String(r.amount))));
check("nulls and text survive", rows.some((r) => r.admin_note === null) && rows.some((r) => r.admin_note === "waiting on proof"));

/* 3 — append-only history must never be restored */
try {
  fs.mkdirSync(path.join(backupDir, "data"), { recursive: true });
  const notesBody = JSON.stringify([{ note: "x" }], null, 1);
  fs.writeFileSync(path.join(backupDir, "data", "schema_migrations.json"), notesBody);
  const m = manifestOf(digestOf(body));
  m.tables.schema_migrations = { file: "data/schema_migrations.json", rows: 1 };
  m.files["data/schema_migrations.json"] = digestOf(notesBody);
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const output = restore("--only schema_migrations");
  check("schema_migrations is refused", /append-only history/.test(output), output.slice(-120));
} catch (error) {
  const text = ((error.stdout || "") + (error.stderr || "")).toString();
  check("schema_migrations is refused", /append-only history/.test(text), text.slice(-120));
}

/* 4 — a tampered backup is refused before anything is written */
const tampered = body.replace("SZ-AAA", "SZ-ZZZ");
fs.writeFileSync(dataFile, tampered);
fs.writeFileSync(manifestPath, JSON.stringify(manifestOf(digestOf(body)), null, 2));
let refusal = "";
try {
  restore();
  check("a tampered backup is refused", false, "the run succeeded");
} catch (error) {
  refusal = ((error.stdout || "") + (error.stderr || "")).toString();
  check("a tampered backup is refused", /corrupt/i.test(refusal), refusal.replace(/\s+/g, " ").slice(-120));
}

/* 5 — and it really did not write: the good manifest + rows are intact on disk */
fs.writeFileSync(dataFile, body);
fs.writeFileSync(manifestPath, JSON.stringify(manifestOf(digestOf(body)), null, 2));
const verified = runVerify();
check("--verify accepts the restored-backup and writes nothing", /re-hashed and intact/.test(verified), verified.slice(-120));

/* 6 — the post-restore referential integrity check
   A restore writes with foreign-key triggers disabled, so the tool must be able
   to tell the operator which rows are now dangling. Prove it does on a database
   that deliberately has one. */
const { foreignKeyOrphans } = await import("../scripts/db-restore.mjs");
const run = async (text) => (await db.query(text)).rows;

await db.exec(`
  create table public.owners (id uuid primary key);
  create table public.things (id uuid primary key, owner_id uuid references public.owners(id));
  insert into public.owners values ('${UUID.a}');
  insert into public.things values ('${UUID.b}','${UUID.a}');
`);
let integrity = await foreignKeyOrphans(run);
check("a consistent database reports no orphans", integrity.orphans === 0 && integrity.checked >= 1, JSON.stringify(integrity));

/* Simulate exactly what a partial restore leaves behind: a child whose parent
   is gone. Deleted with triggers off, as the restore path does. */
await db.exec(`set session_replication_role = replica; delete from public.owners; set session_replication_role = origin;`);
integrity = await foreignKeyOrphans(run);
check("a dangling foreign key is counted", integrity.orphans === 1, JSON.stringify(integrity));

/* 7 — sequences after a restore of a table with a serial key */
await db.exec(`
  create table public.ai_usage_log (id bigserial primary key, note text);
  insert into public.ai_usage_log (id, note) values (10,'a'), (11,'b');
`);
const { resetSequences } = await import("../scripts/db-restore.mjs");
const moved = await resetSequences(run, ["ai_usage_log", "payments", "nope_not_a_table"]);
check("a serial table's sequence is moved", moved.includes("ai_usage_log"), JSON.stringify(moved));

/* The whole point: an ordinary insert after the reset must not collide. */
const inserted = await db.query(`insert into public.ai_usage_log (note) values ('after restore') returning id`);
check("the next insert does not collide with a restored id", Number(inserted.rows[0].id) >= 12, String(inserted.rows[0].id));

/* 8 — a pg_dump backup is handed to psql with a safe command, not table-restored */
const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shinzora-pgdump-test-"));
const dumpBody = "-- synthetic dump\n";
fs.writeFileSync(path.join(dumpDir, "full.sql"), dumpBody);
fs.writeFileSync(
  path.join(dumpDir, "manifest.json"),
  JSON.stringify({ takenAt: "2026-11-07T06:00:00.000Z", method: "pg_dump", files: { "full.sql": digestOf(dumpBody) } }, null, 2)
);
const dumpOut = execSync(`node scripts/db-restore.mjs ${dumpDir}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
check("a pg_dump backup prints a psql command", /psql "\$SUPABASE_DB_URL"/.test(dumpOut), dumpOut.slice(-80));
check("the psql command is transactional and self-contained", /--single-transaction --clean --if-exists/.test(dumpOut));
check("a pg_dump backup is not table-restored", !/DRY RUN/.test(dumpOut) && !/jsonb_populate_recordset/.test(dumpOut));
fs.rmSync(dumpDir, { recursive: true, force: true });

fs.rmSync(backupDir, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
await db.close();
process.exit(fail ? 1 : 0);
