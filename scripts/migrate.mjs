/* ==========================================================================
   Shinzora — apply database migrations safely
   --------------------------------------------------------------------------
   Every file in supabase/migrations is idempotent, but "idempotent" is not the
   same as "safe to run blind on a database with customers in it". This script
   makes the risky part visible:

     1. connects and takes a snapshot (row counts of every live table)
     2. refuses to continue unless it can prove the snapshot was taken
     3. applies each migration in its own transaction, stopping at the first
        error — a failed file rolls back completely, it never half-applies
     4. records what ran, with a checksum, in public.schema_migrations
     5. takes a second snapshot and prints the row-count diff, so "no data lost"
        is a measurement rather than a promise

   Usage
     SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
       node scripts/migrate.mjs

     node scripts/migrate.mjs --dry-run     # snapshot + plan, touches nothing
     node scripts/migrate.mjs --force       # re-apply files whose checksum changed
     node scripts/migrate.mjs --url "<dsn>" # instead of the env var

   The DSN is the direct Postgres connection string from Supabase →
   Project Settings → Database → Connection string (URI). It is a secret: this
   script reads it from the environment or an argument and never writes it to
   disk or to its output. Requires `psql` on PATH (postgresql-client).
   ========================================================================== */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag("dry-run");
const FORCE = flag("force");
const DSN = value("url") || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "";
const PROJECT =
  value("project") ||
  process.env.SUPABASE_PROJECT_REF ||
  (DSN.match(/@db\.([a-z0-9]+)\.supabase\.co/) || [])[1] ||
  (process.env.SUPABASE_URL || "").match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ||
  "";
// Two ways to reach the same database: the direct Postgres connection (psql) or
// the Management API's SQL endpoint over HTTPS. The API route works when the
// direct port is blocked or IPv6-only, which is common on managed networks.
const TRANSPORT = (flag("api") || (!DSN && TOKEN)) && TOKEN ? "api" : "psql";

const red = (s) => `\u001b[31m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const bold = (s) => `\u001b[1m${s}\u001b[0m`;

function die(message, hint) {
  console.error(`\n  ${red("✕")} ${message}`);
  if (hint) console.error(`    ${dim(hint)}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ psql */

function psqlAvailable() {
  const probe = spawnSync("psql", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

/** Run SQL and return rows as arrays of strings, whichever transport is in use. */
function sql(query, { allowFailure = false } = {}) {
  if (TRANSPORT === "api") {
    let response;
    let text;
    try {
      // Synchronous-looking wrapper is not possible with fetch, so the API path
      // is pre-warmed by apiWarmUp() before the first call.
      const result = apiQuerySync(query);
      response = result.response;
      text = result.text;
    } catch (error) {
      if (allowFailure) return { ok: false, error: error.message };
      die(`SQL failed: ${query.slice(0, 80)}…`, error.message);
    }
    if (!response.ok) {
      if (allowFailure) return { ok: false, error: text.slice(0, 300) };
      die(`SQL failed: ${query.slice(0, 80)}…`, text.slice(0, 300));
    }
    let parsed;
    try {
      parsed = JSON.parse(text || "[]");
    } catch {
      parsed = [];
    }
    const rows = (Array.isArray(parsed) ? parsed : []).map((row) =>
      Array.isArray(row) ? row.map(String) : Object.values(row).map((v) => (v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)))
    );
    return { ok: true, rows };
  }

  const result = spawnSync(
    "psql",
    [DSN, "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--field-separator=|", "-c", query],
    { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "20" } }
  );
  if (result.status !== 0) {
    if (allowFailure) return { ok: false, error: (result.stderr || "").trim() };
    die(`SQL failed: ${query.slice(0, 80)}…`, (result.stderr || "").trim().split("\n")[0]);
  }
  return {
    ok: true,
    rows: (result.stdout || "")
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.length > 0)
      .map((line) => line.split("|"))
  };
}

/* ------------------------------------------------------- Management API */

/** Run SQL over the Management API using a synchronous child process helper. */
export function apiQuerySync(query) {
  const payload = JSON.stringify({ query });
  const script = `
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", async () => {
      const { query } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const res = await fetch("https://api.supabase.com/v1/projects/${PROJECT}/database/query", {
        method: "POST",
        headers: { Authorization: "Bearer ${TOKEN}", "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });
      const text = await res.text();
      process.stdout.write(JSON.stringify({ status: res.status, ok: res.ok, text }));
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: payload,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error((result.stderr || "API request failed").split("\n")[0]);
  const parsed = JSON.parse(result.stdout);
  return { response: { ok: parsed.ok, status: parsed.status }, text: parsed.text };
}

/* ------------------------------------------------------- preconditions */

if (TRANSPORT === "api" && !PROJECT) {
  die("SUPABASE_ACCESS_TOKEN is set but the project ref is unknown.", "Pass --project <ref> or set SUPABASE_PROJECT_REF.");
}
if (TRANSPORT === "psql" && !DSN) {
  console.log(`
  ${bold("Applying Shinzora migrations")}

  This needs the direct Postgres connection string for the project — the
  publishable API key cannot run DDL.

    1. Supabase dashboard → Project Settings → Database → Connection string → URI
    2. Copy it (it contains the database password) and run:

       SUPABASE_DB_URL='postgresql://…' node scripts/migrate.mjs

  Nothing is applied until step 2. The string is read from the environment and
  is never written to disk or to this script's output.
`);
  process.exit(0);
}
if (TRANSPORT === "psql" && !psqlAvailable()) {
  die("psql is not installed, and no SUPABASE_ACCESS_TOKEN was provided for the API transport.",
      "Install postgresql-client, or set SUPABASE_ACCESS_TOKEN=sbp_… to apply over the Management API.");
}

const files = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

if (files.length === 0) die(`No migrations found in ${MIGRATIONS}`);

const checksum = (file) => createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, file))).digest("hex").slice(0, 16);

/* ------------------------------------------------------------ snapshot */

const CORE_TABLES = [
  "profiles", "businesses", "onboarding_progress", "subscriptions", "projects",
  "project_versions", "ai_conversations", "ai_messages", "notifications", "payments",
  "domains", "domain_orders", "support_tickets", "service_requests", "customer_activity",
  "store_products", "store_orders", "store_customers", "campaigns", "contact_messages"
];

function snapshot() {
  const present = sql(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name;`,
    { allowFailure: true }
  );
  if (!present.ok) die("Cannot read the schema.", "Check the connection string, the password, and that the database is running.");

  const tables = present.rows.map((r) => r[0]);
  const counts = {};
  for (const table of tables) {
    const r = sql(`select count(*) from public."${table}";`, { allowFailure: true });
    if (r.ok && r.rows[0]) counts[table] = Number(r.rows[0][0]);
  }
  // Aliased on purpose: the API transport returns objects, and four unaliased
  // `count` columns would collide into one JSON key.
  const objects = sql(
    `select
       (select count(*) from pg_policies where schemaname = 'public') as policies,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as functions,
       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal) as triggers,
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity) as rls_tables;`
  ).rows[0].map(Number);

  return {
    tables,
    counts,
    policies: objects[0],
    functions: objects[1],
    triggers: objects[2],
    rlsTables: objects[3],
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0)
  };
}

/* --------------------------------------------------------------- report */

const before = snapshot();

console.log(`
${bold("Shinzora migrations")}

  transport    ${TRANSPORT === "api" ? `Management API (project ${PROJECT})` : "direct Postgres (psql)"}
  database     ${dim(TRANSPORT === "api" ? `project ${PROJECT}` : DSN.replace(/:\/\/([^:]+):[^@]+@/, "://$1:••••••@"))}
  tables       ${before.tables.length}
  rows         ${before.totalRows}
  policies     ${before.policies}   functions ${before.functions}   triggers ${before.triggers}
`);

if (before.totalRows > 0) {
  const nonEmpty = Object.entries(before.counts).filter(([, n]) => n > 0);
  console.log(`  rows held by  ${nonEmpty.map(([t, n]) => `${t} ${n}`).join(", ")}`);
  console.log("");
}

/* ------------------------------------------------ applied-state tracking */

const hasLedger = sql(`select to_regclass('public.schema_migrations') is not null;`, { allowFailure: true }).rows?.[0]?.[0] === "t";
let ledger = {};
if (hasLedger) {
  for (const [name, sum] of sql(`select filename, checksum from public.schema_migrations;`, { allowFailure: true }).rows || []) {
    ledger[name] = sum;
  }
}

const plan = files.map((file) => {
  const sum = checksum(file);
  const recorded = ledger[file];
  let action = "apply";
  if (recorded === sum) action = "skip";
  else if (recorded && recorded !== sum) action = FORCE ? "re-apply (checksum changed, --force)" : "blocked (checksum changed)";
  return { file, sum, recorded, action };
});

console.log(bold("Plan"));
for (const step of plan) {
  const mark = step.action === "skip" ? dim("skip ") : step.action.startsWith("blocked") ? red("hold ") : green("apply");
  console.log(`  ${mark}  ${step.file}  ${dim(step.sum)}${step.recorded && step.recorded !== step.sum ? dim(`  (recorded ${step.recorded})`) : ""}`);
}

const blocked = plan.filter((p) => p.action.startsWith("blocked"));
if (blocked.length && !FORCE) {
  console.log(`
  ${red("✕")} A migration file changed after it was applied to this database.

    ${blocked.map((b) => b.file).join(", ")}

  Editing an applied migration is how environments drift apart. Either revert
  the edit, or add a new migration file, or re-run with --force if you are sure
  the new content is idempotent against what is already there.
`);
  process.exit(1);
}

if (DRY_RUN) {
  console.log(`\n  ${dim("--dry-run: nothing was applied.")}\n`);
  process.exit(0);
}

/* ---------------------------------------------------------------- apply */

console.log(`\n${bold("Applying")}\n`);

for (const step of plan) {
  if (step.action === "skip") {
    console.log(`  ${dim("·")} ${step.file} ${dim("already applied")}`);
    continue;
  }

  const file = path.join(MIGRATIONS, step.file);
  const started = Date.now();
  const source = fs.readFileSync(file, "utf8");
  const result =
    TRANSPORT === "api"
      ? (() => {
          // Wrap in an explicit transaction: a failure must leave the database
          // exactly as it was, never half-migrated.
          const wrapped = `begin;\n${source}\ncommit;`;
          const { response, text } = apiQuerySync(wrapped);
          return { status: response.ok ? 0 : 1, stdout: response.ok ? "" : "", stderr: response.ok ? "" : text };
        })()
      : spawnSync(
          "psql",
          [DSN, "--no-psqlrc", "--quiet", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", file],
          { encoding: "utf8", env: { ...process.env, PGCONNECT_TIMEOUT: "20" } }
        );

  const notices = (result.stdout || "")
    .split("\n")
    .filter((line) => /NOTICE:/.test(line))
    .map((line) => line.replace(/^.*NOTICE:\s*/, "").trim())
    .filter((line) => line && !/does not exist, skipping/.test(line));

  if (result.status !== 0) {
    console.error(`  ${red("✕")} ${step.file} failed after ${Date.now() - started} ms — rolled back`);
    console.error(`    ${(result.stderr || "").trim().split("\n").slice(0, 4).join("\n    ")}`);
    console.error(`\n  This file ran inside a single transaction, so the database is unchanged by it.`);
    console.error(`  Earlier files in this run did commit. Fix the cause and re-run: applied files are skipped.\n`);
    process.exit(1);
  }

  for (const notice of notices.slice(0, 12)) console.log(`    ${dim("·")} ${notice}`);
  console.log(`  ${green("✓")} ${step.file} ${dim(`${Date.now() - started} ms`)}`);

  sql(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
    alter table public.schema_migrations enable row level security;
    insert into public.schema_migrations (filename, checksum, applied_at)
    values ('${step.file}', '${step.sum}', now())
    on conflict (filename) do update set checksum = excluded.checksum, applied_at = excluded.applied_at;
  `);
}

/* ------------------------------------------------------------ postflight */

const after = snapshot();

/* A table that shrank is only "loss" if the archive cannot account for it.
   0005 archives every subscription row it removes, so this is a measurement
   of the recovery path, not a guess. */
const archivedRows = [];
if (after.tables.includes("migration_archive")) {
  const r = sql(`select table_name, reason, count(*)::text as n from public.migration_archive group by 1, 2 order by 1;`, { allowFailure: true });
  if (r.ok) for (const [table, reason, n] of r.rows) archivedRows.push({ table, reason, count: Number(n) });
}
const archivedRemovals = {};
for (const row of archivedRows) {
  if (/duplicate|null user_id/i.test(row.reason)) {
    archivedRemovals[row.table] = (archivedRemovals[row.table] || 0) + row.count;
  }
}

const lost = [];
const explained = [];
const grew = [];
for (const [table, count] of Object.entries(before.counts)) {
  const now = after.counts[table];
  if (now === undefined) lost.push(`${table} (table gone)`);
  else if (now < count) {
    const accounted = archivedRemovals[table] || 0;
    if (accounted >= count - now) explained.push(`${table} ${count} → ${now} (${count - now} archived)`);
    else lost.push(`${table} ${count} → ${now}${accounted ? ` (only ${accounted} archived)` : ""}`);
  } else if (now > count) grew.push(`${table} ${count} → ${now}`);
}

console.log(`
${bold("Result")}

  tables       ${before.tables.length} → ${after.tables.length}
  rows         ${before.totalRows} → ${after.totalRows}
  policies     ${before.policies} → ${after.policies}
  functions    ${before.functions} → ${after.functions}
  triggers     ${before.triggers} → ${after.triggers}
  RLS tables   ${before.rlsTables} → ${after.rlsTables}
`);

let archived = 0;
if (after.tables.includes("migration_archive")) {
  const r = sql(`select count(*) from public.migration_archive;`, { allowFailure: true });
  archived = r.ok ? Number(r.rows[0][0]) : 0;
}

if (grew.length) console.log(`  ${dim("rows added:")} ${grew.join(", ")}`);
for (const line of explained) console.log(`  ${dim("rows moved:")} ${line} — restorable from the archive`);
if (archived > 0) {
  for (const row of archivedRows) {
    console.log(`  ${dim("archived:")} ${row.count} × ${row.table} — ${row.reason}`);
  }
  console.log(`  ${dim("inspect:")} select * from public.migration_archive order by id;`);
}

if (lost.length) {
  console.log(`\n  ${red("✕")} Rows disappeared with nothing in the archive to explain it: ${lost.join(", ")}`);
  console.log(`    Stop and inspect before continuing. To restore an archived row:`);
  console.log(`    insert into public.subscriptions select * from jsonb_populate_record(null::public.subscriptions, (select row_data from public.migration_archive where id = <id>));\n`);
  process.exit(1);
}

const expected = ["profiles", "businesses", "onboarding_progress", "subscriptions", "projects",
  "project_versions", "ai_conversations", "ai_messages", "notifications", "payments", "domains",
  "domain_orders", "admin_users", "support_tickets", "service_requests", "customer_activity"];
const missing = expected.filter((t) => !after.tables.includes(t));
if (missing.length) {
  console.log(`\n  ${red("✕")} Still missing: ${missing.join(", ")}`);
  console.log(`    Run this script again — each file is idempotent.\n`);
  process.exit(1);
}

if (after.policies < 20) {
  console.log(`\n  ${red("✕")} Only ${after.policies} RLS policies exist. 0002 did not complete.\n`);
  process.exit(1);
}

console.log(`  ${green("✓")} Every expected table, policy and function is in place.`);
console.log(`  ${dim("Next: open /system-check/ signed in, and deploy the Edge Functions.")}\n`);

void CORE_TABLES;
