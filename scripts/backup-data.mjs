/* ==========================================================================
   Shinzora — export every table's rows to JSON before a migration
   --------------------------------------------------------------------------
   A schema migration can only be as safe as the backup behind it. This writes
   one JSON file per table (plus a manifest with row counts and a checksum) so a
   bad migration is recoverable row by row, not just "hopefully Supabase's daily
   backup has it".

   Two transports, same as scripts/migrate.mjs:

     SUPABASE_ACCESS_TOKEN=... node scripts/backup-data.mjs
     SUPABASE_DB_URL='postgresql://…' node scripts/backup-data.mjs

   Output goes to backups/<timestamp>/ outside the repo by default, because it
   contains customer data and must never end up inside a source archive.
   ========================================================================== */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "";
const DSN = value("url") || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
const PROJECT = value("project") || process.env.SUPABASE_PROJECT_REF || "zmkgfmlcpzjfgxdmbtvi";
const OUT = value("out") || process.env.BACKUP_DIR || path.join(path.dirname(ROOT), "backups", new Date().toISOString().replace(/[:.]/g, "-"));

const transport = TOKEN ? "api" : DSN ? "psql" : null;
if (!transport) {
  console.error("\n  Provide SUPABASE_ACCESS_TOKEN or SUPABASE_DB_URL.\n");
  process.exit(1);
}

async function sql(query) {
  if (transport === "psql") {
    const result = spawnSync(
      "psql",
      [DSN, "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--field-separator=|", "-v", "ON_ERROR_STOP=1", "-c", query],
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }
    );
    if (result.status !== 0) throw new Error((result.stderr || "").split("\n")[0]);
    return (result.stdout || "")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("|"));
  }

  const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text || "[]");
}

const main = async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const tables = (await sql(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name;`
  )).map((row) => (Array.isArray(row) ? row[0] : row.table_name));

  const manifest = { created_at: new Date().toISOString(), project: PROJECT, transport, tables: {} };
  let total = 0;

  for (const table of tables) {
    // json_agg keeps column names and types as JSON, so a restore is a plain
    // insert of jsonb_populate_record per row.
    const rows = await sql(`select coalesce(json_agg(t), '[]'::json)::text from public."${table}" t;`);
    const raw = Array.isArray(rows[0]) ? rows[0][0] : rows[0]?.["coalesce"] ?? rows[0]?.json ?? "[]";
    const json = typeof raw === "string" ? raw : JSON.stringify(raw);
    const count = JSON.parse(json).length;

    fs.writeFileSync(path.join(OUT, `${table}.json`), json);
    manifest.tables[table] = { rows: count, bytes: json.length, sha256: createHash("sha256").update(json).digest("hex").slice(0, 16) };
    total += count;
    console.log(`  ${count > 0 ? "·" : " "} ${table.padEnd(24)} ${count} row${count === 1 ? "" : "s"}`);
  }

  // The auth schema is the one thing no migration recreates.
  try {
    const users = await sql(`select coalesce(json_agg(json_build_object('id', id, 'email', email, 'created_at', created_at, 'confirmed', email_confirmed_at is not null)), '[]'::json)::text from auth.users;`);
    const raw = Array.isArray(users[0]) ? users[0][0] : JSON.stringify(users);
    fs.writeFileSync(path.join(OUT, "_auth_users.json"), typeof raw === "string" ? raw : JSON.stringify(raw));
    manifest.auth_users = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)).length;
  } catch (error) {
    manifest.auth_users = `unavailable: ${error.message}`;
  }

  manifest.total_rows = total;
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\n  ${total} row${total === 1 ? "" : "s"} across ${tables.length} tables`);
  console.log(`  ${path.relative(process.cwd(), OUT) || OUT}\n`);
};

main().catch((error) => {
  console.error(`\n  ✕ Backup failed: ${error.message}\n`);
  process.exit(1);
});
