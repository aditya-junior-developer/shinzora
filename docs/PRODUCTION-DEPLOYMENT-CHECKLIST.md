# Production deployment checklist — Phase 3

**Project:** `zmkgfmlcpzjfgxdmbtvi` (`https://zmkgfmlcpzjfgxdmbtvi.supabase.co`)
**Scope:** the four pending migrations (`0006`–`0009`) and the three Edge Functions that carry the Phase 3 changes (`admin`, `payments`, `payments-webhook`).
**Written:** 7 November 2026, against the code in this repository as shipped in `shinzora-1.0.0.zip` (cache stamp `20261107a`, service worker `v16`).

> **Nothing in this document has been executed.** No migration was applied, no function was deployed, no environment variable was read or written, and no row in the live project was touched. Every state change below is yours to perform, in order, at your own pace. Everything up to this point was verified against the local staging mirror only (`node scripts/staging-db.mjs` — 84 invariants, 0 failed).

---

## 0. Before you start

### 0.1 What production should look like right now

| Object | Expected state before you begin |
| --- | --- |
| Migrations `0001`–`0005` | applied |
| Migrations `0006`–`0009` | **not** applied |
| Tables `admin_users`, `profiles`, `payments`, `service_requests`, `tickets`, `store_products` | exist, with real rows |
| Edge Functions `ai`, `config`, `site`, `domains`, `integrations` | deployed |
| Edge Functions `admin`, `payments`, `payments-webhook` | not deployed (or on an older build) |

Confirm the migration state before changing anything. In the SQL editor:

```sql
select
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='service_requests'
             and column_name='reference')                                   as m0006,
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='migration_notes')    as m0007,
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='payment_webhook_events') as m0008,
  exists (select 1 from information_schema.tables
           where table_schema='public' and table_name='admin_audit')        as m0009;
```

Expected: `m0006 | m0007 | m0008 | m0009` = `false, false, false, false`.
If any of them is already `true`, stop and tell me which — the runner is written to skip what is already there, but I want to know before it runs.

### 0.2 Tools and credentials

| Need | Why | Where |
| --- | --- | --- |
| Node.js 20 or newer | runs every script below | `node --version` |
| Supabase CLI | catalogues and deploys the functions | `npx supabase --version` (fetched on demand, no global install needed) |
| `SUPABASE_ACCESS_TOKEN` | personal access token — **required** for `apply-migrations.mjs`, `verify-migration.mjs`'s deep checks, and any CLI deploy | Dashboard → Account → Access Tokens → generate |
| `SUPABASE_DB_URL` | *optional.* When set, `db-backup.mjs` takes a `pg_dump` (complete, restorable with `psql`); when unset it uses the Management API and produces per-table JSON | Dashboard → Project Settings → Database → Connection string (URI) |
| `SUPABASE_PROJECT_REF` | *optional*, defaults to `zmkgfmlcpzjfgxdmbtvi` | — |

Export them in the shell you will use (never commit them, never paste them into chat or into a frontend file):

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
```

If you would rather not put the database password in a shell variable, skip `SUPABASE_DB_URL` entirely — every step below has a route that works without it.

### 0.3 Order of operations (do not reorder)

```
backup  →  0006  →  0007  →  0008  →  0009  →  verify  →  deploy functions  →  post-deploy tests
```

Migrations go first because the `admin` function calls functions that `0009` creates. Deploying `admin` before `0009` is applied gives you a function that starts successfully but answers `function public.admin_directory(...) does not exist` on the Access page. That is a confusing state and it is avoidable.

**Realistic duration:** 25–40 minutes, most of it the backup.

---

## 1. Backup (do this first, and do not skip it)

### 1.1 Take the backup

```bash
cd shinzora
node scripts/db-backup.mjs
```

What it does:

* Writes to `.backups/<timestamp>/` — never over an existing folder.
* With `SUPABASE_DB_URL` set: a `pg_dump` of the whole database, including `auth.users`, plus a manifest of SHA-256 hashes.
* Without it: all **35 application tables** as per-table JSON (payments, profiles, subscriptions, subscription events, admin users, the audit trail, orders, tickets, projects, integration rows), plus a snapshot of tables, columns, constraints, indexes, policies, triggers and functions, plus the same manifest.
* Refuses to write a backup it cannot read back, and prints what the folder contains and what it does not.

**What the JSON path does not contain:** `auth.users` (email addresses and password hashes), the uploaded files in Storage, and Supabase's own project settings. If you need user accounts in the backup — and for a migration whose worst case is "restore everything", you do — set `SUPABASE_DB_URL` so `pg_dump` is used. The two paths are not equivalent and the tool says so on every run.

**Treat the folder as a secret.** It contains personal data, and `integrations` / `integration_tokens` are flagged `contains_secrets` in the manifest. `.backups/` is in `.gitignore` and is excluded from `scripts/package.mjs`, so it can neither be committed nor shipped in the ZIP.

A single table, if you ever need it:

```bash
node scripts/db-backup.mjs --only payments
```

### 1.2 Verify the backup

```bash
node scripts/db-backup.mjs --verify .backups/<timestamp>
```

Expected: every table listed with `✓` and the hashes matching the manifest. **If this fails, stop here.** Do not apply migrations over a backup that does not verify — fix the backup first.

### 1.3 Copy the backup somewhere off this machine

The folder under `.backups/` is on the machine you are running this from. Download it, or copy it to storage you control. A backup that only exists on the machine that is about to change the database is not a backup.

### 1.4 Record the baseline counts

In the SQL editor:

```sql
select
  (select count(*) from public.payments)          as payments,
  (select count(*) from public.service_requests)  as service_requests,
  (select count(*) from public.profiles)          as profiles,
  (select count(*) from public.admin_users)       as admin_users,
  (select count(*) from public.tickets)           as tickets;
```

Write these five numbers down. `0006`–`0009` are additive and must not change any of them; after each migration you will compare against this row.

---

## 2. Migrations, in execution order

Four files, in this order. Each one is independent and idempotent-guarded, and each runs inside a single transaction, so a failure leaves the database exactly as it was before that file started.

| # | File | What it installs | Touches existing rows? |
| --- | --- | --- | --- |
| 0006 | `supabase/migrations/0006_service_request_tracking.sql` | `reference`, `assigned_to`, `due_at`, `accepted_at`, `completed_at` on `service_requests`; `service_request_notes` table with three RLS policies; unique index on `reference` | Adds a reference to existing requests; no rows deleted |
| 0007 | `supabase/migrations/0007_customer_reference_uniqueness.sql` | `migration_notes` table; unique index on customer references; the helper function that keeps references unique | Backfills only where a reference is missing |
| 0008 | `supabase/migrations/0008_payment_webhook_idempotency.sql` | `payment_webhook_events` table with a unique constraint; `notifications_one_per_webhook_event` index | No |
| 0009 | `supabase/migrations/0009_admin_authority_and_audit.sql` | `admin_audit`, `subscription_events`, `inventory_movements`; `protected` on `admin_users`; soft-delete and void columns on `payments`; eight functions including `admin_directory`, `set_admin_role`, `admin_reset_ai_credits`, `admin_delete_payment`, `is_superadmin`, `is_protected_owner`; the stock-history trigger; the audit read policy | Sets `protected = true` on **exactly one** row: the earliest-created super administrator |

### 2.0 Three pre-flight queries — read the output before you run anything

`0006` and `0008` are purely additive. **`0007` and `0009` both write data**, and
both of those writes are hard to undo, so look at what they will touch first.
Each answer has three possible shapes: clean, ambiguous, or broken. Clean → carry
on. Ambiguous or broken → **stop and send it to me; nothing is decided for you.**

**a. Duplicate open payments.** `0007` creates "one open payment per purpose" by
**cancelling the redundant rows** (status → `cancelled`, with an `admin_note`
recording which reference superseded them, and a row in `migration_notes`). It
keeps the row that reached `awaiting_verification`, or else the newest. If your
data has a genuine second open payment that you want to honour, deal with it now
— after the migration it is cancelled.

```sql
select owner_id, purpose, count(*) as open_rows,
       string_agg(status || ' ' || created_at::date, ', ' order by created_at) as rows
  from public.payments
 where status in ('pending', 'awaiting_verification')
 group by owner_id, purpose
having count(*) > 1;
```

No rows = nothing will be touched by that step. Rows = read them, and decide
before applying whether the keeper the migration will choose is the right one
(it keeps `awaiting_verification` first, then newest).

**b. Which account `0009` will protect.** The protected owner is the **earliest
created super administrator** — chosen by `created_at asc, user_id asc`, set by
the migration, and not changeable by any function afterwards. If a stray or
test super administrator is older than your own account, that is the row that
gets protected.

```sql
select user_id, email, role, created_at
  from public.admin_users
 order by created_at asc, user_id asc;
```

The first row with `role = 'superadmin'` is the one that will be protected. If
that is not the account you sign in with, **stop and tell me before running
`0009`** — moving the flag afterwards needs a manual `update` under break-glass,
which is exactly what this migration is supposed to make unnecessary.

**c. `admin_users` must contain a super administrator.** `0009` chooses the
protected owner from rows with `role = 'superadmin'` — the column is constrained
to `('admin','support','superadmin')`, so `owner` is not a valid value there. Two
different failures follow, and one of them is silent:

| State of `admin_users` before `0009` | What `0009` does |
| --- | --- |
| at least one `superadmin` | protects the earliest one; prints `protected owner: <email>` |
| rows exist, but none is `superadmin` | **raises** `Expected exactly one protected owner, found 0` and the whole migration rolls back — loud, safe |
| **no rows at all** | succeeds, prints `protected owner: none`, and **no account is ever protected** — silent, and only manual SQL can fix it later |

```sql
select count(*) as admin_rows,
       count(*) filter (where role = 'superadmin') as superadmins,
       count(*) filter (where protected) as already_protected
  from public.admin_users;
```

`superadmins` must be at least 1 (`already_protected` is 0 before this
migration; `protected` does not exist yet, so run the same query without that
column if it errors). If `admin_rows` is 0, or `superadmins` is 0, **stop and
tell me before running `0009`** — with 0 admin rows the migration will happily
leave the project unprotected, which is the exact failure this phase exists to
prevent.

### Route A — the runner (recommended)

It backs up again, applies one file per transaction, re-verifies each file, and stops on the first failure.

```bash
# 1. See the plan. Touches nothing, needs no credentials.
node scripts/apply-migrations.mjs --dry-run

# 2. Apply 0006, 0007, 0008 and 0009 in order.
node scripts/apply-migrations.mjs
```

Expected output: a backup block, then `✓ applied 0006_service_request_tracking.sql` through `✓ applied 0009_admin_authority_and_audit.sql`, then one verification block per migration where every line reads `ok`.

Afterwards, re-check without applying anything:

```bash
node scripts/apply-migrations.mjs --verify-only
```

Expected: every object for all four migrations verified, and the `0009` invariant **`protected owner rows that are not exactly one` = 1**.

### Route B — the SQL editor (no `SUPABASE_ACCESS_TOKEN` needed)

Open each file, paste it whole, run it, in this order. Do not edit them and do not split them — `0009` contains `do` blocks and function bodies that a naive split would break.

1. `supabase/migrations/0006_service_request_tracking.sql`
2. `supabase/migrations/0007_customer_reference_uniqueness.sql`
3. `supabase/migrations/0008_payment_webhook_idempotency.sql`
4. `supabase/migrations/0009_admin_authority_and_audit.sql`

Each ends with a `raise notice` summarising what it did. `0009` prints `0009 applied. administrator rows: N, protected owner: <email>` — read that line. If it says `protected owner: none` while you have administrator rows, something is wrong: stop and send me the output.

### Route C — the Supabase CLI

```bash
npx supabase link --project-ref zmkgfmlcpzjfgxdmbtvi
npx supabase db push --include-all
```

Only use this if you already use the CLI for migrations; it applies every file under `supabase/migrations/` that the remote migration history does not list, which is the same four files. It does **not** take the JSON backup, so do §1 first regardless.

### 2.1 After each migration

Re-run the baseline query from §1.4. The five numbers must be identical. Then:

```sql
-- 0006
select count(*) from public.service_requests where reference is null;   -- 0
select count(*) from public.service_request_notes;                      -- 0
-- 0007
select count(*) from public.migration_notes;                            -- 0
-- 0008
select count(*) from public.payment_webhook_events;                     -- 0
-- 0009
select count(*) from public.admin_audit;                                -- 0
select count(*) from public.admin_users where protected;                -- exactly 1
```

New tables start empty. A non-zero `admin_audit` before you have done anything in the console means something unexpected happened — tell me before continuing.

### 2.2 If a migration fails

Every file runs in one transaction, so **the failing file has already been rolled back in full** when you see the error. Nothing is half-applied.

1. Stop. Do not run the next file.
2. Do not re-run the failed file blindly — read the error first. The common ones:
   * `relation "public.migration_notes" already exists` — the file was partly applied by an earlier attempt outside a transaction. Verify with the §0.1 query and tell me what it reports.
   * `duplicate key value violates unique constraint` on `0007` — real duplicate customer references exist in your data. That is a data question, not a schema bug: the migration refuses to invent uniqueness by deleting rows. Send me the duplicate rows and I will write a resolving script.
   * `permission denied for function` / `must be owner` — the SQL editor session is not running as the table owner. Use the CLI route or the dashboard's SQL editor with the `postgres` role.
3. Fix the cause, or roll back explicitly with §6, then retry that one file.

---

## 3. Environment variables

Three groups. **Do not change a variable that is already set and working** — read it first (`supabase secrets list` shows names only, never values).

### 3.1 Tooling side (your shell, only for these scripts)

| Variable | Required | Used by | Notes |
| --- | --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | yes, for Routes A/C | `apply-migrations.mjs`, `verify-migration.mjs`, `deploy-functions.mjs` | dashboard → Account → Access Tokens |
| `SUPABASE_DB_URL` | optional | `db-backup.mjs`, `db-restore.mjs`, `apply-migrations.mjs` | enables `pg_dump`/`psql` backups and restores |
| `SUPABASE_PROJECT_REF` | optional | all of the above | defaults to `zmkgfmlcpzjfgxdmbtvi` |

### 3.2 Edge Function secrets (set in the project, read at runtime by the functions)

These are the full set the code reads. Nothing else is required.

| Secret | Required now? | Function | Behaviour when missing |
| --- | --- | --- | --- |
| `SUPABASE_URL` | yes | all | set automatically by the platform — do not set it by hand |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | `admin`, `payments`, `payments-webhook`, `ai`, `site` | set automatically by the platform |
| `SUPABASE_ANON_KEY` *(or `SUPABASE_PUBLISHABLE_KEY`)* | yes | all | set automatically; the code falls back to the publishable key |
| `SHINZORA_AI_API_KEY` | yes, for AI | `ai`, `config` | AI replies with a configuration error and a hint naming this secret; nothing is charged |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | alternative names | `ai` | honoured in that precedence order; **`SHINZORA_AI_API_KEY` wins** |
| `SHINZORA_AI_MODEL`, `SHINZORA_AI_MODEL_FALLBACKS`, `GEMINI_MODEL` | optional | `ai` | default `gemini-3-flash-preview`; set only to pin or override a model |
| `UPI_ID` | yes, for manual UPI | `config`, `payments` | `upi_configured: false`, and the site shows no QR block |
| `UPI_PAYEE_NAME` | optional | `config` | defaults to `Shinzora` |
| `PAYMENTS_MODE` | optional | `config` | defaults to `manual_verification` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | not needed | `config` | reported as `razorpay_configured: false` — correct for manual UPI |
| `RAZORPAY_WEBHOOK_SECRET` | only if you ever wire Razorpay | `payments-webhook` | the webhook answers `503 webhook_unconfigured` and does nothing else |
| `DOMAIN_PROVIDER`, `DOMAIN_API_KEY`, `DOMAIN_API_URL`, `DOMAIN_AVAILABILITY`, `SUBDOMAIN_ROOT` | not needed | `domains`, `config` | availability falls back to RDAP; ordering stays reported as not configured |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_SCOPES`, `GITHUB_TOKEN`, `VERCEL_TOKEN`, `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`, `INTEGRATION_ENCRYPTION_KEY` | not needed | `integrations`, `config` | the integration shows as **not connected** until OAuth actually succeeds — by design |
| `EMAIL_PROVIDER`, `SITE_ENV` | optional | `config` | `supabase`, `production` |

Set or update them with the CLI:

```bash
npx supabase secrets set --project-ref zmkgfmlcpzjfgxdmbtvi UPI_ID=yourid@bank
npx supabase secrets set --project-ref zmkgfmlcpzjfgxdmbtvi SHINZORA_AI_MODEL=gemini-3-flash-preview
npx supabase secrets list --project-ref zmkgfmlcpzjfgxdmbtvi   # names only, never values
```

or in the dashboard: **Project Settings → Edge Functions → Secrets**. Secret changes take effect for new invocations; redeploy the function if you want to be certain.

**One recommendation, unchanged from the earlier report:** the Gemini key that has been used during development is exposure-tainted. Generate a fresh key, set it as `SHINZORA_AI_API_KEY`, and do not put the old one anywhere. The AI function reports which secret it wants by name and never prints a value.

Nothing in this list belongs in the frontend. The only values the browser receives are the publishable URL and key baked into `public/js/config.js` by `node scripts/generate-config.mjs`.

---

## 4. Deploying the Edge Functions

Three functions carry the Phase 3 changes: `admin` (new: 30+ actions behind the Access, Payments, Operations, Messaging and Monitoring pages), `payments` (admin review actions), `payments-webhook` (idempotent webhook). Deploying replaces a function that exists and creates one that does not. **Nothing is deleted**, and no other function is touched.

### 4.1 JWT verification must stay as configured

| Function | JWT verification | Why |
| --- | --- | --- |
| `admin` | **on** | every action re-checks the caller's role server-side; the gateway check is the outer ring |
| `payments` | **on** | same |
| `payments-webhook` | **off** | Razorpay cannot send a Supabase JWT; it is authenticated by HMAC signature instead |

`supabase/config.toml` already encodes this, and `scripts/deploy-functions.mjs` reads it. If you use the CLI directly, pass the flags yourself (§4.3).

### 4.2 Recommended: the deployment script

```bash
# plan only — prints the exact CLI invocation per function, changes nothing
node scripts/deploy-functions.mjs --dry-run

# deploy the three
node scripts/deploy-functions.mjs admin payments payments-webhook
```

It bundles on Supabase's side (`--use-api`), so **Docker is not required**, and it passes `--no-verify-jwt` only for the functions `config.toml` marks that way.

### 4.3 Direct CLI equivalent

```bash
npx supabase functions deploy admin payments --project-ref zmkgfmlcpzjfgxdmbtvi
npx supabase functions deploy payments-webhook --no-verify-jwt --project-ref zmkgfmlcpzjfgxdmbtvi
```

`admin` and `payments` are deployed together because they share the same JWT setting; `payments-webhook` needs its flag and must not be bundled with them.

### 4.4 What success looks like

* Each function reports `Deployed Functions on project zmkgfmlcpzjfgxdmbtvi: <name>`.
* `npx supabase functions list --project-ref zmkgfmlcpzjfgxdmbtvi` shows all three, with `payments-webhook` whose `verify_jwt` column reads `false`.
* In the dashboard, each function's **Logs** tab shows the cold-start line and no `Module not found` / `Relative import path` errors.
* From a terminal, without a token, the gateway answers `401` and not `500`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://zmkgfmlcpzjfgxdmbtvi.supabase.co/functions/v1/admin' \
  -H 'Content-Type: application/json' -d '{"action":"directory"}'
```

`401` = deployed and protected. `404` = not deployed. `500` = deployed but failing to boot; read the logs.

---

## 5. Verifying that the founding account is protected

The rule `0009` installs: **exactly one** administrator row has `protected = true`. It is the earliest-created super administrator at the moment the migration ran. That flag is set by the migration and by nothing else — no function, no API action and no console button can set, clear or transfer it. The protected owner cannot be demoted, revoked or deleted by anyone, including themselves, and the "change role" action refuses any change that would leave the project with no super administrator at all.

### 5.1 SQL checks

```sql
-- exactly one protected row, and it is the oldest super administrator
select email, role, protected, created_at
from public.admin_users
order by protected desc, created_at asc;

select count(*) as protected_rows from public.admin_users where protected;   -- must be 1
select count(*) as superadmins   from public.admin_users where role = 'superadmin';  -- 1 or more
```

```sql
-- the predicate itself, for the owner's user id
select user_id, email, role, public.is_protected_owner(user_id) as protected
from public.admin_users
order by created_at asc;
```

### 5.2 Negative tests (run these — a passing read alone proves nothing)

A read-only check only proves the flag exists. These prove the guard is attached.
All three run in the SQL editor as `postgres`, so they are the strictest form:
even the table owner cannot get past the function.

```sql
-- 1. demoting the protected owner must fail
select public.set_admin_role('<protected-owner-user-id>', 'admin');
-- expected: ERROR: The protected owner account cannot be demoted or revoked.

-- 2. revoking the protected owner must fail the same way
select public.set_admin_role('<protected-owner-user-id>', 'none');
-- expected: ERROR: The protected owner account cannot be demoted or revoked.
```

Both must raise. If either **succeeds**, stop and tell me immediately: that is the
defect Phase 3 exists to close, and it means `0009` did not attach.

The third guard — *"This is the last super administrator. Promote another account
first."* — fires when a super administrator is demoted and no other super
administrator remains. With a protected owner in place that state is unreachable
through the function, because the protected row is always a super administrator
and can never be demoted; the guard is the second belt for a project whose
protected flag was never set. It is proven in the staging run
(`tests/admin-authority.test.mjs`, 58 checks) rather than something you can
trigger in production, and that is the honest description of it.

### 5.3 Who can change a role at all

Signing in as a plain `admin` (not super administrator) and calling the same
action must return *"Only a super administrator can change administrator roles."*
The Access page does not offer the control to a plain admin either — but the
refusal has to come from the database, not from the page.

### 5.4 Console checks (as the superadmin)

1. Sign in at `/admin-login` with the founding account.
2. **Access** page: your own row shows the `Protected` badge with a lock icon and **no** role dropdown; every other row has one. The page heading shows the count of administrators returned by `admin_directory`.
3. Try to change your own role from the console — the control is not offered, and if you call the action directly the function returns the same protection error.
4. **Audit** (within Access): after a role change on a second account, one `admin_audit` row appears with actor, target, previous and new role. Row-level security gives clients **no** policy on that table — it is readable only through the `admin` function.
5. **Payments**: a `verified` or `awaiting_verification` payment offers **Void**, not Delete. A `pending` payment offers Delete, and deleting it writes a `before` snapshot into `admin_audit` first.

---

## 6. If something goes wrong: rollback and recovery

Decide from the symptom:

| Symptom | Meaning | Action |
| --- | --- | --- |
| A migration raised an error | that file was rolled back automatically | fix the cause, re-run that one file (§2.2) |
| Migrations applied, functions deployed, and a bug appears in the new code | schema is fine, code is not | redeploy the previous function build, or keep `admin` undeployed (see below) |
| Migrations applied and you want the schema **gone** | a deliberate reversal | §6.2, then restore data if needed |
| Data looks wrong after a restore or a manual edit | data, not schema | §6.3 |

### 6.1 Reversing a function (the cheap, safe rollback)

`admin` is the only phase-3 function that is new. If the console misbehaves in production you can take it out of the picture without touching the database: the Access, Payments, Operations, Messaging and Monitoring pages then report that the directory function is unavailable rather than showing wrong data. Deleting or rolling back a function is a dashboard action (Functions → `admin` → delete), and it does not affect the migrations or any table. `payments` and `payments-webhook` only gained additive actions; leaving them deployed is safe.

### 6.2 Reversing the schema of 0006–0008

The exact `drop` statements, written per migration, are in **`docs/MIGRATION-REPORT.md` §8**. Run the block for the migration you want to reverse, in reverse order, and only after §6.3 has secured the data.

`0009` is deliberately **not** auto-reversible in that document: it adds the authority rules themselves. Reversing it means dropping `admin_audit` (the record of who did what), `protected`, and the guard functions, which re-opens the defect. If you believe you need to reverse `0009`, tell me first and I will write a reversal that preserves the audit trail.

### 6.3 Restoring data

```bash
# dry run — prints exactly what would be written, changes nothing
node scripts/db-restore.mjs .backups/<timestamp>

# write it
node scripts/db-restore.mjs .backups/<timestamp> --confirm

# one table only
node scripts/db-restore.mjs .backups/<timestamp> --only payments --confirm
```

What it guarantees, and what it does not:

* It **replaces** the table's rows with the backup's rows. It does not merge. Anything written after the backup is gone from that table. Before writing, the dry run now prints, per table, how many rows the database holds now against how many the backup would put there — that number is the size of what you are about to lose.
* It re-checks every row hash against the manifest and refuses a backup that has been tampered with.
* `schema_migrations` and `migration_notes` are refused outright — restoring them would desynchronise the migration history from the database.
* Each table is restored in its own transaction with `session_replication_role = replica`, so foreign keys and triggers do not fight the restore; it re-reads the row count afterwards and reports a mismatch as a failure.
* A `pg_dump` backup is not restored by this tool. It prints the exact `psql` command to run instead.
* Tables whose key comes from a sequence (`ai_usage_log`, `migration_archive` — the two `bigserial` tables) have their sequence moved past the restored ids afterwards. Without that step the next ordinary insert would reuse an id the restore just wrote and fail with a duplicate key: a 500 on an AI call, a week later, with nothing pointing at the restore.
* Because foreign-key triggers are disabled during the write, the tool finishes by counting rows whose parent no longer exists, and **exits non-zero if it finds any**. A partial restore, or a backup taken while something was inserting, shows up here rather than in a broken report three days later.

What a restore overwrites, concretely: every row of every table in the backup goes back to its state at backup time. Orders placed, payments verified, messages sent, audit entries written, projects published and credit resets granted *after* the backup are all reverted. `auth.users` is only touched by the `psql` route, which is also the only route that can restore account rows.

**Always take a fresh backup immediately before a restore.** Restoring is the one operation in this document that destroys data.

---

## 7. Post-deployment tests against the real backend

Run these after §2 and §4, in order. Each line says what success looks like, so an unexpected result is obvious.

### 7.1 Automated

```bash
# which migration objects exist, from the publishable key only
node scripts/verify-migration.mjs

# the deep version: indexes, policies and data checks (needs SUPABASE_ACCESS_TOKEN)
node scripts/verify-migration.mjs --json

# the runner's own re-verification, applying nothing
node scripts/apply-migrations.mjs --verify-only

# a post-change snapshot you can keep
node scripts/db-backup.mjs
```

Expected: all four migrations verified, the `0009` invariant at 1, no failures.

```bash
# optional, needs Deno: exercises the functions' handlers directly
deno --version && node scripts/smoke-functions.mjs --remote
```

### 7.2 Health endpoints, from a terminal

```bash
BASE='https://zmkgfmlcpzjfgxdmbtvi.supabase.co/functions/v1'

# public configuration — must not leak secrets, must be honest about what is set
curl -s "$BASE/config" | head -c 600; echo

# protected: 401 without a session
curl -s -o /dev/null -w 'admin %{http_code}\n' -X POST "$BASE/admin" -H 'Content-Type: application/json' -d '{"action":"directory"}'

# webhook: 503 webhook_unconfigured when the secret is absent, 401 when a signature is missing/wrong
curl -s -o /dev/null -w 'webhook %{http_code}\n' -X POST "$BASE/payments-webhook" -H 'Content-Type: application/json' -d '{}'
```

`/config` should report `ai.configured`, `payments.upi_configured`, `domains.provider`, `integrations.*_configured` — and every one of those booleans must match the truth in §3.2. It never contains a key.

### 7.3 In the browser, as the superadmin

| Page | Pass condition |
| --- | --- |
| `/admin/` overview | real counts from the database; no placeholder numbers |
| Access | administrator list renders; protected badge on exactly one row; role change on a second account succeeds and appears in Audit |
| Payments | list renders; a verified payment offers Void, not Delete; closing the window does **not** mark anything successful |
| Operations | service requests show references; status changes persist after a reload |
| Messaging | tickets and contacts load; a reply persists |
| Monitoring | probes return real latencies; a 403 from one probe is reported as 403, not as "healthy" |

Then reload a second time. Anything that appeared on the first load and vanished on the second was never persisted — that is the failure mode this phase is most likely to have, and it is worth one deliberate reload.

### 7.4 What is *not* covered by these tests

* Real user signup and the paid flow end to end — that needs a live payment decision from you (manual UPI).
* Password reset email delivery — the Supabase project's SMTP settings are yours to configure; the console cannot test them.
* Razorpay, domain registration and GitHub/Vercel OAuth — deliberately unconfigured; the UI reports them as not connected.

---

## 8. What cannot be rolled back

Read this before step 2, not after. Everything else in this document has a way
back; these seven things do not, or only with manual SQL.

| Operation | Why it cannot be undone | What protects you |
| --- | --- | --- |
| `0007` cancelling duplicate open payments | the row keeps its data but its status changes, and no reversal SQL restores the previous status | §2.0a — look at the duplicates first; every change is recorded in `migration_notes` and in the row's own `admin_note` |
| `0009` setting `protected = true` on one account | the flag is set by the migration only; no function, API or console action can clear or move it | §2.0b — confirm the right account is the oldest super administrator first |
| 0006/0007 backfilled references | values written into existing rows persist after the schema is dropped | harmless: they are new references, and `migration_notes` records what was written |
| A restore | `db-restore.mjs` deletes and reinserts; the current rows are gone | §1 — the backup you take *immediately before* the restore is the only copy of the state you are discarding |
| Hard-deleting a payment or record | the admin action deletes the row, having first written a `before` snapshot to `admin_audit` | that audit row is the only remaining copy; do not purge `admin_audit` |
| `drop`ping the new functions/tables by hand | the audit trail (`admin_audit`) goes with them | export `admin_audit` to a file first if you ever reverse `0009` |
| Deploying a function | Supabase keeps no automatic "previous version" you can one-click restore | the source is in the ZIP; keep the ZIP you deployed, and note which build is live |

Two operational notes that follow from the table:

* A re-run of `0009` cannot re-pick the protected owner. Once the flag exists,
  the migration deliberately leaves it alone. That is the right behaviour for
  safety and the wrong behaviour for "oops, wrong account" — hence §2.0b.
* `session_replication_role = replica` during a restore also suppresses ordinary
  triggers, so derived rows a trigger would have written (stock history, for
  example) are not regenerated. The `inventory_movements` and audit tables are
  in the backup themselves, so a full restore reinstates them; a `--only`
  restore of a single table does not.

---

## 9. Do you need a new frontend or ZIP after this?

**No.** The ZIP you already have (`shinzora-1.0.0.zip`, cache stamp `20261107a`, service worker `v16`) contains the complete Phase 3 console — the Access, Payments, Operations, Messaging and Monitoring pages, the modal helpers and the API client. The three migrations and three functions are the only things missing from production; the frontend is already waiting for them.

Consequences worth knowing:

* **Upload the ZIP as it is.** You do not need to rebuild `public/`, re-run `scripts/package.mjs`, or regenerate `js/config.js` — the publishable URL and key baked into it are the ones for your project.
* **If you re-upload the same ZIP, nothing breaks.** It is byte-identical to what you would get from rebuilding, so the cache stamp does not change and the service worker keeps serving `v16` without a duplicate install.
* **Users do not need to clear their cache.** `sw.js` at v16 takes over on the next navigation and serves the new console directly; the stamp mechanism exists so a *changed* file cannot be served stale, and nothing changed.
* **Until `admin` is deployed, the console is honest rather than broken.** The Access page reports that the administrator directory is unavailable and disables the actions that need it. That is the designed behaviour for exactly this window — verify it if you want, but there is no need to keep the window open.

The only file in the ZIP that would ever need regenerating is `public/js/config.js`, and only if the project URL or publishable key changes. They have not.

---

## 10. Record sheet

Fill this in as you go. It is the evidence that Phase 4 will be built on.

| Step | Command / action | Result | Time |
| --- | --- | --- | --- |
| §1.1 backup | `node scripts/db-backup.mjs` | folder: | |
| §1.2 verify | `node scripts/db-backup.mjs --verify …` | pass / fail | |
| §1.4 baseline | five counts | p: / sr: / pr: / au: / t: | |
| §0.1 pre-check | §0.1 query | false,false,false,false | |
| §2.0a duplicates | duplicate open payments query | none / reviewed: | |
| §2.0b owner | admin_users ordered by created_at | protected account: | |
| §2 0006 | runner or SQL editor | | |
| §2 0007 | | | |
| §2 0008 | | | |
| §2 0009 | `raise notice` line | admins: , owner: | |
| §2 verify | `--verify-only` | | |
| §3 secrets | `functions secrets list` | which of §3.2 are set | |
| §4 deploy | `deploy-functions.mjs admin payments payments-webhook` | three names | |
| §5 protected | 5.1, 5.2, 5.3 | one protected owner; two refusals | |
| §7 tests | §7.1–7.3 | | |

Anything that does not match the expected result in this document is a blocker: stop, keep the backup, and send me the exact output. Phase 4 starts once this sheet is complete and production behaves as described above.
