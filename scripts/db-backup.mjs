#!/usr/bin/env node
/* ==========================================================================
   Shinzora — database backup
   --------------------------------------------------------------------------
   Takes a logical backup before anything structural is changed, and proves the
   backup is readable before the migration is allowed to run.

   Two paths, in order of preference:
     1. pg_dump, when SUPABASE_DB_URL and the pg_dump binary are available. Exact
        and restorable with psql.
     2. Management API, when SUPABASE_ACCESS_TOKEN is available: every table is
        read out as JSON, plus a full snapshot of the schema objects (tables,
        columns, constraints, indexes, policies, triggers, functions). Restorable
        with scripts/db-restore.mjs.

     node scripts/db-backup.mjs                  # backup into .backups/<stamp>/
     node scripts/db-backup.mjs --only payments  # single table
     node scripts/db-backup.mjs --verify .backups/<stamp>

   A backup that cannot be read back is not a backup, so each file is hashed and
   the manifest is re-checked at the end of the run.
   ========================================================================== */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  config, sql, sha256, timestamp, writeJson, ROOT, APPLICATION_TABLES, SECRET_BEARING_TABLES
} from "./lib/supabase-admin.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};

const SCHEMA_QUERIES = {
  tables: `select table_name, table_type from information_schema.tables
            where table_schema = 'public' order by table_name`,
  columns: `select table_name, column_name, data_type, is_nullable, column_default
              from information_schema.columns where table_schema = 'public'
             order by table_name, ordinal_position`,
  constraints: `select conrelid::regclass::text as table_name, conname, contype, pg_get_constraintdef(oid) as definition
                  from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`,
  indexes: `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`,
  policies: `select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`,
  triggers: `select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition
               from pg_trigger t join pg_class c on c.oid = t.tgrelid
               join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and not t.tgisinternal order by 1, 2`,
  functions: `select p.proname, pg_get_function_identity_arguments(p.oid) as args
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' order by 1`,
  rls: `select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' order by 1`
};

async function pgDump(dir) {
  const cfg = config();
  if (!cfg.dbUrl) return false;
  try {
    execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
  } catch {
    return false;
  }
  const out = path.join(dir, "full.sql");
  execFileSync("pg_dump", ["--no-owner", "--no-privileges", "--file", out, cfg.dbUrl], { stdio: "inherit" });
  return true;
}

async function viaManagementApi(dir) {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "schema"), { recursive: true });

  const manifest = { takenAt: new Date().toISOString(), method: "management-api", tables: {}, schema: {}, files: {} };

  /* ---- data ---- */
  const only = flag("only");
  const tables = only ? [String(only)] : APPLICATION_TABLES;
  for (const table of tables) {
    let rows = [];
    try {
      const result = await sql(
        `select coalesce(json_agg(t), '[]'::json) as data from (select * from public.${table} order by ctid) t`
      );
      rows = result[0]?.data ?? [];
    } catch (error) {
      manifest.tables[table] = { error: error.message.slice(0, 200) };
      console.log(`  · ${table.padEnd(24)} skipped (${error.message.split(":")[0]})`);
      continue;
    }
    const file = path.join(dir, "data", `${table}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 1));
    const digest = sha256(fs.readFileSync(file));
    manifest.tables[table] = {
      rows: rows.length,
      file: path.relative(dir, file),
      sha256: digest,
      ...(SECRET_BEARING_TABLES.includes(table) ? { contains_secrets: true } : {})
    };
    manifest.files[path.relative(dir, file)] = digest;
    console.log(`  ✓ ${table.padEnd(24)} ${String(rows.length).padStart(6)} row(s)  ${digest.slice(0, 12)}`);
  }

  /* ---- schema ---- */
  for (const [name, query] of Object.entries(SCHEMA_QUERIES)) {
    try {
      const result = await sql(query);
      const file = path.join(dir, "schema", `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(result, null, 1));
      const digest = sha256(fs.readFileSync(file));
      manifest.schema[name] = { rows: result.length, file: path.relative(dir, file), sha256: digest };
      manifest.files[path.relative(dir, file)] = digest;
      console.log(`  ✓ schema.${name.padEnd(18)} ${String(result.length).padStart(6)} object(s)`);
    } catch (error) {
      manifest.schema[name] = { error: error.message.slice(0, 200) };
      console.log(`  · schema.${name.padEnd(18)} not readable (${error.message.split(":")[0]})`);
    }
  }

  return manifest;
}

function verify(dir) {
  const manifestFile = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    console.error(`  ✗ no manifest in ${dir}`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  let bad = 0;
  for (const [rel, digest] of Object.entries(manifest.files || {})) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) {
      console.log(`  ✗ missing ${rel}`);
      bad += 1;
      continue;
    }
    const actual = sha256(fs.readFileSync(file));
    if (actual !== digest) {
      console.log(`  ✗ changed ${rel}`);
      bad += 1;
    }
  }
  const totalRows = Object.values(manifest.tables || {}).reduce((a, t) => a + (t.rows || 0), 0);
  console.log(
    bad
      ? `  ✗ backup verification failed: ${bad} file(s)`
      : `  ✓ backup verified: ${Object.keys(manifest.files || {}).length} files, ${totalRows} rows`
  );
  process.exitCode = bad ? 1 : 0;
  return !bad;
}

async function main() {
  const verifyDir = flag("verify");
  if (verifyDir) return verify(String(verifyDir));

  const cfg = config();
  const stamp = timestamp();
  const dir = path.join(ROOT, ".backups", stamp);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n  Shinzora backup → .backups/${stamp}`);
  console.log(`  project: ${cfg.ref || "(unknown)"}\n`);

  let manifest;
  let method = "management-api";
  if (await pgDump(dir)) {
    method = "pg_dump";
    const file = path.join(dir, "full.sql");
    manifest = { takenAt: new Date().toISOString(), method: "pg_dump", files: { "full.sql": sha256(fs.readFileSync(file)) } };
    console.log("  ✓ pg_dump complete (full.sql)");
  } else if (cfg.accessToken) {
    manifest = await viaManagementApi(dir);
  } else {
    console.error("  ✗ No way to take a backup from here.");
    console.error("    Set SUPABASE_DB_URL (pg_dump) or SUPABASE_ACCESS_TOKEN (Management API) and run again.");
    process.exitCode = 2;
    return;
  }

  writeJson(path.join(dir, "manifest.json"), manifest);
  console.log(`\n  manifest: ${path.relative(ROOT, path.join(dir, "manifest.json"))}`);
  console.log(`\n  Contains: ${method === "pg_dump" ? "the whole database, including auth.users and the storage metadata" : `${APPLICATION_TABLES.length} application tables + a schema snapshot`}.`);
  if (method !== "pg_dump") {
    console.log("  Not included: auth.users (email accounts and password hashes), storage objects, and Supabase's own settings.");
    console.log("  For a backup that can restore user accounts, set SUPABASE_DB_URL so pg_dump is used.");
  }
  console.log("  This folder may contain personal data and provider credentials. Keep it off Git and off shared drives.");
  verify(dir);
  console.log("");
}

main().catch((error) => {
  console.error("\n  backup failed:", error.message);
  process.exit(1);
});
