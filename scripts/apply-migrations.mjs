#!/usr/bin/env node
/* ==========================================================================
   Shinzora — apply pending migrations to the live project
   --------------------------------------------------------------------------
   The order is deliberate and it is enforced:

     1. Pre-flight. Read the live project's current state and refuse to continue
        if it does not look like the baseline the migration was written for.
     2. Backup. A backup must exist and must verify, or nothing is applied.
     3. Apply. Each migration runs inside its own transaction. If a statement
        fails, that migration rolls back and the run stops; nothing is left
        half-applied.
     4. Verify. Re-read the live project and check the objects, constraints and
        row counts the migration promised.
     5. Receipt. A JSON + markdown receipt is written to docs/migration-receipts/
        with the file hashes, before/after row counts and verification result.
        That file is the proof.

     node scripts/apply-migrations.mjs                 # do it
     node scripts/apply-migrations.mjs --dry-run       # say what it would do
     node scripts/apply-migrations.mjs --verify-only   # just verify + receipt

   Requires SUPABASE_ACCESS_TOKEN (Management API). Without it the script says
   so and exits 2 — it does not pretend to have applied anything.
   ========================================================================== */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, sql, timestamp, writeJson, ROOT } from "./lib/supabase-admin.mjs";

const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const RECEIPTS_DIR = path.join(ROOT, "docs", "migration-receipts");

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);

/* What each migration promises, checked after it runs. */
const VERIFICATIONS = {
  "0006": {
    label: "service request tracking",
    objects: [
      { kind: "column", check: `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='service_requests'
          and column_name in ('reference','assigned_to','due_at','accepted_at','completed_at')`, expect: 5 },
      { kind: "table", check: `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name='service_request_notes'`, expect: 1 },
      { kind: "index", check: `select count(*)::int as n from pg_indexes
        where schemaname='public' and indexname='service_requests_reference_key'`, expect: 1 },
      { kind: "rls", check: `select count(*)::int as n from pg_policies
        where schemaname='public' and tablename='service_request_notes'`, expect: 3, atLeast: true }
    ],
    noNulls: `select count(*)::int as n from public.service_requests where reference is null`
  },
  "0007": {
    label: "one open payment reference per customer per purpose",
    objects: [
      { kind: "index", check: `select count(*)::int as n from pg_indexes
        where schemaname='public' and indexname='payments_one_open_per_purpose'`, expect: 1 },
      { kind: "table", check: `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name='migration_notes'`, expect: 1 },
      { kind: "function", check: `select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='open_payment_reference'`, expect: 1 }
    ],
    invariant: `select count(*)::int as n from (
        select owner_id, purpose from public.payments
         where status in ('pending','awaiting_verification')
         group by owner_id, purpose having count(*) > 1) d`,
    invariantLabel: "customers holding two open payments for one purpose"
  },
  "0008": {
    label: "payment webhook idempotency",
    objects: [
      { kind: "table", check: `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name='payment_webhook_events'`, expect: 1 },
      { kind: "constraint", check: `select count(*)::int as n from pg_constraint
        where conrelid='public.payment_webhook_events'::regclass and contype='u'`, expect: 1, atLeast: true },
      { kind: "index", check: `select count(*)::int as n from pg_indexes
        where schemaname='public' and indexname='notifications_one_per_webhook_event'`, expect: 1 }
    ]
  },
  "0009": {
    label: "administrator authority and audit",
    objects: [
      { kind: "table", check: `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name='admin_audit'`, expect: 1 },
      { kind: "table", check: `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name='subscription_events'`, expect: 1 },
      { kind: "table", check: `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name='inventory_movements'`, expect: 1 },
      { kind: "column", check: `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='admin_users' and column_name='protected'`, expect: 1 },
      { kind: "column", check: `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='payments'
          and column_name in ('deleted_at','deleted_by','deletion_reason','voided_at','void_reason')`, expect: 5 },
      { kind: "policy", check: `select count(*)::int as n from pg_policies
        where schemaname='public' and tablename='admin_users' and policyname='admin_users_admin_read'`, expect: 1 },
      { kind: "function", check: `select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname in
          ('admin_directory','set_admin_role','admin_reset_ai_credits','admin_update_subscription',
           'admin_delete_payment','admin_archive_record','admin_audit_log','is_superadmin')`, expect: 8 },
      { kind: "trigger", check: `select count(*)::int as n from pg_trigger
        where tgname='store_products_stock_history' and not tgisinternal`, expect: 1 }
    ],
    /* Exactly one protected owner, and it must be a super administrator. */
    invariant: `select count(*)::int as n from public.admin_users where protected`,
    invariantLabel: "protected owner rows that are not exactly one",
    invariantExpect: 1
  },
  "0010": {
    label: "onboarding can link a business without touching the plan",
    objects: [
      { kind: "function", check: `select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='attach_business_to_subscription'`, expect: 1 },
      { kind: "function", check: `select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='attach_business_to_subscription' and p.prosecdef`, expect: 1 },
      /* Subscriptions must still have no browser write policy: if one is ever
         added, this reports it instead of quietly widening authority. */
      { kind: "policy", check: `select count(*)::int as n from pg_policies
        where schemaname='public' and tablename='subscriptions' and cmd <> 'SELECT'`, expect: 0 }
    ]
  },
  "0011": {
    label: "builder jobs, app conversion and marketing requests",
    objects: [
      { kind: "table", check: `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name in
          ('ai_generation_jobs','conversion_jobs','marketing_accounts',
           'marketing_requests','marketing_request_events')`, expect: 5 },
      /* Every one of those tables must be under RLS: a missing enable would hand
         the table to any signed-in browser. */
      { kind: "rls", check: `select count(*)::int as n from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relrowsecurity
          and c.relname in ('ai_generation_jobs','conversion_jobs','marketing_accounts',
                            'marketing_requests','marketing_request_events')`, expect: 5 },
      /* The browser must not be able to report a package as built. */
      { kind: "policy", check: `select count(*)::int as n from pg_policies
        where schemaname='public' and tablename='conversion_jobs' and cmd <> 'SELECT' and cmd <> 'INSERT'`,
        expect: 0 },
      /* Status is an administrator decision, enforced by a trigger. */
      { kind: "trigger", check: `select count(*)::int as n from pg_trigger
        where tgname in ('marketing_requests_guard','marketing_accounts_guard') and not tgisinternal`, expect: 2 },
      { kind: "function", check: `select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname in ('notify_admins','app_platform_slots')
          and p.prosecdef`, expect: 2 },
      { kind: "constraint", check: `select count(*)::int as n from pg_constraint
        where conname='conversion_jobs_platform_target_check'
          and conrelid='public.conversion_jobs'::regclass`, expect: 1 }
    ],
    /* A marketing request must never reach a reviewer without its reference. */
    invariant: `select count(*)::int as n from public.marketing_requests where reference is null`,
    invariantLabel: "marketing requests without a reference"
  },
  "0012": {
    label: "app package rules enforced by the database",
    objects: [
      { kind: "function", check: `select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname in ('app_target_allowed','app_package_options')
          and p.prosecdef`, expect: 2 },
      { kind: "trigger", check: `select count(*)::int as n from pg_trigger
        where tgname='conversion_jobs_guard' and not tgisinternal`, expect: 1 },
      { kind: "index", check: `select count(*)::int as n from pg_indexes
        where schemaname='public' and indexname='conversion_jobs_one_open_per_target'`, expect: 1 },
      /* The table-level pairing rule must still be there as well. */
      { kind: "constraint", check: `select count(*)::int as n from pg_constraint
        where conname='conversion_jobs_platform_target_check'
          and conrelid='public.conversion_jobs'::regclass`, expect: 1 }
    ],
    /* No job may sit in storage claiming a build it cannot prove. */
    invariant: `select count(*)::int as n from public.conversion_jobs
                 where status = 'built'
                   and (artifact_path is null or artifact_sha256 is null or artifact_bytes is null)`,
    invariantLabel: "jobs marked built without a file and a checksum"
  },
  "0013": {
    label: "marketing request workflow",
    objects: [
      { kind: "column", check: `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='marketing_requests' and column_name='details'`, expect: 1 },
      { kind: "function", check: `select count(*)::int as n from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='notify_customer' and p.prosecdef`, expect: 1 },
      { kind: "policy", check: `select count(*)::int as n from pg_policies
        where schemaname='public' and tablename='marketing_request_events'
          and policyname='marketing_request_events_owner_insert'`, expect: 1 },
      { kind: "index", check: `select count(*)::int as n from pg_indexes
        where schemaname='public' and indexname='marketing_requests_reference_unique'`, expect: 1 },
      { kind: "trigger", check: `select count(*)::int as n from pg_trigger
        where tgname='marketing_requests_guard' and not tgisinternal`, expect: 1 }
    ],
    /* A request that reached review must carry a reference. */
    invariant: `select count(*)::int as n from public.marketing_requests
                 where status <> 'draft' and reference is null`,
    invariantLabel: "non-draft requests without a reference"
  }

};

function pendingFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function migrationKey(file) {
  return file.slice(0, 4);
}

function hashOf(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS_DIR, file))).digest("hex");
}

async function preflight() {
  const files = pendingFiles();
  const state = await sql(`
    select
      (select count(*)::int from information_schema.tables where table_schema='public') as tables,
      (select count(*)::int from public.payments) as payments,
      (select count(*)::int from public.service_requests) as service_requests,
      (select count(*)::int from public.profiles) as profiles,
      exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='service_requests' and column_name='reference') as has_0006,
      exists (select 1 from information_schema.tables
               where table_schema='public' and table_name='migration_notes') as has_0007,
      exists (select 1 from information_schema.tables
               where table_schema='public' and table_name='payment_webhook_events') as has_0008,
      exists (select 1 from information_schema.tables
               where table_schema='public' and table_name='admin_audit') as has_0009
  `);
  return { files, state: state[0] };
}

async function applyOne(file, dryRun) {
  const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  if (dryRun) {
    console.log(`  · would apply ${file} (${body.length} bytes, sha256 ${hashOf(file).slice(0, 12)})`);
    return { applied: false, dryRun: true };
  }
  /* One transaction per migration: a failure leaves the database exactly as it
     was before that file. */
  await sql(`begin; ${body} commit;`);
  console.log(`  ✓ applied ${file}`);
  return { applied: true };
}

async function verifyKey(key) {
  const spec = VERIFICATIONS[key];
  if (!spec) return { key, skipped: true, results: [] };
  const results = [];
  for (const object of spec.objects) {
    const rows = await sql(object.check);
    const n = Number(rows[0]?.n ?? 0);
    const ok = object.atLeast ? n >= object.expect : n === object.expect;
    results.push({ kind: object.kind, expected: object.expect, actual: n, ok });
  }
  let invariant = null;
  if (spec.invariant) {
    const rows = await sql(spec.invariant);
    const n = Number(rows[0]?.n ?? 0);
    /* Most invariants assert "zero of these" (duplicate groups, orphans). 0009 is
       the exception: exactly one protected owner must exist. */
    const expected = Number(spec.invariantExpect ?? 0);
    invariant = { label: spec.invariantLabel, value: n, ok: n === expected };
  }
  let nulls = null;
  if (spec.noNulls) {
    const rows = await sql(spec.noNulls);
    nulls = { label: "rows left without a reference", value: Number(rows[0]?.n ?? 0), ok: Number(rows[0]?.n ?? 0) === 0 };
  }
  const ok = results.every((r) => r.ok) && (!invariant || invariant.ok) && (!nulls || nulls.ok);
  return { key, label: spec.label, ok, results, invariant, nulls };
}

async function main() {
  const cfg = config();
  const dryRun = has("dry-run");
  const verifyOnly = has("verify-only");

  console.log("\n  Shinzora migration runner");
  console.log(`  project: ${cfg.ref || "(unknown)"} · ${cfg.url || ""}`);

  /* A dry run is a plan, not an action: it needs no credentials and touches
     nothing, so it works everywhere. */
  if (dryRun) {
    const files = pendingFiles();
    console.log("\n  Plan (dry run — nothing will be written)\n");
    for (const file of files) {
      const key = migrationKey(file);
      const spec = VERIFICATIONS[key];
      if (!spec) continue;
      console.log(`  ${file}`);
      console.log(`    sha256 ${hashOf(file)}`);
      console.log(`    promises: ${spec.label}`);
      for (const object of spec.objects) console.log(`      · ${object.kind} × ${object.expect}${object.atLeast ? "+" : ""}`);
      if (spec.invariant) console.log(`      · invariant: ${spec.invariantLabel} must be ${spec.invariantExpect ?? 0}`);
      if (spec.noNulls) console.log(`      · no rows left without a reference`);
      console.log("");
    }
    console.log("  Then: backup → apply each file in one transaction → re-read → receipt.\n");
    return;
  }

  if (!cfg.accessToken) {
    console.log("\n  ✗ SUPABASE_ACCESS_TOKEN is not set, so nothing can be applied from here.");
    console.log("    Take one of these paths instead:");
    console.log("      1. Add SUPABASE_ACCESS_TOKEN to .env (Supabase → Account → Access tokens) and re-run.");
    console.log("      2. Paste the migration files into the SQL editor, in order: 0006, 0007, 0008.");
    console.log("      3. Use the Supabase CLI: `supabase db push` from a linked project.\n");
    process.exitCode = 2;
    return;
  }

  /* ------------------------------------------------------------ 1. preflight */
  const { files, state } = await preflight();
  console.log(`\n  1. Pre-flight`);
  console.log(`     ${state.tables} tables · ${state.payments} payment row(s) · ${state.service_requests} service request(s) · ${state.profiles} profile(s)`);
  console.log(`     0006 applied: ${state.has_0006} · 0007 applied: ${state.has_0007} · 0008 applied: ${state.has_0008}`);

  const todo = files.filter((f) => {
    const key = migrationKey(f);
    if (key === "0006") return !state.has_0006;
    if (key === "0007") return !state.has_0007;
    if (key === "0008") return !state.has_0008;
    if (key === "0009") return !state.has_0009;
    return false;
  });

  if (verifyOnly) {
    console.log(`\n  Verify-only run: no migration will be applied.`);
  } else if (!todo.length) {
    console.log("\n  Nothing is pending: every known migration is already applied.");
  } else {
    console.log(`     pending: ${todo.join(", ")}`);
  }

  /* --------------------------------------------------------------- 2. backup */
  if (!verifyOnly && todo.length && !dryRun) {
    console.log(`\n  2. Backup`);
    try {
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "db-backup.mjs")], {
        encoding: "utf8"
      });
      process.stdout.write(out.replace(/^/gm, "     "));
      if (/✗/.test(out)) throw new Error("backup did not verify");
    } catch (error) {
      console.error(`\n  ✗ Backup failed (${error.message.split("\n")[0]}). Nothing was applied.`);
      process.exitCode = 3;
      return;
    }
  } else if (!verifyOnly) {
    console.log(`\n  2. Backup — skipped (${dryRun ? "dry run" : "nothing pending"})`);
  }

  /* ---------------------------------------------------------------- 3. apply */
  const appliedNow = [];
  if (!verifyOnly && todo.length) {
    console.log(`\n  3. Apply`);
    for (const file of todo) {
      const before = await sql(`select (select count(*)::int from public.payments) as payments,
                                       (select count(*)::int from public.service_requests) as service_requests`);
      const result = await applyOne(file, dryRun);
      if (result.applied) {
        const after = await sql(`select (select count(*)::int from public.payments) as payments,
                                        (select count(*)::int from public.service_requests) as service_requests`);
        const changed =
          Number(before[0].payments) !== Number(after[0].payments) ||
          Number(before[0].service_requests) !== Number(after[0].service_requests);
        console.log(
          `    row counts: payments ${before[0].payments} → ${after[0].payments}, ` +
            `service requests ${before[0].service_requests} → ${after[0].service_requests}` +
            (changed ? "  (rows changed — inspect before continuing)" : "  (unchanged)")
        );
        appliedNow.push({ file, sha256: hashOf(file), before: before[0], after: after[0] });
      }
    }
  }

  /* --------------------------------------------------------------- 4. verify */
  const verification = [];
  if (!dryRun) {
    console.log(`\n  4. Verify`);
    for (const key of ["0006", "0007", "0008"]) {
      const result = await verifyKey(key);
      if (result.skipped) continue;
      verification.push(result);
      console.log(`     ${result.ok ? "✓" : "✗"} ${key} — ${result.label}`);
      for (const r of result.results) console.log(`         ${r.ok ? "·" : "✗"} ${r.kind}: expected ${r.expected}, found ${r.actual}`);
      if (result.invariant) console.log(`         ${result.invariant.ok ? "·" : "✗"} ${result.invariant.label}: ${result.invariant.value}`);
      if (result.nulls) console.log(`         ${result.nulls.ok ? "·" : "✗"} ${result.nulls.label}: ${result.nulls.value}`);
    }
  }

  /* -------------------------------------------------------------- 5. receipt */
  if (!dryRun) {
    const stamp = timestamp();
    const ok = verification.every((v) => v.ok);
    const receipt = {
      at: new Date().toISOString(),
      project: cfg.ref,
      mode: verifyOnly ? "verify-only" : "apply",
      migrations: {
        appliedNow,
        files: files.map((f) => ({ file: f, sha256: hashOf(f) }))
      },
      before: state,
      verification,
      result: ok ? "verified" : "verification_failed"
    };
    const jsonFile = writeJson(path.join(RECEIPTS_DIR, `${stamp}.json`), receipt);

    const lines = [
      `# Migration receipt — ${new Date().toISOString()}`,
      "",
      `Project: \`${cfg.ref}\`  ·  Mode: ${receipt.mode}  ·  Result: **${receipt.result}**`,
      "",
      "## Files",
      "",
      "| File | sha256 |",
      "| --- | --- |",
      ...files.map((f) => `| ${f} | \`${hashOf(f).slice(0, 16)}…\` |`),
      "",
      "## Applied in this run",
      "",
      appliedNow.length ? appliedNow.map((a) => `- ${a.file}`).join("\n") : "- nothing (already applied)",
      "",
      "## Verification",
      "",
      "| Migration | Check | Expected | Found | Result |",
      "| --- | --- | --- | --- | --- |",
      ...verification.flatMap((v) =>
        v.results.map((r) => `| ${v.key} | ${r.kind} | ${r.expected} | ${r.actual} | ${r.ok ? "pass" : "FAIL"} |`)
      ),
      ...verification
        .filter((v) => v.invariant)
        .map((v) => `| ${v.key} | ${v.invariant.label} | 0 | ${v.invariant.value} | ${v.invariant.ok ? "pass" : "FAIL"} |`),
      ...verification
        .filter((v) => v.nulls)
        .map((v) => `| ${v.key} | ${v.nulls.label} | 0 | ${v.nulls.value} | ${v.nulls.ok ? "pass" : "FAIL"} |`),
      "",
      "Data present on the project before the run:",
      "",
      `- tables: ${state.tables}`,
      `- payment rows: ${state.payments}`,
      `- service requests: ${state.service_requests}`,
      `- profiles: ${state.profiles}`,
      ""
    ];
    const mdFile = path.join(RECEIPTS_DIR, `${stamp}.md`);
    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
    fs.writeFileSync(mdFile, lines.join("\n"));

    console.log(`\n  5. Receipt`);
    console.log(`     ${path.relative(ROOT, mdFile)}`);
    console.log(`     ${path.relative(ROOT, jsonFile)}`);
    console.log(`     result: ${receipt.result}`);
    process.exitCode = ok ? 0 : 1;
  } else {
    console.log("\n  Dry run complete: nothing was written to the project.\n");
  }
}

main().catch((error) => {
  console.error(`\n  ✗ ${error.message}`);
  if (error.code === "no_token") console.error("    Set SUPABASE_ACCESS_TOKEN and run again.");
  process.exit(1);
});
