# Deployment

Ordered, copy-pasteable steps. Nothing here requires a local Supabase CLI, though it is used for the Edge Functions.

Two things this guide deliberately does **not** ask for: your Gemini key in a browser file, and a service-role key anywhere
except a function secret.

---

## 0. Prerequisites

- A Supabase project (free tier is enough to start).
- A Vercel account for the frontend.
- A Google AI Studio key for Gemini (`GEMINI_API_KEY`).
- Optional: GitHub OAuth app, Vercel token, a domain registrar API, Razorpay account.

---

## 1. Database

Your project is currently at **0001 only**: `profiles`, `businesses`, `onboarding_progress`, `subscriptions`,
`projects`, `ai_conversations`, `ai_messages` and `notifications` exist; the other 20 tables (payments, domains,
support, store, admin, activity, versions, deployments, campaigns…) do not. The dashboard views that need them will
report "not set up" until this is done. `0005` exists precisely because this database already had the early tables in
their original shape.

### Option A — one command (recommended)

`scripts/migrate.mjs` snapshots the database, applies each file in its own transaction, records what it applied, and
proves afterwards that no rows disappeared.

```bash
# Project Settings → Database → Connection string → URI  (contains the DB password)
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'

node scripts/migrate.mjs --dry-run   # snapshot + plan, changes nothing
node scripts/migrate.mjs             # apply
```

Requires `psql` (Debian/Ubuntu `apt-get install postgresql-client`, macOS `brew install libpq`). The connection string
is read from the environment and never written to disk or printed.

What you will see:

```
  tables       8
  rows         15
  policies     0   functions 36   triggers 0

Plan
  apply  0001_schema.sql  26f6fba73182624b
  …

Applying
  ✓ 0001_schema.sql 61 ms
  …
Result
  tables       8 → 30
  policies     0 → 36
  rows moved: subscriptions 4 → 2 (2 archived) — restorable from the archive
  archived: 1 × subscriptions — duplicate subscription row (newest per user kept)
  archived: 1 × subscriptions — plan not in (free, pro, enterprise) — normalised to free
  ✓ Every expected table, policy and function is in place.
```

It exits non-zero if a file fails (that file rolls back completely — earlier files stay applied and are skipped on the
next run), if a migration's checksum changed since it was applied (override with `--force` only if you are sure), or if
a table lost rows that the archive cannot account for.

### Option B — SQL Editor, one file at a time

| Order | File | What it does |
| --- | --- | --- |
| 1 | `supabase/migrations/0001_schema.sql` | 28 tables, indexes, `updated_at` triggers |
| 2 | `supabase/migrations/0002_functions_rls.sql` | `is_admin`, `handle_new_user`, `ai_usage_quota`, `consume_ai_credit`, `log_activity`, payment guard, RLS on every table |
| 3 | `supabase/migrations/0003_storage_realtime.sql` | `avatars`, `brand-assets`, `payment-proofs` buckets, storage policies, realtime publication |
| 4 | `supabase/migrations/0004_admin_bootstrap.sql` | the first administrator — **edit the email inside first** |
| 6 | `supabase/migrations/0006_service_request_tracking.sql` | adds `reference`, `assigned_to`, `due_at`, `accepted_at`, `completed_at` to `service_requests` with a backfill from existing ids, plus the write-only-to-admins `service_request_notes` table. Additive: no drop, no rewrite, safe to re-run |
| 5 | `supabase/migrations/0005_schema_compat.sql` | reconciles a database that already had the early tables: converts `current_step` to integer, copies `answers` → `data`, `message` → `body`, adds the unique/check/FK constraints `create table if not exists` skipped. Safe to re-run; see `docs/DATABASE.md` |

Each file is idempotent. If one fails halfway, fix the cause and run it again; existing objects are skipped.

### 0006 → 0009 — and how to apply them safely

> The complete production procedure, with the expected output of every step, is
> **`docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md`**. This section is the summary;
> that document is the one to follow while the console is open.

Three additive migrations land after `0005`:

| File | Adds |
| --- | --- |
| `0006_service_request_tracking.sql` | reference / assignee / due date on service requests, a reference trigger, and a notes table that customers cannot read internally |
| `0007_customer_reference_uniqueness.sql` | one open payment per customer per purpose, plus `migration_notes` as a permanent record of what the migration changed |
| `0008_payment_webhook_idempotency.sql` | a webhook event inbox with a unique `(provider, event_id)`, and uniqueness for gateway payment ids and per-event notifications |
| `0009_admin_authority_and_audit.sql` | the administrator directory, `set_admin_role()` with escalation / protected-owner / last-superadmin guards, `admin_audit`, AI-credit resets, subscription events, payment void-vs-delete rules, archive columns and stock-movement history. Additive; sets exactly one `protected` flag; deletes nothing |

**Prove them first, without touching the project:**

```bash
node scripts/staging-db.mjs      # replays 0001…0005, seeds realistic rows, applies 0006–0009, checks 84 invariants
```

**Then apply, in this order:**

```bash
node scripts/verify-migration.mjs     # what the live project has right now (publishable key only)
node scripts/db-backup.mjs            # refuses to write an unverifiable backup
node scripts/apply-migrations.mjs     # preflight → backup → apply → verify → receipt
```

`apply-migrations.mjs` needs `SUPABASE_ACCESS_TOKEN`. Without it, it exits with
the two alternatives rather than doing something creative. Each migration runs in
one transaction; verification re-reads the project and writes a receipt to
`docs/migration-receipts/` containing file hashes, before/after row counts and
per-object results. Full detail, including rollback SQL: `docs/MIGRATION-REPORT.md`.

### What 0005 does with data it cannot keep

It never drops a table or a column. Where a row has to be removed or rewritten for a constraint to be possible — a
duplicate subscription, a subscription with no owner, an unknown plan name — the original row is copied to
`public.migration_archive` first:

```sql
select table_name, reason, row_data from public.migration_archive order by id;
-- restore one:
insert into public.subscriptions
select * from jsonb_populate_record(null::public.subscriptions,
  (select row_data from public.migration_archive where id = <id>));
```

The archive has RLS enabled and **no policies**, so only the service role can read it.

### Rehearsed before writing this

The full chain was applied to a local PostgreSQL 17 replica of this project's legacy shape — 8 tables, duplicate
subscriptions, a null-owner row, a non-numeric `current_step`, legacy `answers`/`is_completed`/`message`/`is_read`
columns — and then re-applied a second time. Both runs were clean, the archive captured all 3 displaced rows, and RLS
was verified from the `authenticated` and `anon` roles:

```
own profile visible            true      other customer hidden     true
own subscriptions only         true      is_admin() false          true
self-promotion to admin_users  blocked   anon reads no profiles    true
```

### 1a. Administrator

1. Register normally at `/auth/signup/` and confirm the email.
2. Open `0004_admin_bootstrap.sql`, replace
   `REPLACE-WITH-YOUR-ADMIN-EMAIL@example.com` with that address.
3. Run it. The output notice confirms the grant.
4. Sign in at `/admin/`.

There is no UI path to administrator rights, by design.

---

## 2. Auth settings

In **Authentication → URL Configuration**:

- Site URL: `https://shinzora.in` (or your Vercel domain)
- Redirect URLs — add all four:
  - `https://shinzora.in/auth/callback/`
  - `https://shinzora.in/auth/reset-password/`
  - `http://localhost:4173/auth/callback/`
  - `http://localhost:4173/auth/reset-password/`

In **Authentication → Providers**:

- **Email**: enabled. Keep "Confirm email" on — the signup flow expects verification and shows the resend screen.
- **Google** (optional): add a Google Cloud OAuth client, paste the client id and secret, and put
  `https://<project-ref>.supabase.co/auth/v1/callback` in the Google console as the authorised redirect URI. When it is
  configured, the Google button works; when it is not, the button reports the provider error instead of pretending.

Password length minimum: 8 characters (the client enforces this, Postgres and GoTrue enforce it again).

---

## 3. Edge Functions

One command deploys all eight. It needs Node 20+ and a Supabase access token — **no Docker, no global install**:

```bash
# token: https://supabase.com/dashboard/account/tokens
SUPABASE_ACCESS_TOKEN=sbp_... node scripts/deploy-functions.mjs

# see the plan first (flags, which functions stay public) without deploying
node scripts/deploy-functions.mjs --dry-run

# redeploy just what failed
node scripts/deploy-functions.mjs ai admin
```

The script reads `verify_jwt` from `supabase/config.toml` and passes `--no-verify-jwt` **only** for `config`, `site`
and `payments-webhook`, so the three public endpoints cannot drift into a half-configured state. It bundles with the
CLI's `--use-api` mode, which compiles the function on Supabase's side instead of locally.

The equivalent by hand, if you prefer the CLI directly:

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>

supabase functions deploy config            --no-verify-jwt --use-api
supabase functions deploy site              --no-verify-jwt --use-api
supabase functions deploy payments-webhook  --no-verify-jwt --use-api

supabase functions deploy ai --use-api
supabase functions deploy domains --use-api
supabase functions deploy payments --use-api
supabase functions deploy integrations --use-api
supabase functions deploy admin --use-api
```

`--no-verify-jwt` is correct **only** for `config`, `site` and `payments-webhook`. The webhook verifies a Razorpay
signature instead; `admin` re-checks the administrator role on every request.

Then prove the deploy landed, from the outside, with nothing but the public URL and the publishable key:

```bash
node scripts/smoke-functions.mjs --remote
```

It fails on a 404 (function not deployed), on a protected function that answers without a token, on a public
function that refuses one, and on any response carrying a key value or a stack trace.

### Before you deploy: the local smoke test

All eight functions type-check and answer correctly locally, which is what this repository has verified. Reproduce it
before pushing them live:

```bash
deno check supabase/functions/*/index.ts            # 8/8 clean
npm run test:fn-unit                               # 19 Gemini client tests, no key, no network
DENO=$(command -v deno) npm run test:functions     # boots every function and checks its contract
```

`test:functions` asserts, per function: it boots on Deno, refuses an unauthenticated call with 401 (`admin`, `ai`,
`payments`, `domains`, `integrations`), answers a public call (`config` 200, `site` 4xx-with-a-body),
`payments-webhook` reports `webhook_unconfigured` with 503 rather than accepting an unsigned event, and no response
contains the secret values it was seeded with or a stack trace.

### 3a. Secrets

Verify the AI key landed without ever printing it:

```bash
supabase secrets list                       # shows the name + a fingerprint, never the value
curl -s https://<project-ref>.supabase.co/functions/v1/config | jq .ai
# { "configured": true, "model": "gemini-3.8-flash", "key_env": "SHINZORA_AI_API_KEY" }
```

If `configured` is false, the functions return
`{"code":"functions_unavailable","error":"AI generation is not configured on this deployment."}` with HTTP 503 — which
is exactly what the builder shows the customer, and what `npm run test:fn-unit` locks down.

```bash
# Required for AI — ordered server-only credentials. Never put these in the
# frontend or a committed file. Quota exhaustion silently advances to the next.
supabase secrets set SHINZORA_AI_API_KEY_1=<key-1> SHINZORA_AI_API_KEY_2=<key-2> \
  SHINZORA_AI_API_KEY_3=<key-3> SHINZORA_AI_API_KEY_4=<key-4> \
  SHINZORA_AI_MODEL=gemini-3.8-flash

# Existing single-key deployments remain supported through SHINZORA_AI_API_KEY,
# GEMINI_API_KEY or GOOGLE_API_KEY. Model fallback chains remain configured
# separately from credential failover.

# Domains — free availability, then a registrar for prices
#
# With nothing set, availability still works: supabase/functions/domains reads the
# public registry (RDAP) and answers "taken or free" with no account and no key.
# It never shows a price, because no price was quoted.
supabase secrets set DOMAIN_AVAILABILITY=rdap
#
# To price and register, point the function at a provider that speaks the contract
# in supabase/functions/domains/index.ts (/check, /register, /dns):
supabase secrets set DOMAIN_PROVIDER=<name> DOMAIN_API_URL=https://api.provider.com DOMAIN_API_KEY=...

# Required for UPI QR payments
supabase secrets set UPI_ID=<your-vpa> UPI_PAYEE_NAME="Your Business"

# Optional: Razorpay
supabase secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=...
# Webhook URL: https://<project-ref>.supabase.co/functions/v1/payments-webhook
# Subscribe to: payment.captured, payment.failed, order.paid

# Optional: GitHub repositories
supabase secrets set GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
  GITHUB_REDIRECT_URI=https://shinzora.in/auth/callback/?provider=github GITHUB_SCOPES=repo

# Optional: Vercel deployments
supabase secrets set VERCEL_TOKEN=...

# Optional: domain registrar (any provider that matches the documented contract)
supabase secrets set DOMAIN_PROVIDER=<name> DOMAIN_API_URL=https://api.provider.com DOMAIN_API_KEY=... SUBDOMAIN_ROOT=shinzora.in

# Recommended whenever GitHub/Vercel tokens are stored
supabase secrets set INTEGRATION_ENCRYPTION_KEY=<32+ random characters>
```

Secrets apply to the whole function namespace. Redeploy a function after changing its secrets so the new values are
picked up.

### 3b. Registrar contract

`domains` expects three endpoints behind `DOMAIN_API_URL`, authenticated with `Authorization: Bearer DOMAIN_API_KEY`:

```jsonc
POST /check      { "domains": ["acme.in"] }
  → { "results": [{ "domain": "acme.in", "available": true, "price": 79900, "renewal": 89900, "currency": "INR" }] }

POST /register   { "domain": "acme.in", "years": 1, "contact": { ... } }
  → { "orderId": "REG-123", "status": "processing" }

POST /dns        { "fqdn": "acme.in", "records": [...] }
  → { "ok": true }
```

Prices are in **minor units** (paise). Shinzora never adds its own margin and never invents a price: without this
provider the Domains view reports that availability cannot be checked.

---

## 3c. Brand logo

The build ships an SVG mark. To use the official artwork:

```bash
# logo.png in the repository root (or public/assets/brand/)
npm run brand          # generates every icon size + css and links it into all pages
npm run check          # confirm nothing references a missing file
npm run brand:check    # status summary
```

The command writes `favicon-16/32`, `apple-touch-icon`, `icon-192/512`, `mark-64/128`, and `public/css/brand.css`, then
adds `<link rel="stylesheet" href="/css/brand.css">` to each page. Nothing is cropped or stretched: every derivative is
letterboxed onto a transparent square with a safety margin. The icons that ship with the product are copied to
`public/assets/icons/_original/` first, so `npm run brand:revert` puts everything back byte-for-byte.

--- 

## 4. Frontend on Vercel

1. Push the repository to GitHub.
2. In Vercel, **Import Project** → select the repo.
3. Framework preset: **Other**. Build command: `node scripts/generate-config.mjs`. Output directory: `public`.
   (`vercel.json` already declares these.)
4. Environment variables (Production + Preview):

```
SHINZORA_SUPABASE_URL=https://<project-ref>.supabase.co
SHINZORA_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SHINZORA_SITE_URL=https://shinzora.in
SHINZORA_SUPPORT_EMAIL=official.shinzora@proton.me
SHINZORA_ENVIRONMENT=production
```

The publishable key is designed to be public — RLS is the control. Do **not** add the service-role key here, and do not
add the Gemini key.

5. Check the production build locally before you push it:

```bash
npm run build && npm run verify:deploy
```

`verify:deploy` serves `public/` through a local re-implementation of the rules in `vercel.json` and asserts: all 17
pages resolve to 200, `/auth/login` 308s to `/auth/login/`, `/login` `/signup` `/dashboard` `/pricing` redirect as
declared, `/site/<slug>` rewrites to the site renderer, `/admin/` and `/app/` carry `noindex`, HSTS + `nosniff` +
`SAMEORIGIN` apply, CSS is served as CSS and revalidated, unknown paths get the branded 404, and
`/js/config/runtime.js` exists with a Supabase URL and no service-role key.

6. Deploy. From the CLI instead of the dashboard:

```bash
npm i -g vercel
vercel link            # first time
vercel env add SHINZORA_SUPABASE_URL production      # repeat for each variable
vercel --prod
```

7. Then verify against the live URL:
   - `/` renders the marketing site
   - `https://<domain>/js/config/runtime.js` contains your project URL
   - `/system-check/` reports the schema and provider state (it is the same checks as above, in the browser)
   - `/auth/signup/` creates an account and sends the verification email
   - `/admin/` accepts the account you made an administrator in step 1a

### Custom domain

Add `shinzora.in` in Vercel → Domains. For wildcard subdomains (`*.shinzora.in`) add the wildcard domain too; Vercel
returns the DNS records to create at your registrar. `public/js/boot/site.js` resolves the project slug from the
subdomain, so `acme.shinzora.in` serves the project with slug `acme`.

---

## 4b. Publishing a native build (optional)

The Get app panel offers a download only for platforms listed in `public/downloads/manifest.json` **and** whose file
answers a `HEAD` request. Until you publish a build, every platform shows its supported browser-install route — that is
the intended state, not a bug.

1. Put the artifact in `public/downloads/` (e.g. `shinzora-1.0.0.apk`) or host it on a CDN and use an absolute URL.
2. Add an entry:

   ```json
   {
     "builds": {
       "android": {
         "file": "shinzora-1.0.0.apk",
         "url": "/downloads/shinzora-1.0.0.apk",
         "format": "APK",
         "version": "1.0.0",
         "size": 24117248
       }
     }
   }
   ```

3. Redeploy the frontend. Keep `size` accurate — it seeds the progress bar before the first byte arrives.
4. Verify: open the panel, pick the platform, and confirm the button appears and the file downloads. If the file 404s the
   panel silently falls back to "no build published", so a broken link never ships as a button.

Rules of thumb: leave `ios` empty unless a TestFlight/App Store distribution exists; macOS needs a signed, notarised
`.dmg` or Gatekeeper will refuse it; keep large artifacts out of git and point `url` at your CDN (CORS must allow the
`HEAD` and `GET`).

---

## 5. Post-deploy checks

Administrator doorway: **`/admin-login`**. It authenticates with Supabase, then calls the server to confirm the account
holds a role in `admin_users`; a non-admin session is signed out immediately. `/admin/` repeats the check on load, so the
URL is never the security boundary.


```bash
curl -s https://<project-ref>.supabase.co/functions/v1/config | jq
```

Expected shape (values depend on which secrets you set):

```json
{
  "available": true,
  "ai": { "configured": true, "model": "gemini-2.0-flash" },
  "payments": { "upi_configured": true, "razorpay_configured": false },
  "domains": { "provider": "none", "configured": false },
  "integrations": { "github_configured": false, "vercel_configured": false }
}
```

Then open `/system-check/` in the browser and sign in. It exercises each surface and lists exactly what is still
unconfigured. Anything reported `warn` is a provider you have not connected yet — by design, not a bug.

---

## 6. Updating

- Frontend: push to the connected branch; Vercel rebuilds and rewrites `runtime.js`.
- Functions: `supabase functions deploy <name>`.
- Migrations: add a new numbered file (`0005_*.sql`) rather than editing applied files, and keep it idempotent.
- Service worker: bump `CACHE` in `public/sw.js` when shipping asset changes that must invalidate.

---

## 7. Rollback

- Frontend: Vercel → Deployments → previous → **Promote**.
- Functions: redeploy from the last good git revision.
- Database: migrations are additive; there is no destructive step in this project. Restore from a Supabase backup
  (Project Settings → Database → Backups) if data was lost.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Signup works, no email arrives | SMTP not configured | Supabase → Authentication → Emails; on free tier the built-in sender is rate-limited |
| `functions_unavailable` in the builder | `GEMINI_API_KEY` missing | `supabase secrets set GEMINI_API_KEY=...` then redeploy `ai` |
| `config` returns 404 | Function not deployed | `supabase functions deploy config --no-verify-jwt` |
| Payment says "provider not configured" | No `UPI_ID` and no Razorpay keys | Set one, redeploy `payments` |
| Domain search says registrar not connected | No registrar provider | Configure `DOMAIN_*` secrets — availability is never invented |
| Admin console says "no administrator role" | `0004` not run for that account | Run it with the right email |
| `/site/?p=slug` says not published | Project has no published version | Publish from Projects, then reload |
| Data looks empty after signup | Migrations not applied | Run `0001`–`0003`, then `0005`, then check `/system-check/` |
| `/system-check/` says "Schema compatibility (0005)" | The database still has the legacy column shapes | Run `0005_schema_compat.sql` — it converts the types and copies the legacy data across without dropping anything |
