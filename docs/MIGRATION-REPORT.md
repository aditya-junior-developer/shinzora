# Migration report — 0006, 0007, 0008

Status: **reviewed, replayed against a real PostgreSQL engine, not yet applied to the live project.**
The blocker is a credential, not the work. Details below, in the order you asked for them.

---

## 1. What the three migrations do

| File | What it adds | Why it exists |
| --- | --- | --- |
| `0006_service_request_tracking.sql` | `reference`, `assigned_to`, `due_at`, `accepted_at`, `completed_at` on `service_requests`; backfill from each row's own id; a trigger that issues `SR-XXXXXXXX` on insert; `service_request_notes` (visibility `internal` / `customer`) | A request a customer can follow needs an identity, an owner and a target date. Internal notes cannot live on the request row, because RLS is row level — a note there is readable by the customer the moment they select their own row. |
| `0007_customer_reference_uniqueness.sql` | `migration_notes` (audit of what a migration changed), a partial unique index `payments_one_open_per_purpose` on `(owner_id, purpose)` for open rows, and `open_payment_reference(owner, purpose)` | Two clicks on Pay used to mint two references for one intent. The index is the guarantee; the function is how the API reuses instead of inserting. |
| `0008_payment_webhook_idempotency.sql` | `payment_webhook_events` inbox with `unique (provider, event_id)`, `payments_provider_payment_unique`, `notifications_one_per_webhook_event` | A gateway retries. Without an inbox, every retry is indistinguishable from a new payment. |

All three are additive: no `drop table`, no column rename, no data deleted. Two of them inspect the data first and record what they found in `migration_notes` before changing anything.

## 2. Review findings, fixed before staging

| Finding | Fix |
| --- | --- |
| 0006 used `create or replace function` for a trigger function — fine, but it also needed to be re-runnable | The whole file is idempotent; verified by replaying it twice |
| A column-level `revoke`/`grant` on `service_requests` would have hidden `assigned_to` and `due_at` from the admin panel too, because an administrator is also role `authenticated` | Removed. Row-level security already scopes rows correctly, and private data lives in `service_request_notes` |
| 0007 would fail to create its unique index on a database that already holds duplicates | Added a pre-flight count, a deterministic duplicate resolution that keeps the row carrying a submitted proof, and an explicit notice. Superseded rows are marked `cancelled` with an explanation — nothing is deleted |
| 0008's `payments_provider_payment_unique` would fail on existing duplicate gateway payments | Created conditionally, after counting duplicates, and the count is recorded |
| Migration changes were invisible afterwards | `migration_notes` records pre-flight numbers, each superseded row and the final index state |

## 3. Staging test — a real PostgreSQL, real rows, real duplicates

`scripts/staging-db.mjs` runs the actual migration files against PostgreSQL 18 (PGlite, Postgres compiled to WebAssembly) with a Supabase-shaped scaffold: `auth.users`, `auth.uid()`, `storage.objects`, the three API roles and a realtime publication.

It replays **today's live schema** (`0001`…`0005`), fills it with the kind of rows a live database actually holds — including the duplicates the new constraints are meant to stop — and only then applies `0006`, `0007`, `0008`. Then it checks 57 invariants and re-runs every migration to prove idempotency.

```
node scripts/staging-db.mjs
  · engine: PostgreSQL 18 (PGlite) · replaying 0001…0005 then 0006, 0007, 0008
  ✓ [baseline] 0001…0005 applied
  ✓ [fixture] 7 payments, 4 service requests, 6 store customers
  ✓ [upgrade] 0006 applied cleanly
  ✓ [upgrade] 0007 applied cleanly
  ✓ [upgrade] 0008 applied cleanly
  …
  57 checks · 0 failed · 0 warnings
  ✓ STAGING PASSED
```

What the checks prove, in the words of the run:

- `all 7 payment rows still exist` · `all 4 service request rows still exist` · `6 store customers untouched`
- `both verified payments kept their reference, UTR and amount`
- `2 superseded duplicates marked cancelled, rows retained` and `every superseded row explains itself in admin_note`
- `all 4 existing requests backfilled with a stable SR- reference`
- `new request received reference SR-19CDB272 without the client sending one`
- `a second request cannot reuse an existing reference`
- `customer reads their own customer-visible note and cannot see the internal one`
- `another customer reads none of these notes` · `a customer cannot write an internal note`
- `a second open 'pro' payment is rejected by the database, not just by the app`
- `open_payment_reference() returns the existing SZ-8CA7C0DE7A to reuse`
- `a new purchase after a verified one gets a new reference`
- `all 8 references are distinct`
- `a customer cannot mark their own payment verified (0 rows updated)`
- `first delivery applied, replayed delivery recognised and skipped`
- `replay left exactly one event, one notification and one verified payment`
- `a capture arriving after a failure still verifies the payment (out-of-order delivery)`
- `0001…0008 is idempotent`

Two staging-harness findings worth naming, because they are what testing is for:

1. The harness needed real Supabase scaffolding (`auth.users.last_sign_in_at`, `storage.foldername`, the pgcrypto shim). Without it the migrations would have been "tested" against nothing.
2. Two of my own assertions were wrong at first (the expected count of superseded rows, and a verified-count baseline). The migration was right; the test was fixed. Both are noted here rather than quietly corrected.

## 4. Live project state — measured, not assumed

```
node scripts/verify-migration.mjs
  0006
    ✗ service_requests.reference column       400 column service_requests.reference does not exist
    ✗ service_requests.due_at column          400 column service_requests.due_at does not exist
    ✗ service_requests.assigned_to column     400 column service_requests.assigned_to does not exist
    ✗ service_request_notes table             404 Could not find the table 'public.service_request_notes'
  0007
    ✗ migration_notes table                   404 Could not find the table 'public.migration_notes'
  0008
    ✗ payment_webhook_events table            404 Could not find the table 'public.payment_webhook_events'
```

So the live project `zmkgfmlcpzjfgxdmbtvi` is exactly at the baseline staging replays (`0001`…`0005`), and holds **0 payment rows and 0 service requests** at the time of this run. There is no financial history that a migration could disturb.

## 5. Why it has not been applied yet

`.env` contains the project URL and the publishable key. It does **not** contain `SUPABASE_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_DB_URL`, and none of them are in this environment. Every path that can execute DDL on the project requires one of those:

- Management API (`POST /v1/projects/{ref}/database/query`) needs a personal access token.
- `supabase db push` needs a linked project with the CLI logged in.
- `psql`/`pg_dump` need the database password.

I will not invent a claim of having applied it, and I will not ask for a service-role key to be pasted into a browser-side file.

## 6. How to apply it — three ways, all scripted

**A. With a token (I can do this immediately if you add one line to `.env`):**

```bash
echo 'SUPABASE_ACCESS_TOKEN=sbp_…' >> .env    # Supabase → Account → Access tokens
node scripts/apply-migrations.mjs             # preflight → backup → apply → verify → receipt
```

The runner refuses to continue if the backup fails, runs each migration in its own transaction, then re-reads the project and writes a receipt to `docs/migration-receipts/<timestamp>.md` with file hashes, before/after row counts and per-object verification. That receipt is the proof you asked for.

**B. In the dashboard:**

1. SQL editor → paste `0006_service_request_tracking.sql` → run.
2. Paste `0007_customer_reference_uniqueness.sql` → run.
3. Paste `0008_payment_webhook_idempotency.sql` → run.
4. Run `node scripts/verify-migration.mjs` — it needs no credentials beyond the publishable key and will show every object present.

**C. With the CLI:** `supabase link --project-ref zmkgfmlcpzjfgxdmbtvi && supabase db push`.

## 7. Backup, before any of that

```bash
node scripts/db-backup.mjs          # → .backups/<timestamp>/ + manifest with sha256 per file
node scripts/db-backup.mjs --verify .backups/<timestamp>
```

With `SUPABASE_DB_URL` and `pg_dump` it writes a full `pg_dump`. With only the Management API token it writes every table as JSON plus a complete schema snapshot (columns, constraints, indexes, policies, triggers, functions, RLS flags), and then reads the files back and verifies their hashes. A backup that cannot be read back is not a backup, so the script fails if verification fails — and `apply-migrations.mjs` will not run when the backup step fails.

Given the project currently holds no payment or request rows, the data risk of applying 0006–0008 today is close to zero. The backup is still taken, because "close to zero" is not the same as zero.

## 8. Rollback

Each migration is additive, so rollback is a reversal rather than a restore:

```sql
-- 0008
drop table if exists public.payment_webhook_events;
drop index if exists public.payments_provider_payment_unique;
drop index if exists public.notifications_one_per_webhook_event;
-- 0007
drop index if exists public.payments_one_open_per_purpose;
drop function if exists public.open_payment_reference(uuid, text);
drop table if exists public.migration_notes;
-- 0006
drop trigger if exists service_requests_reference on public.service_requests;
drop function if exists public.set_service_request_reference();
drop table if exists public.service_request_notes;
alter table public.service_requests
  drop column if exists reference, drop column if exists assigned_to,
  drop column if exists due_at, drop column if exists accepted_at,
  drop column if exists completed_at;
```

Dropping 0006's columns discards the references the trigger issued, which is why the backup exists. Rows superseded by 0007 stay `cancelled` with their explanation — that is history, and history is not rolled back.
