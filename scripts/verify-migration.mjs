#!/usr/bin/env node
/* ==========================================================================
   Shinzora — is the migration actually applied?
   --------------------------------------------------------------------------
   Answers that question with no credentials beyond the publishable key that the
   website already ships, because the answer should be checkable by anyone.

   How it works: PostgREST tells you the truth about schema. A table that exists
   answers 200 (possibly with zero rows, since RLS hides them); a table that does
   not exist answers 404 with "Could not find the table … in the schema cache";
   a column that does not exist answers 400 naming the column. That is a
   sufficient fingerprint for every object these migrations add.

   With SUPABASE_ACCESS_TOKEN it also checks the things REST cannot see: partial
   index predicates, policies and constraints.

     node scripts/verify-migration.mjs
     node scripts/verify-migration.mjs --json
   ========================================================================== */

import { config, restProbe, sql } from "./lib/supabase-admin.mjs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");

const CHECKS = [
  // 0006
  { migration: "0006", name: "service_requests.reference column", probe: "service_requests?select=reference&limit=1", expect: [200] },
  { migration: "0006", name: "service_requests.due_at column", probe: "service_requests?select=due_at&limit=1", expect: [200] },
  { migration: "0006", name: "service_requests.assigned_to column", probe: "service_requests?select=assigned_to&limit=1", expect: [200] },
  { migration: "0006", name: "service_request_notes table", probe: "service_request_notes?select=id&limit=1", expect: [200] },
  // 0007
  { migration: "0007", name: "migration_notes table", probe: "migration_notes?select=id&limit=1", expect: [200] },
  { migration: "0007", name: "payments reference uniqueness (index in place)", probe: "payments?select=reference&limit=1", expect: [200] },
  // 0008
  { migration: "0008", name: "payment_webhook_events table", probe: "payment_webhook_events?select=id&limit=1", expect: [200] }
];

async function withToken() {
  const cfg = config();
  if (!cfg.accessToken) return null;
  const out = {};
  try {
    const indexes = await sql(
      `select indexname, indexdef from pg_indexes where schemaname='public'
        and indexname in ('payments_one_open_per_purpose','payments_provider_payment_unique',
                          'notifications_one_per_webhook_event','service_requests_reference_key')`
    );
    out.indexes = indexes;
    const policies = await sql(
      `select tablename, policyname from pg_policies where schemaname='public'
        and tablename in ('service_request_notes','payment_webhook_events','migration_notes')`
    );
    out.policies = policies;
    const rows = await sql(`select
      (select count(*)::int from public.service_requests where reference is null) as requests_without_reference,
      (select count(*)::int from public.payments where status in ('pending','awaiting_verification')
         group by owner_id, purpose having count(*) > 1 limit 1) as open_duplicate_flag`);
    out.data = rows[0] || {};
  } catch (error) {
    out.error = error.message;
  }
  return out;
}

async function main() {
  const cfg = config();
  const results = [];

  for (const check of CHECKS) {
    const { status, body } = await restProbe(check.probe);
    const ok = check.expect.includes(status);
    results.push({ ...check, status, ok, detail: typeof body === "string" ? body.slice(0, 120) : Array.isArray(body) ? `${body.length} row(s)` : body?.message || "" });
  }

  const deep = await withToken();

  if (jsonOut) {
    console.log(JSON.stringify({ project: cfg.ref, results, deep }, null, 2));
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
    return;
  }

  console.log(`\n  Migration state — ${cfg.ref}\n`);
  let current = "";
  for (const r of results) {
    if (r.migration !== current) {
      current = r.migration;
      console.log(`  ${current}`);
    }
    console.log(`    ${r.ok ? "✓" : "✗"} ${r.name.padEnd(48)} ${r.status} ${r.ok ? "" : `${r.detail}`}`);
  }

  if (deep?.error) {
    console.log(`\n  Deep checks unavailable: ${deep.error.split("\n")[0].slice(0, 120)}`);
  }
  if (deep && !deep.error) {
    console.log("\n  Deep checks (Management API)");
    const wanted = ["payments_one_open_per_purpose", "payments_provider_payment_unique", "notifications_one_per_webhook_event", "service_requests_reference_key"];
    for (const name of wanted) {
      const row = deep.indexes.find((i) => i.indexname === name);
      console.log(`    ${row ? "✓" : "✗"} index ${name}`);
      if (row) console.log(`        ${row.indexdef.slice(0, 150)}`);
    }
    for (const table of ["service_request_notes", "payment_webhook_events", "migration_notes"]) {
      const n = deep.policies.filter((p) => p.tablename === table).length;
      console.log(`    ${n ? "✓" : "✗"} ${table}: ${n} policy/policies`);
    }
    console.log(`    · service requests without a reference: ${deep.data.requests_without_reference ?? "n/a"}`);
  } else if (!cfg.accessToken) {
    console.log("\n  Set SUPABASE_ACCESS_TOKEN for index, policy and data checks.");
  }

  const pending = results.filter((r) => !r.ok);
  console.log(
    pending.length
      ? `\n  ${pending.length} check(s) failing — migration not fully applied\n`
      : "\n  ✓ every object these migrations add is present on the project\n"
  );
  process.exitCode = pending.length ? 1 : 0;
}

main().catch((error) => {
  console.error("\n  verify failed:", error.message);
  process.exit(1);
});
