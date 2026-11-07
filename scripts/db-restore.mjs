#!/usr/bin/env node
/* ==========================================================================
   Shinzora — restore a logical backup taken by scripts/db-backup.mjs
   --------------------------------------------------------------------------
   `db-backup.mjs` documented this file from the day it was written, but it did
   not exist. A backup with no restore path is not a backup, so this is the
   missing half.

   What it can restore
     · a `management-api` backup (the default): data/…json per table
       → this script rebuilds the rows
     · a `pg_dump` backup: nothing here — it prints the exact psql command,
       because psql restores that file better than any script could

   What it cannot restore
     · schema objects. Dropping a column or a function is reversed with the
       rollback SQL in docs/MIGRATION-REPORT.md §8, not from a data backup.
     · storage objects (files live in Supabase Storage, not in Postgres).

   Safety
     · `--confirm` is required to write anything. Without it, this is a dry run.
     · it refuses to run without a verified manifest (hashes re-checked first).
     · each table is restored inside its own transaction, so a failure leaves the
       previous table intact rather than half of everything.
     · foreign keys are deferred for the duration of a table's restore, so the
       order of `data/*.json` does not matter.
     · it never touches auth.users, storage.* or any table not named in the
       manifest.

   Usage
     node scripts/db-restore.mjs .backups/<stamp>                 # dry run
     node scripts/db-restore.mjs .backups/<stamp> --confirm       # restore all
     node scripts/db-restore.mjs .backups/<stamp> --only payments --confirm
     node scripts/db-restore.mjs --verify .backups/<stamp>        # hashes only
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, sha256, config } from "./lib/supabase-admin.mjs";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const valueOf = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !args[i - 1].startsWith("--only")));

const dir = valueOf("verify") || positional[0] || (has("verify") ? null : null);
const restoreDir = typeof dir === "string" ? dir : null;

const die = (message) => {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
};

const readManifest = (folder) => {
  const file = path.join(folder, "manifest.json");
  if (!fs.existsSync(file)) die(`No manifest.json in ${folder}. This is not a Shinzora backup.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

const verifyHashes = (folder, manifest) => {
  let checked = 0;
  for (const [rel, digest] of Object.entries(manifest.files || {})) {
    const file = path.join(folder, rel);
    if (!fs.existsSync(file)) die(`Backup is incomplete: ${rel} is missing.`);
    const actual = sha256(fs.readFileSync(file));
    if (actual !== digest) die(`Backup is corrupt: ${rel} does not match its recorded hash.`);
    checked += 1;
  }
  return checked;
};

/* Only these may be written, whatever the manifest says. */
const WRITABLE = /^[a-z][a-z0-9_]{0,62}$/;
const FORBIDDEN = new Set(["schema_migrations", "migration_notes"]);

const quoteJson = (value) => `$json$${JSON.stringify(value)}$json$`;

const buildStatements = (table, rows) => {
  if (!ARRAY_GUARD(rows)) return [];
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  if (!columns.length) return [`delete from public.${table};`];

  const cols = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
  return [
    `delete from public.${table};`,
    `insert into public.${table} (${cols})
     select ${cols} from jsonb_populate_recordset(null::public.${table}, ${quoteJson(rows)}::jsonb);`
  ];
};

const ARRAY_GUARD = (value) => Array.isArray(value);

/* A restore writes explicit ids. For a table whose key comes from a sequence,
   the sequence stays where it was, so the next ordinary insert reuses an id the
   restore just wrote and fails with a duplicate key. Two tables in this schema
   use `bigserial` (ai_usage_log, migration_archive), which is exactly the sort
   of thing nobody notices until an AI call 500s a week later. */
export async function resetSequences(run, tables, log = { log: () => {} }) {
  const done = [];
  for (const table of tables) {
    if (!WRITABLE.test(table)) continue;
    let seq = null;
    try {
      const rows = await run(`select pg_get_serial_sequence('public.${table}', 'id') as seq`);
      seq = rows[0]?.seq ?? null;
    } catch {
      seq = null;
    }
    if (!seq) continue;
    try {
      await run(
        `select setval('${seq}', coalesce((select max(id) from public.${table}), 0) + 1, false)`
      );
      done.push(table);
      log.log(`    ✓ ${table.padEnd(24)} sequence moved past the restored ids`);
    } catch (error) {
      log.log(`    ✗ ${table.padEnd(24)} could not reset its sequence: ${error.message.split("\n")[0]}`);
    }
  }
  return done;
}

/* After a restore, count rows whose foreign key points at a parent that is not
   there. Exported so tests can run it against a real database. */
export async function foreignKeyOrphans(run, log = { log: () => {} }) {
  let checked = 0;
  let orphans = 0;
  const fks = await run(`
    select c.conrelid::regclass::text as child,
           a.attname as child_column,
           c.confrelid::regclass::text as parent,
           pa.attname as parent_column
      from pg_constraint c
      join pg_attribute a  on a.attrelid = c.conrelid  and a.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
     where c.contype = 'f' and array_length(c.conkey, 1) = 1
       and c.connamespace = 'public'::regnamespace
  `);
  for (const fk of fks) {
    if (!WRITABLE.test(String(fk.child).split(".").pop() || "")) continue;
    checked += 1;
    const rows = await run(`
      select count(*)::int as n from ${fk.child} c
       where c."${fk.child_column}" is not null
         and not exists (select 1 from ${fk.parent} p where p."${fk.parent_column}" = c."${fk.child_column}")
    `);
    const n = Number(rows[0]?.n ?? 0);
    if (n) {
      orphans += n;
      log.log(`    ✗ ${n} ${fk.child} row(s) point at a missing ${fk.parent}`);
    }
  }
  return { orphans, checked };
}

async function main() {
  if (!restoreDir) {
    die("Point this at a backup folder: node scripts/db-restore.mjs .backups/<stamp> [--confirm]");
  }
  if (!fs.existsSync(restoreDir)) die(`${restoreDir} does not exist.`);

  const manifest = readManifest(restoreDir);
  console.log(`\n  Backup ${restoreDir}`);
  console.log(`  taken  ${manifest.takenAt || "unknown"}`);
  console.log(`  method ${manifest.method || "management-api"}\n`);

  const files = verifyHashes(restoreDir, manifest);
  console.log(`  ✓ ${files} file(s) re-hashed and intact`);

  if (has("verify")) {
    console.log("\n  Nothing was written: --verify only checks the backup.\n");
    return;
  }

  if (manifest.method === "pg_dump") {
    const dump = path.join(restoreDir, "full.sql");
    console.log("\n  This is a pg_dump backup. Restore it with psql, which handles it");
    console.log("  better than any script.");
    console.log("\n  The dump contains CREATE statements for objects that already exist, so a");
    console.log("  plain `psql -f` against this project fails on the first table. Use the");
    console.log("  form that matches what you are trying to do:\n");
    console.log("  1. Put the database back exactly as it was at backup time. This DROPS and");
    console.log("     recreates every object — a full reset, not a patch:\n");
    console.log(`       psql \"$SUPABASE_DB_URL\" --single-transaction --clean --if-exists -f ${dump}\n`);
    console.log("  2. Load the data into a NEW, empty project (schema and rows together):\n");
    console.log(`       psql \"$SUPABASE_DB_URL\" -f ${dump}\n`);
    console.log("  Take a fresh backup immediately before either. The dump was taken with");
    console.log("  --no-owner --no-privileges, so it carries no ownership or GRANT lines;");
    console.log("  on this project the existing grants are untouched, but a fresh project");
    console.log("  would need them re-created before anon/authenticated can read anything.\n");
    return;
  }

  const only = valueOf("only");
  const wanted = Object.entries(manifest.tables || {})
    .filter(([, entry]) => entry && entry.file)
    .filter(([table]) => (typeof only === "string" ? table === only : true));

  if (!wanted.length) die("The manifest lists no restorable tables (were they all skipped?).");

  const plan = [];
  for (const [table, entry] of wanted) {
    if (!WRITABLE.test(table)) {
      console.log(`  · ${table.padEnd(24)} skipped — not a plain identifier`);
      continue;
    }
    if (FORBIDDEN.has(table)) {
      console.log(`  · ${table.padEnd(24)} skipped — append-only history`);
      continue;
    }
    const rows = JSON.parse(fs.readFileSync(path.join(restoreDir, entry.file), "utf8"));
    const statements = buildStatements(table, rows);
    plan.push({ table, rows: Array.isArray(rows) ? rows.length : 0, statements });
  }

  console.log(`\n  Plan: ${plan.length} table(s), ${plan.reduce((n, p) => n + p.rows, 0)} row(s)\n`);
  for (const item of plan) {
    let now = "";
    if (config().accessToken) {
      try {
        const current = await sql(`select count(*)::int as n from public.${item.table}`);
        now = `   (database now holds ${current[0]?.n ?? "?"})`;
      } catch {
        now = "";
      }
    }
    console.log(`    ${item.table.padEnd(24)} ${String(item.rows).padStart(6)} row(s)${now}`);
  }
  if (!config().accessToken) {
    console.log("\n  Set SUPABASE_ACCESS_TOKEN to also see how many rows each table holds now.");
  }

  if (!plan.length) {
    die("Nothing in this backup is restorable (every table was skipped or filtered out). Nothing was written.");
  }

  const confirm = has("confirm");
  if (!confirm) {
    console.log("\n  DRY RUN — nothing was written.");
    console.log("  The first table's SQL would be:\n");
    console.log(plan[0].statements.join("\n").replace(/^/gm, "    "));
    console.log("\n  Re-run with --confirm to write these rows into the database.");
    console.log("  Take a fresh backup of the current state first: nothing here merges.\n");
    return;
  }

  if (!config().accessToken) {
    die("SUPABASE_ACCESS_TOKEN is required to write. Nothing was changed.");
  }

  console.log("\n  Applying. Each table is one transaction; a failure stops the run.\n");
  for (const item of plan) {
    const body = ["begin;", "set local session_replication_role = replica;", ...item.statements, "commit;"].join("\n");
    try {
      await sql(body);
      console.log(`  ✓ ${item.table.padEnd(24)} restored ${item.rows} row(s)`);
    } catch (error) {
      console.error(`\n  ✗ ${item.table} failed: ${error.message}`);
      console.error("    That table was rolled back by its own transaction; earlier tables kept their rows.");
      console.error("    Stop, read the error, and re-run with --only <table> once it is understood.\n");
      process.exit(1);
    }
  }

  /* Read the counts back rather than trusting the loop above. */
  console.log("\n  Verifying:\n");
  let mismatch = 0;
  for (const item of plan) {
    try {
      const result = await sql(`select count(*)::int as n from public.${item.table}`);
      const actual = result[0]?.n ?? -1;
      const ok = actual === item.rows;
      if (!ok) mismatch += 1;
      console.log(`    ${ok ? "✓" : "✗"} ${item.table.padEnd(24)} ${actual} row(s), expected ${item.rows}`);
    } catch (error) {
      mismatch += 1;
      console.log(`    ✗ ${item.table.padEnd(24)} could not be counted: ${error.message}`);
    }
  }
  console.log(mismatch ? `\n  ✗ ${mismatch} table(s) do not match the backup.\n` : "\n  ✓ every restored table matches the backup.\n");

  console.log("  Sequences:\n");
  const moved = await resetSequences(sql, plan.map((item) => item.table), console);
  if (!moved.length) console.log("    · no restored table uses a sequence key");

  /* Foreign-key triggers were disabled during the write, so a partial restore —
     or a backup taken while another process was inserting — can leave rows that
     point at parents which no longer exist. Count them now, while it is still
     cheap to fix. */
  console.log("  Referential integrity:\n");
  const { orphans, checked } = await foreignKeyOrphans(sql, console);
  if (!checked) console.log("    · could not check foreign keys.");
  else if (!orphans) console.log(`    ✓ ${checked} foreign key(s) checked, no row points at a missing parent`);
  else console.log("\n    Restore those parents (a wider backup, or --only <table> for each) before trusting reports.\n");

  process.exit(mismatch || orphans ? 1 : 0);
}

/* Run only when called directly: the restore helpers are imported by tests. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n  ✗ ${error.message}\n`);
    process.exit(1);
  });
}
