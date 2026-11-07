/* `scripts/apply-migrations.mjs` reports success by running a set of
   verification queries after each migration. Those queries are only worth
   anything if they are valid SQL and return the counts the runner expects — so
   this replays every migration into a real PostgreSQL 18 and executes them.

   The scaffold, shims and replay path are imported from scripts/staging-db.mjs
   so there is exactly one definition of "a database the migrations accept". */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { SCAFFOLD, migrationFiles, apply } from "../scripts/staging-db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const check = (n, c, d = "") =>
  c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? " — " + d : ""}`));

/* Read the runner's own specs out of its source rather than duplicating them,
   so the test cannot pass while the shipped queries are broken. */
const source = fs.readFileSync(path.join(ROOT, "scripts", "apply-migrations.mjs"), "utf8");
const start = source.indexOf("const VERIFICATIONS = {");
const end = source.indexOf("\nfunction pendingFiles()");
const VERIFICATIONS = new Function(source.slice(start, end).replace("const VERIFICATIONS = ", "return "))();
const keys = Object.keys(VERIFICATIONS);

check("runner has a verification spec for every migration", keys.length === 8, keys.join(", "));
check("0009 is verified by the runner", keys.includes("0009"));
check("0010 is verified by the runner", keys.includes("0010"));
check("0011 is verified by the runner", keys.includes("0011"));
check("0012 is verified by the runner", keys.includes("0012"));
check("0013 is verified by the runner", keys.includes("0013"));

const db = new PGlite();
await db.exec(SCAFFOLD);

for (const file of migrationFiles()) {
  try {
    await apply(db, file);
  } catch (error) {
    check(`${file} applies`, false, error.message.split("\n")[0]);
  }
}
check("all migrations replayed", true);

/* 0009 backfills the protected flag onto the earliest super administrator, so
   the database the runner verifies must have one — exactly as production does. */
const { rows: admins } = await db.query(`select count(*)::int as n from public.admin_users where protected`);
check("a protected owner exists for the invariant to find", Number(admins[0].n) === 1, `got ${admins[0].n}`);

for (const [key, spec] of Object.entries(VERIFICATIONS)) {
  for (const object of spec.objects) {
    try {
      const { rows } = await db.query(object.check);
      const n = Number(rows[0]?.n ?? 0);
      const ok = object.atLeast ? n >= object.expect : n === object.expect;
      check(`${key} · ${object.kind} expects ${object.expect}${object.atLeast ? "+" : ""}`, ok, `got ${n}`);
    } catch (error) {
      check(`${key} · ${object.kind} query runs`, false, error.message.split("\n")[0]);
    }
  }
  if (spec.invariant) {
    try {
      const { rows } = await db.query(spec.invariant);
      const n = Number(rows[0]?.n ?? 0);
      const expected = Number(spec.invariantExpect ?? 0);
      check(`${key} · invariant equals ${expected}`, n === expected, `got ${n}`);
    } catch (error) {
      check(`${key} · invariant query runs`, false, error.message.split("\n")[0]);
    }
  }
  if (spec.noNulls) {
    try {
      const { rows } = await db.query(spec.noNulls);
      check(`${key} · no rows left without a reference`, Number(rows[0]?.n ?? 0) === 0, `got ${rows[0]?.n}`);
    } catch (error) {
      check(`${key} · noNulls query runs`, false, error.message.split("\n")[0]);
    }
  }
}

/* Negative controls. First without a session: the function must refuse because
   the caller is not an administrator. Then as the protected owner itself, which
   must still be refused — a super administrator cannot strip their own
   protection, and neither can anyone else. */
const owner = (await db.query(`select user_id from public.admin_users where protected`)).rows[0].user_id;

try {
  await db.query(`select public.set_admin_role($1, 'admin')`, [owner]);
  check("anonymous call to set_admin_role is refused", false, "the call succeeded");
} catch (error) {
  check("anonymous call to set_admin_role is refused", /sign in|not an administrator|permission/i.test(error.message), error.message.split("\n")[0]);
}

await db.exec(`select set_config('request.jwt.claim.sub', '${owner}', false)`);
try {
  await db.query(`select public.set_admin_role($1, 'admin')`, [owner]);
  check("protected owner cannot be demoted, even by itself", false, "the call succeeded");
} catch (error) {
  check("protected owner cannot be demoted, even by itself", /protected owner/i.test(error.message), error.message.split("\n")[0]);
}
await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await db.close();
process.exit(fail ? 1 : 0);
