#!/usr/bin/env node
/* ==========================================================================
   Shinzora — Step 1: pre-migration backup
   --------------------------------------------------------------------------
   Takes a complete, verified, restorable-looking snapshot of production and of
   the configuration that defines it, WITHOUT changing anything.

   Read-only by construction: every statement this script issues is a SELECT.

     node scripts/step1-backup.mjs            # take the backup
     node scripts/step1-backup.mjs --plan     # show what would be collected
     node scripts/step1-backup.mjs --verify .backups/step1-<stamp>

   Needs one of
     SUPABASE_ACCESS_TOKEN   (Management API: data + schema + auth users)
     SUPABASE_DB_URL         (pg_dump: everything, including auth and storage
                              metadata; preferred when the binary exists)

   Output: .backups/step1-<stamp>/ with
     data/<table>.json          every application table
     auth/users.json            accounts + password hashes (secret-bearing)
     schema/*.json              tables, columns, constraints, indexes, policies,
                                triggers, functions, RLS state
     storage/*.json             buckets and object counts
     config/                    .env, config.toml, function + migration sources
     manifest.json              hashes, counts, warnings
     BACKUP-REPORT.md           the human-readable summary

   What it cannot collect, and says so in the report:
     · storage object bytes (they live in Storage, not in Postgres)
     · Edge function secrets (write-only; they must come from your vault)
     · project settings: auth providers, SMTP, JWT secret, custom domains,
       redirect allow-list — dashboard-only, exported by hand
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ROOT, APPLICATION_TABLES, SECRET_BEARING_TABLES, config, sql, writeJson
} from "./lib/supabase-admin.mjs";
import { buildManifest, verifyBackup, sha256 } from "./lib/backup-kit.mjs";

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
  constraints: `select conrelid::regclass::text as table_name, conname, contype,
                       pg_get_constraintdef(oid) as definition
                  from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`,
  indexes: `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`,
  policies: `select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`,
  triggers: `select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition
               from pg_trigger t join pg_class c on c.oid = t.tgrelid
               join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and not t.tgisinternal order by 1, 2`,
  functions: `select p.proname, pg_get_function_identity_arguments(p.oid) as args,
                     p.prosecdef as security_definer
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' order by 1`,
  auth_columns: `select table_name, column_name, data_type from information_schema.columns
                  where table_schema = 'auth' and table_name in ('users', 'identities')
                 order by table_name, ordinal_position`,
  rls: `select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' order by 1`
};

const CONFIG_FILES = [
  ".env",
  "supabase/config.toml",
  "package.json"
];

async function managementGet(pathname, token) {
  const response = await fetch(`https://api.supabase.com${pathname}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function plan() {
  console.log("\n  Step 1 would collect:\n");
  console.log(`  data            ${APPLICATION_TABLES.length} application tables (every row)`);
  console.log("  auth            auth.users + auth.identities (secret-bearing)");
  console.log(`  schema          ${Object.keys(SCHEMA_QUERIES).length} schema snapshots`);
  console.log("  storage         bucket definitions + object counts (not the bytes)");
  console.log("  config          .env, supabase/config.toml, package.json,");
  console.log("                  every supabase/functions/** source, every migration");
  console.log("  manifest        sha256 of every file, row counts, warnings");
  console.log("\n  Every statement is a SELECT. Nothing is written to production.\n");
}

async function takeBackup() {
  const cfg = config();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(ROOT, ".backups", `step1-${stamp}`);

  console.log(`\n  Shinzora Step 1 backup → .backups/step1-${stamp}`);
  console.log(`  project: ${cfg.ref || "(unknown)"}`);

  if (!cfg.accessToken && !cfg.dbUrl) {
    console.error("\n  ✗ No credential. Nothing was read and nothing was written.");
    console.error("    Provide SUPABASE_ACCESS_TOKEN (Management API) or SUPABASE_DB_URL (pg_dump).");
    console.error("    Refusing to produce a partial backup that would look complete.\n");
    process.exitCode = 2;
    return;
  }

  /* Preflight. A token that is valid but belongs to another account answers
     403 on every query, and a run that "succeeds" with zero rows is worse than
     no backup at all. Prove access to THIS project ref first. */
  if (cfg.accessToken) {
    const probe = await managementGet(`/v1/projects/${cfg.ref}`, cfg.accessToken);
    if (probe.status !== 200) {
      const visible = await managementGet("/v1/projects", cfg.accessToken);
      const refs = Array.isArray(visible.body) ? visible.body.map((project) => project.ref) : [];
      console.error(`\n  ✗ This token cannot access project ${cfg.ref} (HTTP ${probe.status}).`);
      console.error(`    Projects this token can see: ${refs.length ? refs.join(", ") : "none"}`);
      console.error("    Nothing was read from production and nothing was written.");
      console.error("    Use a token from the account that owns the Shinzora project, or set SUPABASE_DB_URL.\n");
      process.exitCode = 3;
      return;
    }
  }

  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "auth"), { recursive: true });
  fs.mkdirSync(path.join(dir, "schema"), { recursive: true });
  fs.mkdirSync(path.join(dir, "storage"), { recursive: true });
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.chmodSync(dir, 0o700);

  const warnings = [];
  const tables = {};
  const schema = {};
  const startedAt = new Date().toISOString();

  /* ---- a full pg_dump, when we can get one: it is strictly better ---- */
  let transport = "management-api";
  if (cfg.dbUrl) {
    try {
      execFileSync("pg_dump", ["--version"], { stdio: "ignore" });
      const out = path.join(dir, "full.sql");
      execFileSync("pg_dump", ["--no-owner", "--no-privileges", "--file", out, cfg.dbUrl], { stdio: "inherit" });
      transport = "pg_dump";
      console.log(`  ✓ pg_dump complete  ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
    } catch (error) {
      warnings.push(`pg_dump did not complete (${error.message.slice(0, 120)}); fell back to the Management API.`);
    }
  }

  /* ---- data ---- */
  if (transport !== "pg_dump" || flag("also-json")) {
    for (const table of APPLICATION_TABLES) {
      try {
        const result = await sql(
          `select coalesce(json_agg(t), '[]'::json) as data from (select * from public.${table} order by ctid) t`
        );
        const rows = result[0]?.data ?? [];
        const file = path.join(dir, "data", `${table}.json`);
        fs.writeFileSync(file, JSON.stringify(rows, null, 1));
        tables[table] = {
          rows: rows.length,
          file: path.relative(dir, file),
          sha256: sha256(fs.readFileSync(file)),
          ...(SECRET_BEARING_TABLES.includes(table) ? { contains_secrets: true } : {})
        };
        console.log(`  ✓ ${table.padEnd(24)} ${String(rows.length).padStart(6)} row(s)`);
      } catch (error) {
        const message = error.message || "";
        if (/42P01|does not exist/i.test(message)) {
          /* The migration declares it; production does not have it. There is
             nothing to back up, but it is schema drift and must be reported. */
          tables[table] = { absent: true, note: "declared in the migrations, not present in production" };
          console.log(`  · ${table.padEnd(24)} absent in production`);
        } else {
          tables[table] = { error: message.slice(0, 200) };
          warnings.push(`table ${table} could not be read: ${message.split(":")[0]}`);
          console.log(`  · ${table.padEnd(24)} skipped`);
        }
      }
    }

    /* ---- auth users: without these a restore has no accounts ---- */
    try {
      const users = await sql(
        `select id, aud, role, email, encrypted_password, email_confirmed_at, created_at,
                updated_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, banned_until
           from auth.users order by created_at`
      );
      const file = path.join(dir, "auth", "users.json");
      fs.writeFileSync(file, JSON.stringify(users, null, 1));
      tables["auth.users"] = {
        rows: users.length,
        file: path.relative(dir, file),
        sha256: sha256(fs.readFileSync(file)),
        contains_secrets: true
      };
      console.log(`  ✓ ${"auth.users".padEnd(24)} ${String(users.length).padStart(6)} row(s)`);

      const identities = await sql(
        `select id, user_id, provider, provider_id, identity_data, created_at, last_sign_in_at
           from auth.identities order by created_at`
      );
      const identityFile = path.join(dir, "auth", "identities.json");
      fs.writeFileSync(identityFile, JSON.stringify(identities, null, 1));
      tables["auth.identities"] = {
        rows: identities.length,
        file: path.relative(dir, identityFile),
        sha256: sha256(fs.readFileSync(identityFile)),
        contains_secrets: true
      };
    } catch (error) {
      warnings.push(`auth.users could not be read (${error.message.split(":")[0]}). Passwords are not in this backup — set SUPABASE_DB_URL and use pg_dump for a restore that keeps user logins.`);
    }
  }

  /* ---- schema ---- */
  for (const [name, query] of Object.entries(SCHEMA_QUERIES)) {
    try {
      const result = await sql(query);
      const file = path.join(dir, "schema", `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(result, null, 1));
      schema[name] = { rows: result.length, file: path.relative(dir, file), sha256: sha256(fs.readFileSync(file)) };
      console.log(`  ✓ schema.${name.padEnd(16)} ${String(result.length).padStart(6)} object(s)`);
    } catch (error) {
      schema[name] = { error: error.message.slice(0, 200) };
      warnings.push(`schema.${name} not readable: ${error.message.split(":")[0]}`);
    }
  }

  /* ---- storage: definitions and object counts, not bytes ---- */
  try {
    const buckets = await sql(
      `select id, name, public, file_size_limit, allowed_mime_types, created_at from storage.buckets order by id`
    );
    writeJson(path.join(dir, "storage", "buckets.json"), buckets);
    const counts = await sql(
      `select bucket_id, count(*)::int as objects, coalesce(sum((metadata->>'size')::bigint), 0)::bigint as bytes
         from storage.objects group by bucket_id order by bucket_id`
    );
    writeJson(path.join(dir, "storage", "object-counts.json"), counts);
    warnings.push("Storage object bytes are not in this backup — only bucket definitions and object counts. Files must be downloaded separately with a service-role key.");
    const totalObjects = counts.reduce((sum, row) => sum + Number(row.objects || 0), 0);
    console.log(`  ✓ storage              ${buckets.length} bucket(s), ${totalObjects} object(s) counted (bytes not copied)`);
  } catch (error) {
    warnings.push(`storage metadata not readable: ${error.message.split(":")[0]}`);
  }

  /* ---- configuration ---- */
  for (const relative of CONFIG_FILES) {
    const source = path.join(ROOT, relative);
    if (!fs.existsSync(source)) {
      warnings.push(`config file missing: ${relative}`);
      continue;
    }
    const target = path.join(dir, "config", relative.replace(/\//g, "__"));
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    console.log(`  ✓ config/${relative}`);
  }
  for (const tree of ["supabase/functions", "supabase/migrations"]) {
    const source = path.join(ROOT, tree);
    if (!fs.existsSync(source)) continue;
    const target = path.join(dir, "config", tree.replace(/\//g, "__"));
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const from = path.join(file.parentPath || file.path, file.name);
      const to = path.join(target, path.relative(source, from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    console.log(`  ✓ config/${tree.replace(/\//g, "__")}`);
  }

  /* ---- project settings we cannot read: say so, do not pretend ---- */
  warnings.push("Project settings are dashboard-only and are NOT in this backup: auth providers, SMTP, JWT secret, redirect allow-list, custom domains, API keys, Edge function secrets. Export them by hand (Settings → Auth / API / Edge Functions) into the same folder.");

  const manifest = buildManifest({
    dir,
    project: cfg.ref,
    transport,
    tables,
    schema,
    warnings,
    startedAt
  });
  writeJson(path.join(dir, "manifest.json"), manifest);

  /* ---- verify, then rehearse ---- */
  const result = await verifyBackup(dir);
  const skippedCount = Object.values(tables).filter((entry) => entry.error).length;
  const absentCount = Object.values(tables).filter((entry) => entry.absent).length;
  if (absentCount) {
    warnings.push(`${absentCount} table(s) declared in the migrations do not exist in production — production is behind the repository. Resolve before applying 0011.`);
  }
  if (skippedCount) {
    result.problems.push(`${skippedCount} table(s) could not be read — this is not a complete backup`);
    result.ok = false;
  }
  if (!manifest.counts.rows) {
    result.problems.push("no rows were exported — this is not a backup");
    result.ok = false;
  }

  fs.writeFileSync(path.join(dir, "BACKUP-REPORT.md"), report({ dir, manifest, result }));

  console.log(`\n  manifest  ${path.relative(ROOT, path.join(dir, "manifest.json"))}`);
  console.log(`  files     ${manifest.counts.files}`);
  console.log(`  rows      ${manifest.counts.rows}`);
  console.log(`  rehearsal ${result.summary.rehearsed} row(s) re-inserted into a scratch database`);
  console.log(result.ok ? "\n  ✓ backup verified\n" : "\n  ✗ backup FAILED verification\n");
  for (const problem of result.problems) console.log(`    ✗ ${problem}`);
  for (const warning of result.warnings) console.log(`    ! ${warning}`);
  process.exitCode = result.ok ? 0 : 1;
}

function report({ dir, manifest, result }) {
  const skipped = Object.entries(manifest.tables).filter(([, entry]) => entry.error);
  return `# Step 1 — backup report

- taken: ${manifest.finishedAt}
- project: ${manifest.project}
- transport: ${manifest.transport}
- folder: \`${path.basename(dir)}\`
- files: ${manifest.counts.files} (${(manifest.counts.bytes / 1024 / 1024).toFixed(2)} MB)
- tables: ${manifest.counts.tables}, rows: ${manifest.counts.rows}
- schema objects: ${manifest.counts.schema_objects}
- verification: **${result.ok ? "passed" : "FAILED"}**
- restore rehearsal: ${result.summary.rehearsed} row(s) re-inserted into a scratch database

## Read back
\`\`\`
node scripts/step1-backup.mjs --verify ${path.basename(dir)}
\`\`\`

## Warnings
${[...manifest.warnings, ...result.warnings].map((warning) => `- ${warning}`).join("\n") || "- none"}

## Tables that could not be read
${skipped.map(([table, entry]) => `- ${table}: ${entry.error}`).join("\n") || "- none"}

## Problems found by verification
${result.problems.map((problem) => `- ${problem}`).join("\n") || "- none"}
`;
}

async function verifyExisting(dir) {
  const result = await verifyBackup(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const entries = Object.values(manifest.tables || {});
  const skippedCount = entries.filter((entry) => entry.error).length;
  const absentCount = entries.filter((entry) => entry.absent).length;
  if (absentCount) console.log(`  absent in production ${absentCount} table(s) — declared in the migrations only`);
  if (skippedCount) {
    result.problems.push(`${skippedCount} table(s) could not be read — this is not a complete backup`);
    result.ok = false;
  }
  if (!manifest.counts.rows) {
    result.problems.push("no rows were exported — this is not a backup");
    result.ok = false;
  }
  console.log(`\n  Verifying ${path.relative(ROOT, dir)}\n`);
  console.log(`  files checked   ${result.summary.files}`);
  console.log(`  tables checked  ${result.summary.tables}`);
  console.log(`  rows checked    ${result.summary.rows}`);
  console.log(`  rows re-inserted ${result.summary.rehearsed}`);
  for (const problem of result.problems) console.log(`  ✗ ${problem}`);
  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  console.log(result.ok ? "\n  ✓ readable and consistent\n" : "\n  ✗ verification failed\n");
  process.exitCode = result.ok ? 0 : 1;
}

if (flag("plan")) plan();
else if (flag("verify")) {
  const target = flag("verify");
  verifyExisting(path.isAbsolute(String(target)) ? String(target) : path.join(ROOT, String(target)));
} else {
  takeBackup().catch((error) => {
    console.error("\n  Step 1 backup failed:", error.message);
    process.exitCode = 1;
  });
}
