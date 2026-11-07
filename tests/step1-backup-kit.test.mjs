/* ==========================================================================
   The Step 1 backup kit, tested without a network.
   --------------------------------------------------------------------------
   A backup that has never been read back is a folder of hopes. These tests
   build a synthetic backup with the same shape the real script writes, verify
   it, then break it in four different ways and require the verifier to notice.
   ========================================================================== */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, verifyBackup } from "../scripts/lib/backup-kit.mjs";

let pass = 0, fail = 0;
const check = (name, condition, detail = "") =>
  condition ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name} ${detail}`));

function makeBackup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shinzora-backup-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "schema"), { recursive: true });

  const columns = [
    { table_name: "businesses", column_name: "id", data_type: "uuid" },
    { table_name: "businesses", column_name: "name", data_type: "text" },
    { table_name: "businesses", column_name: "meta", data_type: "jsonb" },
    { table_name: "payments", column_name: "id", data_type: "uuid" },
    { table_name: "payments", column_name: "amount", data_type: "numeric" }
  ];
  fs.writeFileSync(path.join(dir, "schema", "columns.json"), JSON.stringify(columns, null, 1));

  const businesses = [
    { id: "11111111-1111-1111-1111-111111111111", name: "Aarav Studio", meta: { plan: "growth" } },
    { id: "22222222-2222-2222-2222-222222222222", name: "Meera Textiles", meta: { plan: "free" } }
  ];
  const payments = [{ id: "33333333-3333-3333-3333-333333333333", amount: 2499 }];
  fs.writeFileSync(path.join(dir, "data", "businesses.json"), JSON.stringify(businesses, null, 1));
  fs.writeFileSync(path.join(dir, "data", "payments.json"), JSON.stringify(payments, null, 1));

  const manifest = buildManifest({
    dir,
    project: "synthetic",
    transport: "management-api",
    tables: {
      businesses: { rows: 2, file: "data/businesses.json" },
      payments: { rows: 1, file: "data/payments.json" }
    },
    schema: { columns: { rows: 5, file: "schema/columns.json" } }
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  return dir;
}

/* ---------------------------------------------------------------- happy path */
const good = makeBackup();
const clean = await verifyBackup(good);
check("a well-formed backup verifies", clean.ok === true, JSON.stringify(clean.problems));
check("every file is hashed", clean.summary.files === 3, String(clean.summary.files));
check("every table is read", clean.summary.tables === 2, String(clean.summary.tables));
check("every row is counted", clean.summary.rows === 3, String(clean.summary.rows));
check("the rows are re-inserted into a scratch database", clean.summary.rehearsed === 3, String(clean.summary.rehearsed));

/* ---------------------------------------------------------------- tampering */
const tampered = makeBackup();
fs.appendFileSync(path.join(tampered, "data", "businesses.json"), " ");
const tamperResult = await verifyBackup(tampered);
check("a changed file fails verification", tamperResult.ok === false);
check(
  "the failure names the file",
  tamperResult.problems.some((problem) => problem.includes("businesses.json")),
  JSON.stringify(tamperResult.problems)
);

const truncated = makeBackup();
fs.writeFileSync(path.join(truncated, "data", "businesses.json"), JSON.stringify([{ id: "11111111-1111-1111-1111-111111111111", name: "Aarav Studio", meta: {} }], null, 1));
const truncatedResult = await verifyBackup(truncated);
check("a table with missing rows fails verification", truncatedResult.ok === false);
check(
  "the failure states both counts",
  truncatedResult.problems.some((problem) => /1 rows, manifest claims 2/.test(problem)),
  JSON.stringify(truncatedResult.problems)
);

const extraColumn = makeBackup();
fs.writeFileSync(
  path.join(extraColumn, "data", "payments.json"),
  JSON.stringify([{ id: "33333333-3333-3333-3333-333333333333", amount: 2499, injected: true }], null, 1)
);
const extraResult = await verifyBackup(extraColumn);
check(
  "a column the schema never had is reported",
  extraResult.problems.some((problem) => problem.includes("injected")),
  JSON.stringify(extraResult.problems)
);

const missing = makeBackup();
fs.rmSync(path.join(missing, "data", "payments.json"));
const missingResult = await verifyBackup(missing);
check("a missing table file fails verification", missingResult.ok === false);

const stray = makeBackup();
fs.writeFileSync(path.join(stray, "notes.txt"), "half a backup");
const strayResult = await verifyBackup(stray);
check("a file the manifest does not know about is warned about", strayResult.warnings.some((w) => w.includes("notes.txt")));
check("an unknown file does not fail verification on its own", strayResult.ok === true);

/* a table the export could not read is missing data, so it must fail the run */
const skipped = makeBackup();
const skippedManifest = JSON.parse(fs.readFileSync(path.join(skipped, "manifest.json"), "utf8"));
skippedManifest.tables.payments = { error: "Management API 403" };
fs.writeFileSync(path.join(skipped, "manifest.json"), JSON.stringify(skippedManifest, null, 1));
const skippedResult = await verifyBackup(skipped);
check("a table the export could not read fails verification", skippedResult.ok === false);
check(
  "the failure names the missing table",
  skippedResult.problems.some((problem) => problem.includes("payments is missing")),
  JSON.stringify(skippedResult.problems)
);

const empty = fs.mkdtempSync(path.join(os.tmpdir(), "shinzora-empty-"));
const emptyResult = await verifyBackup(empty);
check("a folder with no manifest is refused", emptyResult.ok === false);

for (const dir of [good, tampered, truncated, extraColumn, missing, stray, skipped, empty]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
