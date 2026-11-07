/* ==========================================================================
   Shinzora — Step 1 backup kit (pure functions)
   --------------------------------------------------------------------------
   The pieces of a pre-migration backup that are worth testing without a
   network: build the manifest, verify it, and rehearse a restore into a
   throwaway database.

   The rehearsal is deliberately modest about what it proves. It shows that
   every data file parses, carries the row count the manifest claims, has the
   same column set the schema snapshot recorded, and can be re-inserted into a
   table with the same column types. Schema objects, policies, triggers,
   functions, storage bytes and Edge function secrets are *not* covered by it.
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const sha256 = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

export function walk(dir) {
  const out = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

/** Hash every file under `dir`, skipping the manifest itself. */
export function hashTree(dir) {
  const files = {};
  for (const file of walk(dir)) {
    const relative = path.relative(dir, file).split(path.sep).join("/");
    if (relative === "manifest.json") continue;
    files[relative] = { sha256: sha256(fs.readFileSync(file)), bytes: fs.statSync(file).size };
  }
  return files;
}

export function buildManifest({ dir, project, transport, tables, schema, warnings = [], startedAt }) {
  const files = hashTree(dir);
  const totalRows = Object.values(tables).reduce((sum, entry) => sum + (entry.rows || 0), 0);
  return {
    kit: "shinzora-step1-backup",
    version: 1,
    project,
    transport,
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    counts: {
      files: Object.keys(files).length,
      bytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0),
      tables: Object.keys(tables).length,
      rows: totalRows,
      schema_objects: Object.values(schema).reduce((sum, entry) => sum + (entry.rows || 0), 0)
    },
    tables,
    schema,
    files,
    warnings
  };
}

/**
 * Verify a backup directory.
 *
 *  1. every file in the manifest still exists and still hashes to the same value
 *  2. no file appeared in the directory that the manifest does not know about
 *  3. every table file parses, is an array, and has the claimed row count
 *  4. every row's keys match the columns the schema snapshot recorded
 *  5. (when PGlite is available) the rows can be inserted into a scratch table
 *     with the same column types
 *
 * Returns { ok, problems, warnings, summary }.
 */
export async function verifyBackup(dir, { rehearse = true } = {}) {
  const problems = [];
  const warnings = [];
  const summary = { files: 0, tables: 0, rows: 0, rehearsed: 0 };

  const manifestFile = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    return { ok: false, problems: [`no manifest.json in ${dir}`], warnings, summary };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  /* 1 — hashes */
  for (const [relative, entry] of Object.entries(manifest.files || {})) {
    const file = path.join(dir, relative);
    if (!fs.existsSync(file)) {
      problems.push(`missing file: ${relative}`);
      continue;
    }
    const actual = sha256(fs.readFileSync(file));
    if (actual !== entry.sha256) problems.push(`hash changed: ${relative}`);
    summary.files += 1;
  }

  /* 2 — unknown files */
  const known = new Set(Object.keys(manifest.files || {}));
  for (const file of walk(dir)) {
    const relative = path.relative(dir, file).split(path.sep).join("/");
    if (relative === "manifest.json" || relative === "BACKUP-REPORT.md") continue;
    if (!known.has(relative)) warnings.push(`file not covered by the manifest: ${relative}`);
  }

  /* 3 + 4 — table files */
  const columns = readColumns(dir);
  const parsed = {};
  for (const [table, entry] of Object.entries(manifest.tables || {})) {
    if (entry.absent) {
      summary.absent = (summary.absent || 0) + 1;
      warnings.push(`table ${table} does not exist in production (declared in the migrations only)`);
      continue;
    }
    if (entry.error) {
      problems.push(`table ${table} is missing from this backup: ${entry.error}`);
      continue;
    }
    const file = path.join(dir, entry.file);
    if (!fs.existsSync(file)) {
      problems.push(`missing table file: ${entry.file}`);
      continue;
    }
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      problems.push(`table ${table} does not parse: ${error.message}`);
      continue;
    }
    if (!Array.isArray(rows)) {
      problems.push(`table ${table} is not a JSON array`);
      continue;
    }
    if (rows.length !== entry.rows) {
      problems.push(`table ${table} has ${rows.length} rows, manifest claims ${entry.rows}`);
    }
    const expected = columns[table];
    if (expected) {
      const allowed = new Set(expected);
      for (const [index, row] of rows.entries()) {
        for (const key of Object.keys(row)) {
          if (!allowed.has(key)) {
            problems.push(`table ${table} row ${index} has a column the schema does not: ${key}`);
            break;
          }
        }
      }
    }
    parsed[table] = { rows, types: typeMap(readColumnTypes(dir, table)) };
    summary.tables += 1;
    summary.rows += rows.length;
  }

  /* 5 — rehearsal into a scratch database */
  if (rehearse && Object.keys(parsed).length) {
    const outcome = await rehearseInsert(parsed);
    summary.rehearsed = outcome.inserted || 0;
    problems.push(...outcome.problems);
    warnings.push(...outcome.warnings);
  }

  return { ok: problems.length === 0, problems, warnings, summary };
}

function readColumns(dir) {
  const byTable = {};
  for (const row of columnRows(dir)) {
    (byTable[row.table_name] ||= []).push(row.column_name);
  }
  return byTable;
}

/** public + auth column snapshots, whichever of them exist */
function columnRows(dir) {
  const rows = [];
  for (const name of ["columns.json", "auth_columns.json", "auth-columns.json"]) {
    const file = path.join(dir, "schema", name);
    if (!fs.existsSync(file)) continue;
    rows.push(...JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return rows;
}

function readColumnTypes(dir, table) {
  /* manifest keys are schema-qualified ("auth.users"); the snapshots are not */
  const bare = table.includes(".") ? table.split('.').pop() : table;
  return columnRows(dir).filter((row) => row.table_name === table || row.table_name === bare);
}

const TYPE_MAP = {
  uuid: "uuid",
  "character varying": "text",
  text: "text",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  date: "date",
  "time without time zone": "time",
  jsonb: "jsonb",
  json: "jsonb",
  boolean: "boolean",
  integer: "integer",
  bigint: "bigint",
  smallint: "smallint",
  numeric: "numeric",
  "double precision": "double precision",
  "real": "real",
  ARRAY: "text[]"
};

function typeMap(columnRows) {
  const out = {};
  for (const column of columnRows) {
    out[column.column_name] = TYPE_MAP[column.data_type] || "text";
  }
  return out;
}

/* --------------------------------------------------------------- rehearsal */

/** Async half of the rehearsal: insert every row into a scratch table. */
export async function rehearseInsert(parsed) {
  let PGlite;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    return { ok: null, inserted: 0, problems: [], warnings: ["PGlite is unavailable — insert rehearsal skipped."] };
  }

  const db = new PGlite();
  const problems = [];
  const warnings = [];
  let inserted = 0;

  for (const [table, { rows, types }] of Object.entries(parsed)) {
    if (!rows.length) continue;
    const names = Object.keys(types);
    if (!names.length) {
      warnings.push(`rehearsal skipped for ${table}: no column types were captured`);
      continue;
    }
    const scratch = `scratch_${table.replace(/[^a-z0-9_]/gi, "_")}`;
    const ddl = `create table ${scratch} (${names.map((name) => `"${name}" ${types[name]}`).join(", ")})`;
    try {
      await db.exec(ddl);
    } catch (error) {
      problems.push(`rehearsal: could not create a scratch table for ${table}: ${error.message.slice(0, 120)}`);
      continue;
    }
    try {
      const insert = `insert into ${scratch} (${names.map((n) => `"${n}"`).join(", ")}) values (${names
        .map((name, index) => (types[name] === "jsonb" ? `$${index + 1}::jsonb` : `$${index + 1}`))
        .join(", ")})`;
      for (const row of rows) {
        const params = names.map((name) => {
          const value = row[name] ?? null;
          if (value !== null && typeof value === "object") return JSON.stringify(value);
          return value;
        });
        await db.query(insert, params);
        inserted += 1;
      }
      const { rows: counted } = await db.query(`select count(*)::int as n from ${scratch}`);
      if (counted[0].n !== rows.length) problems.push(`rehearsal: ${table} inserted ${counted[0].n} of ${rows.length} rows`);
    } catch (error) {
      problems.push(`rehearsal: inserting ${table} failed: ${error.message.slice(0, 160)}`);
    }
  }

  await db.close?.();
  return { ok: problems.length === 0, inserted, problems, warnings };
}
