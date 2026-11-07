# Delivery status — 6 November 2026

What was completed, what is pending, what was tested, and what needs you.
Nothing here is marked complete without a test behind it; where a test was
impossible, it says so and says why.

---

## 1. Completed in this pass

### Phase 3 — administrator authority, audit and archival (migration 0009)

| What | Where | Proven by |
| --- | --- | --- |
| The console can finally list every account: administrators, super administrators, customers, with plan, credits, projects and joined date | `admin_directory()` in `supabase/migrations/0009_admin_authority_and_audit.sql`; `public/js/modules/admin/views/access.js` | 25 staging checks, 58 sandbox checks, 17 browser checks |
| Promote, demote and revoke — the only write path to `admin_users`, and it refuses anything a super administrator could not authorise | `set_admin_role()` | staging: customer and administrator both refused; browser: promote then revoke, audited |
| The protected owner can never be demoted or revoked — including by themselves | `admin_users.protected`, set by the migration, changeable by nothing | staging + browser |
| The platform can never be left without a super administrator | `set_admin_role()` count guard | staging (isolated from the protected-owner rule) |
| AI credit reset, super administrators only, with a reason | `admin_reset_ai_credits()` | staging + sandbox |
| Subscription plan/status changes that validate and keep history | `admin_update_subscription()` + `subscription_events` | staging + sandbox |
| Payment removal that preserves the books | `admin_delete_payment()` — verified/claimed/refunded are **voided**, never deleted; only a row that never held money can be removed, and its full snapshot is copied into the audit trail first | staging: void survives, claimed never deleted, delete snapshot verified, reason mandatory |
| Tickets, contact messages, announcements and activity are archived, not destroyed | `admin_archive_record()` + archive columns + policies that exclude them from lists | staging + sandbox |
| Every privileged change is written to a trail nobody can edit | `admin_audit` + `admin_audit_log()`; no client policy on the table | staging: direct read and delete both return nothing for an administrator |
| Monitoring shows real probes: database, storage, auth, recent AI failures, each timed | `monitor` action in the `admin` Edge Function; probe card in `views/monitoring.js` | browser: probes render, no uptime figure claimed |
| Stock changes are recorded by the database, not by the form | `record_stock_change()` trigger + `inventory_movements` | staging |

**Not applied to production.** 0009 is staging-proven only, exactly like 0006–0008.
Applying it, and deploying the updated `admin` Edge Function, are owner actions —
see `docs/ADMIN-AUTHORITY.md` §6 and §4 below.

### Three reported defects (fixed and verified in a browser)

| Report | Cause | Fix | Verified |
| --- | --- | --- | --- |
| Header links "AI builder" / "Business OS" broke onto two lines and the bar grew | `.nav-links` had no wrap control and `.nav-link` no `white-space`, so a seventh link overflowed the row at ~960–1200 px | Nowrap nav, non-shrinking actions, and a 960–1199 px step that drops the three secondary links (plus an icon-only download button at 960–1100 px) | 13 widths, 1600 → 390 px, 72/72 checks: one line per link, no overlap, no overflow, header fixed at 69 px from 960 to 1600 px. `docs/media/fixes/navbar-1440.png`, `navbar-1100.png` |
| Admin → Monitoring said "not available / Administrator access required" for a real administrator | `/api/prelaunch/monitor` accepted **only** a pre-launch session cookie, so every console administrator — who signs in with Supabase — was refused | The endpoint now also accepts `Authorization: Bearer <Supabase access token>`: the token is verified against `/auth/v1/user`, then the `admin_users` row is read **with that same token** so row-level security decides. The panel sends the token, and each failure now names the owner's next step instead of developer prose | Server: valid admin token → 200 with the log; a non-admin's token → 403; an unknown token → 403; no token → 403 with a remedy. UI: 7/7 checks across success, 403 and 404 states. `docs/media/fixes/monitoring-ok.png`, `monitoring-403.png` |
| The reset page printed "PKCE code verifier not found in storage… use @supabase/ssr" verbatim | Supabase's developer error text reached the customer unchanged, and the recovery action depended on string matching in the view | `linkError()` maps the cause to `link_wrong_browser` / `link_expired` / `link_invalid` before it leaves the service layer; the callback and reset screens render "This link cannot be used here" with **Send a new link** as the primary action, including when Supabase bounces back with `error_code` and no `code` | 2 bad-link entry points, 6/6 checks: no raw Supabase string, customer-facing title, recovery action present. `docs/media/fixes/reset-link-error.png` |

What is *not* claimed for the monitoring fix: it was proven against a stand-in
Supabase endpoint (verified token → `admin_users` row → allow; everything else →
403), not against your live account, because no password for it exists in this
environment. The rule it enforces is simple and worth checking once: **the account
must have a row in `public.admin_users`.** If it does not, the panel now says so
and tells you to add it.

### Priority 3 — Customer reference uniqueness (done, database + backend)

| What | Where |
| --- | --- |
| One open payment per customer per purpose, enforced by a partial unique index | `supabase/migrations/0007_customer_reference_uniqueness.sql` |
| Duplicate resolution that keeps the row already carrying a proof, marks the rest `cancelled` with an explanation, and deletes nothing | same file |
| `open_payment_reference(owner, purpose)` for reuse | same file |
| A permanent record of what the migration changed | `migration_notes` table, same file |
| API reuse instead of insert, with the unique index as the race arbiter (`23505` → re-read the winner) | `supabase/functions/payments/index.ts` |
| Same behaviour in the sandbox mirror | `server/prelaunch/functions.mjs` |
| Tested: 6 simultaneous creates → 1 reference, 5 `reused: true`; 4 concurrent across purposes → 4 distinct; a repeat after a proof → same reference; stored state → one open row per purpose | live sandbox run |

### Priority 4 — Payment webhook idempotency (done, database + backend)

| What | Where |
| --- | --- |
| Event inbox with `unique (provider, event_id)` | `0008_payment_webhook_idempotency.sql` |
| One gateway payment → one local payment row | `payments_provider_payment_unique` |
| One notification per event | `notifications_one_per_webhook_event` |
| Idempotency key from `X-Razorpay-Event-Id`, else a digest of the event's identity | `supabase/functions/_shared/webhook.ts` |
| Claim-then-act handler: duplicate returns `200 {duplicate:true}` before touching anything | `supabase/functions/payments-webhook/index.ts` |
| Success / pending / failed / ignored, out-of-order delivery, and a capture after a failure | same file, `classify()` + `shouldApply()` |
| Tested: 18/18 logic assertions; replay simulation leaves exactly 1 event, 1 notification, 1 verified payment; same gateway id twice rejected; different provider same id kept separate | Node + PostgreSQL |

### Priority 5 — Responsive sweep of all 23 pages (done)

- 23 HTML pages + 7 dashboard views (they share one URL) = 29 targets × 3 widths
  (1440 / 834 / 390 px) = **87 combinations**, all screenshotted: 87 images in
  `docs/media/responsive/`.
- Measured per page and width: horizontal overflow, the elements causing it, tap
  targets under 32 px, console errors, failed requests, and whether the page
  rendered visible text.
- **Final: 87/87 clean, 0 issues.**
- Two real defects found and fixed:
  1. `/download/` overflowed the mobile viewport by 129 px (grid track could not
     shrink below the width of a `white-space: pre` code block).
  2. `/system-check/` never settled — 40+ probes run one after another, over 30 s.
     Parallelised: now 6.4 s.
- Reports: `docs/RESPONSIVE-REPORT.md` (generated), `docs/RESPONSIVE-FIXES.md`
  (what was found and changed).

### Priority 1 — Migration 0006 (reviewed, proven on staging, **not applied**)

- Reviewed against the existing schema and RLS; two design faults found and fixed
  before staging (a column grant that would have hidden columns from the admin
  panel, and a duplicate-bearing database that would have failed the index).
- **Replayed on real PostgreSQL 18**: today's schema (`0001`…`0005`), then
  realistic rows including the duplicates the constraints exist to stop, then
  `0006`, `0007`, `0008`. **57 checks, 0 failed**, including "all 7 payment rows
  still exist", "both verified payments kept their reference, UTR and amount" and
  "all eight migrations are idempotent".
- **Live project measured:** `node scripts/verify-migration.mjs` reports 0006,
  0007 and 0008 **not applied** — the project is exactly at the baseline staging
  replays, with 0 payment rows and 0 service requests.
- **Not applied because the credential does not exist here.** `.env` holds the
  project URL and publishable key only; there is no `SUPABASE_ACCESS_TOKEN`,
  service-role key or database password. Everything needed to finish it in one
  command is built and tested (see §4).

### Priority 2 — Password reset (all failure paths verified, delivery blocked)

- Reset page now names the reason a link fails — expired / already used / opened
  in a different browser — and always offers **Request a new link**; the fragment
  is cleared after a successful update.
- 12/12 browser checks pass: expired link (fragment and query string), used link,
  bare visit, no false success, form disabled, escape hatch present, callback
  reports failure, reset request reaches Supabase, wording stays conditional for
  an unknown address, no crash.
- **The mailbox half was not tested**: no mailbox, no SMTP credentials. Details and
  an eight-step checklist in `docs/PASSWORD-RESET-TEST.md`.

---

## 2. Pending

| Item | State | Why |
| --- | --- | --- |
| Apply 0006, 0007, 0008 to the live project | Ready, one command | Needs `SUPABASE_ACCESS_TOKEN` or a manual SQL-editor run |
| Password reset against a real mailbox | Ready, needs a mailbox | The two steps a sandbox cannot do: receiving the email, using the link |
| Windows `.exe` | Deferred by you | Electron source and NSIS config are complete |
| Google Business Listing workflow | Deferred by you | The service request path exists; the multi-step flow does not |
| Admin representative assignment UI | Deferred by you | Columns and customer-facing rendering exist in 0006; the admin form does not |
| Deploy the changed Edge Function | Not deployed | `payments` and `payments-webhook` changed in this pass. Deploying needs the CLI or an access token. **Until it is deployed, the live functions still have last month's behaviour** — the sandbox and the migrations do not |

---

## 3. Tests performed (summary)

| Suite | Count | Result |
| --- | --- | --- |
| Staging database (migrations on PostgreSQL 18) | 57 checks | 0 failed |
| Webhook logic (`_shared/webhook.ts` in Node) | 18 assertions | 0 failed |
| Payment reference concurrency (live sandbox) | 4 scenarios | Pass |
| Password reset (real Chromium, live Supabase) | 12 checks | 0 failed |
| Responsive audit (23 pages + 7 views × 3 widths) | 87 combinations | 0 issues |
| Static integrity (`scripts/check.mjs`) | module graph, CSS, 23 pages | Pass |
| Staging database, all nine migrations | 84 checks | 0 failed |
| Admin authority, sandbox backend (`tests/admin-authority.test.mjs`) | 58 checks | 0 failed |
| Admin console, browser (`tests/browser/admin-access.mjs`) | 17 checks | 0 failed |
| AI provider error handling (`tests/ai-errors.test.mjs`) | 56 checks | 0 failed |
| Migration verification queries (`tests/migration-verify-sql.test.mjs`) | 27 checks | 0 failed |
| Backup restore tool (`tests/db-restore.test.mjs`) | 17 checks | 0 failed |
| Header layout (Chromium, 13 widths) | 72 checks | 0 failed |
| Monitoring access (server matrix + UI states) | 4 + 7 checks | 0 failed |
| Reset link copy (2 bad-link entry points) | 6 checks | 0 failed |
| TypeScript parse (`esbuild`) on changed edge functions | 3 files | Parse only — no `tsc` in this environment |

Full row-by-row detail: `TESTING-REPORT.md` §7. Migration detail:
`docs/MIGRATION-REPORT.md`. Payments detail: `docs/PAYMENTS-INTEGRITY.md`.

---

## 4. Actions required from you

**The full, ordered procedure is `docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md`** —
backup, the four migrations, secrets, function deployment, protected-owner
verification, rollback and post-deployment tests, with the expected output of
every step. Nothing in it has been run against production.

**1. Apply the migrations (5 minutes) — now four files, 0006 → 0009.** Either:

```bash
echo 'SUPABASE_ACCESS_TOKEN=sbp_…' >> .env   # Supabase → Account → Access tokens
node scripts/apply-migrations.mjs            # --dry-run first to see the plan
```

…which takes a backup, applies each file in its own transaction, re-reads the
project, and writes a receipt with hashes and before/after row counts to
`docs/migration-receipts/`. Or paste `0006`, `0007`, `0008`, `0009` into the SQL
editor in order, then run `node scripts/verify-migration.mjs` to confirm. I will
not apply them myself unless you ask me to.

**2. Deploy the changed Edge Functions** — `admin` (new actions the Access page
calls) plus `payments` and `payments-webhook`:

```bash
node scripts/deploy-functions.mjs admin payments payments-webhook   # reads config.toml
# or, by hand:
npx supabase functions deploy admin payments --project-ref zmkgfmlcpzjfgxdmbtvi
npx supabase functions deploy payments-webhook --no-verify-jwt --project-ref zmkgfmlcpzjfgxdmbtvi
```

`payments-webhook` must keep `--no-verify-jwt`: the HMAC signature is the
authority there, so it cannot be bundled with the other two on one command line.
Deploy the functions **after** the migrations — `admin` calls functions that
`0009` creates.

**3. Run the mailbox checklist** in `docs/PASSWORD-RESET-TEST.md` §4 (eight steps)
when you have a few minutes. If you would rather I run it, I need an address I can
open — a temporary mailbox is enough.

**4. Confirm your account is on the administrator list** (one query, read-only):

```sql
select user_id, email, role from public.admin_users;
```

`mext.Aditya@gmail.com` must appear there. Monitoring reads that table with your
own token, so the row is the whole authorisation decision.

**5. Add the redirect URL** `https://shinzora.in/auth/callback/**` in Supabase →
Authentication → URL Configuration, or reset links will land on the Site URL
instead of the reset screen.

---

## 5. What is not claimed

- No migration was applied to the live project, and no receipt exists yet.
- No email was received or opened; no real password was changed.
- No `.exe`, APK, IPA, DMG or AppImage exists.
- The edge functions were not deployed, so their live behaviour is unchanged.
- Migration 0009 has not been applied to the live database and the `admin` Edge
  Function has not been deployed, so the Access page will report that the
  directory function is missing until step 1 and step 2 are done.
- The browser evidence for Phase 3 ran against the pre-launch sandbox backend,
  not against Supabase with a real super administrator account.
- No screenshot, statistic or status in the reports was generated without a real
  run behind it.
- The monitoring authorisation rule was verified against a stand-in Supabase
  endpoint, not your live account; the live `admin_users` row was not read.
- The password-reset flow is still untested end-to-end: no email was sent to a
  real mailbox, so "the link arrives and works" remains unproven.
