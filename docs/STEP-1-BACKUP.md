# Step 1 — production backup: status and exact instructions

**Status: TAKEN AND VERIFIED (round 3).** A working token was supplied; the backup completed at
`2026-11-07T10:37:04Z` into `.backups/step1-2026-11-07T10-35-19-512Z/`, 76 files, 90 rows, and
read back successfully with a full insert rehearsal. **It also discovered that production is four
migrations behind the repository (0006–0013 are not applied).** See §9 for the final result.

This document is written so that the moment you supply one credential, Step 1 completes in a
single command with a verified, rehearsed result — or refuses outright rather than handing you
a partial backup that looks complete.

---

## 1. What was attempted, and what it printed

```
$ node scripts/db-backup.mjs
  Shinzora backup → .backups/2026-11-07T10-15-52-027Z
  project: zmkgfmlcpzjfgxdmbtvi
  ✗ No way to take a backup from here.
    Set SUPABASE_DB_URL (pg_dump) or SUPABASE_ACCESS_TOKEN (Management API) and run again.
  exit=2
```

```
$ node scripts/step1-backup.mjs
  Shinzora Step 1 backup → .backups/step1-2026-11-07T10-16-33-331Z
  project: zmkgfmlcpzjfgxdmbtvi
  ✗ No credential. Nothing was read and nothing was written.
    Provide SUPABASE_ACCESS_TOKEN (Management API) or SUPABASE_DB_URL (pg_dump).
    Refusing to produce a partial backup that would look complete.
  exit=2
```

Both scripts refused **before** creating a directory. The one empty folder left behind by the
first attempt was removed. Nothing was read from production, nothing was written anywhere.

### Why

| What the environment has | What a backup needs |
|---|---|
| `SUPABASE_URL`, publishable key (`.env`) | `SUPABASE_ACCESS_TOKEN` (personal access token), **or** `SUPABASE_DB_URL` (Postgres connection string) |
| No `pg_dump`, no `psql`, no Supabase CLI | `pg_dump` is absent, so the Management API is the only viable transport |
| No Management API token | — |

Reachability is **not** the problem — the project answers over HTTPS from here (a read-only
probe to the REST root returned `401 Secret API key required`, i.e. the host is reachable and
the publishable key is not authorised for that endpoint — exactly as designed). The blocker is
authorisation, not the network.

The publishable key cannot substitute for a secret: with RLS on, it can only see what a signed-in
customer sees, so a "backup" taken with it would silently miss other customers' rows. That is
precisely the failure mode a pre-migration backup must not have.

---

## 2. One command once you supply the credential

**Option A — you run it.** In the repo, on your own machine:

```bash
export SUPABASE_ACCESS_TOKEN=...        # supabase.com/dashboard/account/tokens
node scripts/step1-backup.mjs
```

**Option B — this environment runs it.** Add one line to `.env` (gitignored, never printed,
never committed):

```
SUPABASE_ACCESS_TOKEN=...
```

then say "go" and I run `node scripts/step1-backup.mjs`. The token is read from the file, is
never echoed, and never leaves the workspace.

Either way the output lands in `.backups/step1-<timestamp>/`, outside Git (`.backups/` is
ignored), with mode `700` and config copies at `600`.

---

## 3. What the backup contains

| Folder | Contents | Restorable? |
|---|---|---|
| `data/` | every one of the **40** application tables, one JSON file per table, `order by ctid` so the snapshot is internally consistent | yes, row by row |
| `auth/users.json`, `auth/identities.json` | accounts, password hashes, confirmation and ban state — **secret-bearing** | yes, keeps user logins |
| `schema/` | 8 snapshots: tables, columns, constraints, indexes, policies, triggers, functions, RLS state | reference only (it is a snapshot, not DDL) |
| `storage/buckets.json`, `storage/object-counts.json` | bucket definitions, object counts and byte totals | metadata only |
| `config/` | `.env`, `supabase/config.toml`, `package.json`, every `supabase/functions/**` source, every migration | yes |
| `full.sql` | a real `pg_dump` — **only** when `SUPABASE_DB_URL` and the `pg_dump` binary are present | yes, with `psql` |
| `manifest.json` | sha256 of every file, row counts, every warning | — |
| `BACKUP-REPORT.md` | the human summary written at the end | — |

Every statement the script issues is a `SELECT`. It cannot change production.

---

## 4. How it is verified without restoring over production

`node scripts/step1-backup.mjs --verify .backups/step1-<stamp>` re-checks five things and
refuses to call a backup good until all of them hold:

1. every file listed in the manifest still exists and still hashes to the recorded value;
2. no file appeared that the manifest does not know about (warned, not failed);
3. every table file parses as a JSON array and its row count matches the manifest;
4. every row's keys match the column set in `schema/columns.json` — this is what catches a
   half-written or truncated export;
5. **restore rehearsal:** each row is inserted into a scratch in-memory Postgres (PGlite) whose
   table is built from the recorded column *types* (uuid, jsonb, timestamptz, numeric, …), and
   the inserted count must match.

Step 5 touches nothing outside the process. Production is never the rehearsal target.

The rehearsal is honest about its limits: it proves the data is parseable, complete in count and
column shape, and re-insertable. It does **not** prove that foreign keys, RLS policies, triggers
or functions still behave — that is what the post-restore smoke test in Step 3 does.

The harness itself is tested: `node tests/step1-backup-kit.test.mjs` (**14 assertions**) builds
a synthetic backup, verifies it, then breaks it four ways — a changed byte, a truncated table, an
injected column, a deleted file — and requires the verifier to catch each one. It passes. The
same run is part of `npm test`, which is green at **692 assertions + 23 routes**.

---

## 5. Warnings and known gaps — read these before you approve

1. **Storage object bytes are not in a database backup.** Buckets currently defined:
   `avatars` (public, 2 MB), `brand-assets` (public, 5 MB), `payment-proofs` (private, 5 MB).
   Only definitions and object counts are captured. Copying the files themselves needs a
   service-role key and `supabase storage` — say the word and I will add that as Step 1b.
2. **Edge function secrets are write-only.** `SHINZORA_AI_API_KEY` (the exposed one), the UPI
   values and anything else set with `supabase secrets set` cannot be read back through any API.
   They must be recorded from your vault. Recommend rotating the AI key regardless.
3. **Dashboard-only project settings are not in the backup:** auth providers and their client
   secrets, SMTP credentials, the JWT secret, redirect allow-list, custom domains, API keys.
   Export them by hand — Supabase → Project Settings → Auth / API / Edge Functions — into the
   same folder. I will not invent these.
4. **`auth.users` needs the Management API or pg_dump.** If only the DB URL is available and
   `pg_dump` is missing, the backup covers data but not accounts, and the report says so instead
   of quietly omitting them.
5. **No point-in-time recovery substitute.** This is a logical snapshot at one instant; writes
   between the snapshot and the migration are not in it. Take it immediately before Step 3.
6. **Local `.env` wart found while testing:** one value contains a space without quotes, so
   `source .env` in bash fails on that line (`line 21: <word>: command not found`). Node's own
   parser is unaffected, so the scripts work; I left the file untouched rather than editing
   configuration without your word. Quote it when convenient.
7. **Supabase also keeps its own daily backups** (Dashboard → Database → Backups). That is a
   second, independent safety net — worth confirming the retention window before the migration.

---

## 6. Backup location and timestamp

- **Location:** none — no backup was created. The intended location is
  `shinzora/.backups/step1-<ISO timestamp>/`, which is gitignored and created `700`.
- **Timestamp:** not applicable. Both attempts aborted at the credential check.

---

## 7. STOP

Step 2 (reading `0011` aloud and applying it to staging) has **not** started. It starts only when
you say so, and only after a real backup exists and has passed `--verify`.

Nothing was applied, deployed, pushed, or changed on production.

---

## 8. Round 2 — the token was tried, and it cannot reach Shinzora

The token was stored in `.env` (mode `600`, gitignored, never printed) and the backup was run.
It aborted before writing anything:

```
$ node scripts/step1-backup.mjs
  Shinzora Step 1 backup → .backups/step1-2026-11-07T10-27-53-720Z
  project: zmkgfmlcpzjfgxdmbtvi
  ✗ This token cannot access project zmkgfmlcpzjfgxdmbtvi (HTTP 403).
    Projects this token can see: lletqgbirxgxmwghocsl
    Nothing was read from production and nothing was written.
  exit=3
```

What the Management API said, endpoint by endpoint:

| Request | Result |
|---|---|
| `GET /v1/projects` | **200** — the token is genuine and active |
| `GET /v1/organizations` | 200, `[]` |
| `GET /v1/projects/zmkgfmlcpzjfgxdmbtvi` (Shinzora) | **403** — not this account's project |
| `POST /v1/projects/zmkgfmlcpzjfgxdmbtvi/database/query` (`select 1`) | **403** |

The project list contains exactly one project: `lletqgbirxgxmwghocsl`
("mext.aditya@gmail.com's Project", org `dpmjkzcyanuerbpcrrdm`). The Shinzora ref
`zmkgfmlcpzjfgxdmbtvi` is **not** in it. So the token is not expired, not malformed and not
under-scoped — it is issued by a different Supabase account, and using it against Shinzora
fails authorisation. I will not attempt to route around that.

### Two defects this round exposed, both fixed

1. **A zero-row export called itself "verified".** The first run produced 33 config/schema files
   and 0 rows, and the verifier printed `✓ backup verified`. That is exactly the false comfort a
   pre-migration backup must never give. Now: a table recorded with an error is a **problem**,
   not a warning, and a run with zero rows fails. The 0-row folder was deleted, not kept.
2. **No preflight.** The script now proves access to the specific project ref *before* creating a
   directory, and prints which refs the token can actually see. That is what turned a silent
   36-table failure into one clear line.

`tests/step1-backup-kit.test.mjs` grew to **16 assertions** covering both: a table recorded with
an error fails verification and is named, and the clean path still passes.

### What is needed instead — one of these

| Option | What it unlocks | Notes |
|---|---|---|
| **A personal access token from the account that owns `zmkgfmlcpzjfgxdmbtvi`** | full Management API path: 40 tables, `auth.users`, schema snapshots | create at supabase.com/dashboard/account/tokens while signed in as the project owner |
| **`SUPABASE_DB_URL`** (`postgresql://postgres.[ref]:[password]@[host]:5432/postgres`) | best option — direct SQL, and the only path that also reaches `auth.users` without the Management API | the registry is reachable here, so `npm i pg` gives a working client even though `pg_dump` is absent; I would add that transport |
| Project owner adds this account to the org | the token already held would start working | not recommended while a valid token is the simpler ask |

### Still needed for a *complete* backup, after the token

1. A **service-role key** (or a storage export) for the bytes in `avatars`, `brand-assets`,
   `payment-proofs` — a database backup does not contain files.
2. The **dashboard-only settings**: auth providers and client secrets, SMTP, JWT secret,
   redirect allow-list, custom domains, Edge function secrets. These cannot be read by any API;
   they come from your vault or a screenshot-free hand export.

### Security note

The token was pasted into the conversation, so it is exposed. Rotate it at
supabase.com/dashboard/account/tokens when this deployment is done — the same advice as the AI
key. Say the word and I will remove the line from `.env` now instead of later.

---

## 9. Round 3 — the backup exists, and it found real drift

Token supplied this round authenticated against the right project (`shinzora`, `zmkgfmlcpzjfgxdmbtvi`,
region `ap-south-1`) and `select 1` returned 201. The backup then ran to completion.

### Location and timestamp

```
folder     /home/user/shinzora/.backups/step1-2026-11-07T10-35-19-512Z
started    2026-11-07T10:35:19.688Z
finished   2026-11-07T10:37:04.987Z
size       76 files, 574,932 bytes (562 KB), directory mode 700
transport  Management API (read-only SELECTs)
```

### What is inside

| Path | Content |
|---|---|
| `data/*.json` | 26 tables that exist in production, 90 rows total. Non-empty: `ai_usage_log` 24, `notifications` 15, `customer_activity` 14, `ai_messages` 9, `payments` 6, `ai_conversations` 5, `profiles` 2, `subscriptions` 2, `onboarding_progress` 2, `businesses` 1, `projects` 1, `project_versions` 1, `campaigns` 1, `support_tickets` 1, `admin_announcements` 1, `admin_users` 1 |
| `auth/users.json`, `auth/identities.json` | 2 accounts each, with `encrypted_password` hashes, confirmation and ban state — **secret-bearing** |
| `schema/*.json` | 36 tables, 380 columns, 127 constraints, 82 indexes, 68 policies, 26 triggers, 28 functions, 36 RLS entries, 44 auth columns → **827 schema objects** |
| `storage/buckets.json` | 4 buckets: `avatars` (public), `brand-assets` (public), `payment-proofs` (private), `product-images` (public) |
| `storage/object-counts.json` | **0 objects in every bucket** — there are no stored files to copy |
| `config/` | `.env`, `supabase/config.toml`, `package.json`, all `supabase/functions/**`, all migrations |
| `manifest.json` | sha256 of all 76 files, row counts, warnings |
| `BACKUP-REPORT.md` | the machine-written summary |

### Readability and restorability — proven without touching production

```
$ node scripts/step1-backup.mjs --verify .backups/step1-2026-11-07T10-35-19-512Z
  files checked    76
  tables checked   32
  rows checked     90
  rows re-inserted 90        ← every row, into a scratch in-memory Postgres
  ✓ readable and consistent
```

Every file re-hashed to its manifest value; every table parsed; every row's column set matched
`schema/columns.json`; and **all 90 rows were re-inserted** into a throwaway table built from the
recorded column types, including the 2 auth accounts. Nothing was restored over production —
the rehearsal lives inside one Node process and is discarded when it exits.

### The finding that matters more than the backup

Production has **36 tables and 28 functions**. The repository declares 40 tables and 40
functions. Comparing each migration against the snapshot:

| Migration | Present in production? |
|---|---|
| 0001 … 0005 | **yes** — every table and function found |
| 0006_service_request_tracking | **no** — `service_request_notes`, `set_service_request_reference` |
| 0007_customer_reference_uniqueness | **no** — `migration_notes`, `open_payment_reference` |
| 0008_payment_webhook_idempotency | **no** — `payment_webhook_events` |
| 0009_admin_authority_and_audit | **no** — `admin_audit`, `subscription_events` and 12 functions (`is_superadmin`, `admin_reset_ai_credits`, `admin_delete_payment`, …) |
| 0010_subscription_business_link | **no** — `attach_business_to_subscription` |
| 0011, 0012, 0013 | **no** — as expected, they were never applied |

So production is at **0005**, eight migrations behind the source tree. Consequences:

1. **Step 2 cannot be "apply 0011".** 0011 depends on nothing from 0006–0010 by name, but the
   admin authority, AI-credit reset, payment deletion/audit, webhook idempotency and
   `attach_business_to_subscription` paths that the deployed code calls **do not exist in
   production**. Any of those features that is live today is failing at the database.
2. The deployment plan is therefore **0006 → 0013, in order, each reviewed and each with a
   rollback**, not three files.
3. The backup was taken **before** any of this was known, which is precisely its job.

### Warnings recorded in the manifest

- Storage object bytes are not in a database backup. Moot today: **0 objects** across 4 buckets.
- 10 tables declared in the migrations are absent from production (the drift above).
- Edge function secrets, auth provider secrets, SMTP credentials, the JWT secret and custom
  domain settings are dashboard-only and remain **not backed up** — they must be exported by
  hand or restored from your vault.
- The repository `data/` folder contains personal data. `.backups/` is gitignored and the
  directory is mode `700`; treat the copy as sensitive.

### Status

Step 1 is **complete**. Step 2 has not started and its scope has changed — it is now a
0006→0010 catch-up before 0011–0013, and I will not touch it until you say so.
