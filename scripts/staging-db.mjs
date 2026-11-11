#!/usr/bin/env node
/* ==========================================================================
   Shinzora — staging database harness
   --------------------------------------------------------------------------
   Runs the real migration files against a real PostgreSQL engine (PGlite:
   PostgreSQL 18 compiled to WebAssembly) with the smallest Supabase-shaped
   scaffolding around it: an `auth` schema, the three API roles, a `storage`
   schema and a realtime publication.

   The sequence is the point. It recreates today's live database (0001…0005),
   fills it with the kind of rows a live database actually holds — including the
   duplicates the new constraints are meant to stop — and only then applies
   0006, 0007 and 0008. If a migration would lose or corrupt a row, this fails
   here instead of on the customer's data.

     node scripts/staging-db.mjs                  # full staging run
     node scripts/staging-db.mjs --json           # machine-readable report
     node scripts/staging-db.mjs --split 0003     # stop louder/staged differently
     node scripts/staging-db.mjs --keep           # leave the DB in /tmp for poking

   Nothing here connects to Supabase. This is a developer tool, not shipped code.
   ========================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};

/* ------------------------------------------------------------------ stubs ---
   Supabase owns these; the migrations legitimately reference them. Only the
   contract the SQL actually uses is recreated. */
const SCAFFOLD = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;

  create schema if not exists auth;
  create schema if not exists storage;

  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb default '{}'::jsonb,
    email_confirmed_at timestamptz,
    last_sign_in_at timestamptz,
    created_at timestamptz not null default now()
  );

  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  create or replace function auth.role() returns text
  language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
  $$;

  create table if not exists storage.buckets (
    id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[],
    created_at timestamptz default now()
  );
  create table if not exists storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id) on delete cascade,
    name text, owner uuid, metadata jsonb, created_at timestamptz default now()
  );

  -- Supabase's storage helper: every path segment except the file name.
  create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$
    select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
  $$;

  create or replace function storage.filename(name text) returns text
  language sql immutable as $$ select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;

  create or replace function storage.extension(name text) returns text
  language sql immutable as $$ select split_part((string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)], '.', 2) $$;

  do $$ begin
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      create publication supabase_realtime;
    end if;
  end $$;

  -- Supabase Vault: where 0038 keeps the shared secret the push trigger presents.
  -- A bare PostgreSQL has no vault, so this is the smallest thing a migration
  -- can call: create a secret, list its plaintext, nothing to unlock.
  create schema if not exists vault;
  create table if not exists vault.secrets (
    id uuid primary key default gen_random_uuid(),
    name text unique,
    description text,
    secret text,
    created_at timestamptz not null default now()
  );
  create or replace view vault.decrypted_secrets as
    select id, name, description, secret as decrypted_secret, created_at from vault.secrets;
  create or replace function vault.create_secret(secret text, name text, description text default null)
  returns uuid language sql as $$
    insert into vault.secrets (secret, name, description) values (secret, name, description) returning id
  $$;

  -- pg_net: the outbound HTTP queue. The real extension performs the request;
  -- this one records it, so a test can assert *what would have been sent* —
  -- which is the part the trigger owns. Nothing is fetched either way.
  create schema if not exists net;
  create table if not exists net.requests (
    id bigserial primary key,
    url text not null,
    headers jsonb not null default '{}'::jsonb,
    body jsonb not null default '{}'::jsonb,
    timeout_milliseconds integer,
    at timestamptz not null default now()
  );
  create or replace function net.http_post(
    url text,
    headers jsonb default '{}'::jsonb,
    body jsonb default '{}'::jsonb,
    timeout_milliseconds integer default 5000
  ) returns bigint language sql as $$
    insert into net.requests (url, headers, body, timeout_milliseconds)
    values (url, headers, body, timeout_milliseconds)
    returning id
  $$;
`;

/* ----------------------------------------------------------------- shims ---
   The two statements a bare PostgreSQL cannot execute. Both are no-ops here and
   both are explained where they are used:
     · pgcrypto — PGlite does not ship the extension, and every function the
       migrations take from it (gen_random_uuid) has been core since PG13.
     · 0004 refuses to run without an auth user, so the harness registers that
       user first — which is exactly what the live project did by hand. */
const SHIMS = [
  {
    match: /create extension if not exists "?pgcrypto"?;/gi,
    replace: "-- [staging] pgcrypto shimmed: gen_random_uuid() has been core since PG13"
  },
  {
    /* pg_net is a Supabase-managed extension. The scaffold above provides the
       one function the migrations call, so the extension statement is skipped. */
    match: /create extension if not exists pg_net with schema extensions;/gi,
    replace: "-- [staging] pg_net shimmed: net.http_post() is a no-op in the scaffold"
  }
];

/* --------------------------------------------------------------- reporting --*/
const log = [];
const record = (level, area, message) => {
  log.push({ level, area, message });
  if (!flag("json")) {
    const mark = { pass: "  ✓", fail: "  ✗", warn: "  !", info: "  ·" }[level] || "  ·";
    console.log(`${mark} ${area ? `[${area}] ` : ""}${message}`);
  }
};
const api = {
  pass: (area, msg) => record("pass", area, msg),
  fail: (area, msg) => record("fail", area, msg),
  warn: (area, msg) => record("warn", area, msg),
  info: (msg) => record("info", "", msg)
};

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function apply(db, file) {
  let sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
  for (const shim of SHIMS) sql = sql.replace(shim.match, shim.replace);

  /* 0004 grants administrator rights to an existing auth user and refuses to
     run without one. The live project did that by hand through /auth/signup/,
     so the harness registers the same account first — otherwise the migration
     is being tested in a state it never meant to handle. */
  if (file.startsWith("0004")) {
    for (const email of sql.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
      await db.query(
        `insert into auth.users (email) values ($1) on conflict (email) do nothing`,
        [email]
      );
      await db.query(
        `insert into public.profiles (id, full_name, email)
         select id, 'Bootstrap Administrator', email from auth.users where lower(email) = lower($1)
         on conflict (id) do nothing`,
        [email]
      );
    }
  }

  try {
    await db.exec(sql);
  } catch (error) {
    /* A failed batch leaves the session in an aborted transaction; clear it so
       the next migration can still be attempted and reported honestly. */
    await db.exec("rollback").catch(() => {});
    throw error;
  }
}

/* ------------------------------------------------------------------- main ---*/
async function main() {
  const split = String(flag("split", "0005"));
  const files = migrationFiles();
  const legacy = files.filter((f) => Number(f.slice(0, 4)) <= Number(split.slice(0, 4)));
  const upgrades = files.filter((f) => Number(f.slice(0, 4)) > Number(split.slice(0, 4)));

  api.info(`engine: PostgreSQL 18 (PGlite) · replaying ${legacy.join(", ")} then ${upgrades.join(", ") || "nothing"}`);

  const dir = flag("keep") ? path.join(os.tmpdir(), `shinzora-staging-${Date.now()}`) : undefined;
  const db = new PGlite(dir);
  await db.exec(SCAFFOLD);
  api.pass("scaffold", "auth, storage, roles and realtime publication in place");

  /* 1 — today's live schema */
  for (const file of legacy) {
    try {
      await apply(db, file);
      api.pass("baseline", `${file} applied`);
    } catch (error) {
      api.fail("baseline", `${file} → ${error.message.split("\n")[0]}`);
    }
  }

  /* 2 — rows that exist today, duplicates included */
  const fixtures = await import("./staging-fixtures.mjs");
  const seeded = await fixtures.seed(db);
  api.pass("fixture", `${seeded.payments} payments, ${seeded.serviceRequests} service requests, ${seeded.customers} store customers`);

  /* 3 — the upgrades under review */
  for (const file of upgrades) {
    try {
      await apply(db, file);
      api.pass("upgrade", `${file} applied cleanly`);
    } catch (error) {
      api.fail("upgrade", `${file} → ${error.message.split("\n")[0]}`);
    }
  }

  /* 4 — invariants */
  const checks = await import("./staging-checks.mjs");
  await checks.run(db, api, { fixtures: seeded });

  /* 5 — idempotency: run everything again on the migrated database */
  for (const file of files) {
    try {
      await apply(db, file);
      api.pass("re-run", `${file} is idempotent`);
    } catch (error) {
      api.fail("re-run", `${file} → ${error.message.split("\n")[0]}`);
    }
  }

  const failed = log.filter((l) => l.level === "fail");
  const warnCount = log.filter((l) => l.level === "warn").length;
  const checked = log.filter((l) => l.level === "pass" || l.level === "fail").length;

  if (flag("json")) {
    console.log(JSON.stringify({ summary: { checks: checked, failed: failed.length, warnings: warnCount }, log }, null, 2));
  } else {
    console.log(`\n  ${checked} checks · ${failed.length} failed · ${warnCount} warnings`);
    console.log(failed.length ? "  ✗ STAGING FAILED\n" : "  ✓ STAGING PASSED\n");
  }

  if (dir && !flag("json")) console.log(`  database kept at ${dir}\n`);
  await db.close();
  process.exitCode = failed.length ? 1 : 0;
}

/* Exported so other tests can replay the migrations with the same scaffold and
   shims instead of hand-rolling a second copy that drifts. */
export { SCAFFOLD, SHIMS, migrationFiles, apply };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("\n  harness error:", error);
    process.exit(1);
  });
}
