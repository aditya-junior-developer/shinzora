# SHINZORA — localhost to live website

**Report date:** 7 November 2026
**Source inspected:** the project in this workspace (`/home/user/shinzora`), which is the same tree as `shinzora-1.0.0.zip`
**Target:** `https://shinzora.in` via GitHub `shinzora-ai/shinzora` → Vercel

> **Nothing was deployed, pushed, migrated, or sent to production Supabase.** Every check below ran locally against `public/`, local Node processes, or an in-memory PostgreSQL 18. Where something could not be verified from here, it says so instead of guessing. The private GitHub remote could not be inspected — no access to it from this environment — so §5 and §10 include the exact commands you run to confirm the remote matches this tree.

---

# PHASE 1 — How the website actually works

## 1.1 Project root

```
/home/user/shinzora/          ← repository root (this is what Vercel imports)
├── public/                   ← the entire website: 23 HTML pages, 69 JS modules, 12 stylesheets
├── api/prelaunch/[...path].js← one serverless function (the pre-launch sandbox backend)
├── server/prelaunch/         ← the router that function imports (6 modules, ~4,000 lines)
├── supabase/                 ← 9 migrations + 9 Edge Function directories
├── scripts/                  ← 23 maintenance scripts (build, verify, backup, deploy)
├── tests/                    ← 12 test suites
├── docs/                     ← 18 documents + screenshots
├── desktop/                  ← Electron wrapper (not part of the website)
├── vercel.json               ← hosting rules
├── package.json              ← zero dependencies, "type": "module", node >=20
└── .env                      ← local credentials (gitignored — see §5)
```

## 1.2 How it runs locally

| Question | Answer |
| --- | --- |
| Runtime | **Node.js 20+**. No framework, no bundler, no npm dependencies (`dependencies: {}`, `devDependencies: {}`) |
| Start command | `node scripts/dev-server.mjs --port 4173` — also `npm run dev` |
| What that server is | a ~300-line static file server that imitates the production host: clean URLs, trailing slashes, cache headers, a branded 404, and on-the-fly generation of `/js/config/runtime.js` from `.env` |
| Frontend | **completely static** — vanilla ES modules, no server-side rendering, no build step for the pages |
| The only "build" | `node scripts/generate-config.mjs` writes `public/js/config/runtime.js` with public values. That is the whole build |
| Backend | **Supabase** (Postgres, Auth, Storage, Realtime) + **9 Supabase Edge Functions** (Deno) |
| Second backend | the pre-launch sandbox router, served locally by the dev server and on Vercel by `api/prelaunch/[...path].js` |

## 1.3 Complete feature inventory

**Marketing and public pages (23 HTML files, 21 routable pages)**

| Route | Purpose |
| --- | --- |
| `/` | home page, pricing, feature sections |
| `/docs/` | product documentation (static, self-contained) |
| `/legal/terms/`, `/legal/privacy/`, `/legal/refunds/`, `/legal/acceptable-use/` | legal pages |
| `/download/`, `/install/`, `/install-guide/` | app download and desktop setup instructions |
| `/system-check/` | live diagnostic page: schema pieces and provider configuration |
| `/404.html`, `/offline.html` | error and offline fallbacks |
| `/site/` | renders a published customer site by slug (rewritten from `/site/:slug`) |

**Authentication pages**

| Route | Purpose |
| --- | --- |
| `/auth/signup/` | create account (Supabase Auth) |
| `/auth/login/` | sign in with email/password, plus Google OAuth button |
| `/auth/forgot-password/` | request a reset email |
| `/auth/reset-password/` | choose a new password after the email link |
| `/auth/verify-email/` | post-signup verification state, resend link |
| `/auth/callback/` | the single landing page for every auth redirect (verification, recovery, OAuth) |

**Customer dashboard `/app/` — 17 views**

`overview` · `projects` · `website-builder` · `app-builder` · `assistant` · `store` · `inventory` · `orders` · `customers` · `marketing` · `analytics` · `domains` · `billing` · `support` · `requests` · `notifications` · `settings`

**Admin console `/admin/` + `/admin-login/` — 6 views**

`overview` · `access` (administrators, roles, audit trail) · `payments` (manual UPI verification) · `operations` (service requests) · `messaging` (tickets, contacts, announcements) · `monitoring` (probes and events)

**Onboarding** `/onboarding/` — workspace setup after signup.

**Cross-cutting front-end features:** service worker + installable PWA (`public/sw.js`, `manifest.webmanifest`), offline page, notification badge, toasts, modals, form validation, icon system, 12 stylesheets, 4 fonts, brand mark and UPI QR assets.

**Supabase Edge Functions (9 directories)**

| Function | Role | JWT check |
| --- | --- | --- |
| `ai` | AI proxy — the Gemini key never leaves the server | on |
| `admin` | 30+ administrator actions behind the console | on |
| `payments` | payment creation, proof submission, admin review | on |
| `payments-webhook` | gateway callbacks, idempotent | **off** (HMAC) |
| `config` | reports which providers are configured — booleans only | off |
| `site` | serves published customer sites | off |
| `domains` | availability and registration | on |
| `integrations` | GitHub / Vercel OAuth and tokens | on |

**Database:** 35 tables across 9 migrations (`0001`–`0009`).

## 1.4 How authentication and data actually flow

1. `public/js/vendor/supabase-js.js` is loaded by every page.
2. `public/js/lib/supabase.js` creates the client with the **publishable** key and pins `storageKey: "shinzora.auth"`.
3. Every request first passes through `public/js/lib/prelaunch.js`. If a sandbox session cookie exists, data calls are routed to `/api/prelaunch/*`; otherwise they go to `https://zmkgfmlcpzjfgxdmbtvi.supabase.co` directly.
4. `signIn()` tries the sandbox accounts first and **falls through to `supabase.auth.signInWithPassword` for every other address** — so real users are unaffected by sandbox configuration.
5. Auth emails use `authRedirect(path)` = `SITE_URL` if set, otherwise `location.origin`, always landing on `/auth/callback/?next=…`.
6. Uploads for real accounts go to **Supabase Storage** (`sb.storage.from("avatars").upload(...)`); sandbox uploads go to the local router.
7. There is no server-side rendering and no server-held session for real users — the browser talks to Supabase directly, protected by Row Level Security.

## 1.5 Does anything depend on localhost?

**No — except two cosmetic defaults.**

| Location | What it is | Effect in production |
| --- | --- | --- |
| `public/js/boot/site.js` | skips subdomain parsing on `localhost`/IPs | none — it bails early only for local hosts |
| `public/js/ui/pwa.js` | registers the service worker only on HTTPS or localhost | correct: Vercel is HTTPS, so the PWA works |
| `public/js/config/runtime.js` | currently holds `SITE_URL: http://localhost:4173` because it is generated from the local `.env` | **regenerated at build time on Vercel** — verified in §4.4 |

No page, module or Edge Function hard-codes `localhost` in a way that would break on a real domain.

## 1.6 Which API routes need separate hosting?

Exactly one path prefix does: **`/api/prelaunch/*`**, served by `api/prelaunch/[...path].js`. Everything else talks straight to Supabase, which is already hosted.

That function exposes: `/health`, `/auth/login`, `/auth/logout`, `/auth/session`, `/identity`, `/storage/v1/*`, `/rest/v1/*`, `/fn/*`, `/monitor`, `/monitor/read`, `/events`, `/reset`.

## 1.7 Environment variables

**Read at build time (public values, baked into `runtime.js`):**

`SHINZORA_SUPABASE_URL` · `SHINZORA_SUPABASE_PUBLISHABLE_KEY` · `SHINZORA_SITE_URL` · `SHINZORA_SUPPORT_EMAIL` · `SHINZORA_APP_NAME` · `SHINZORA_ENVIRONMENT` · `SHINZORA_RAZORPAY_KEY_ID` — with `VITE_*` accepted as aliases.

**Read at runtime by `api/prelaunch` (private):**

`PRELAUNCH_USER_EMAIL` · `PRELAUNCH_USER_PASSWORD_HASH` · `PRELAUNCH_ADMIN_EMAIL` · `PRELAUNCH_ADMIN_PASSWORD_HASH` · `PRELAUNCH_SESSION_SECRET` · `PRELAUNCH_DATA_DIR` (optional) · `SHINZORA_AI_API_KEY` (optional, sandbox AI)

**Also needed by that function — found during this inspection:**

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. `server/prelaunch/router.mjs` uses them to verify an administrator's Supabase token so the console's Monitoring page authorises against `admin_users` through RLS. Without them the function returns 403 for a real administrator. This is **not** documented in `docs/DEPLOYMENT.md` §4 and would have been missed.

---

# PHASE 2 — Will it work on Vercel?

## 2.1 Verdict per feature

| Feature | Works on Vercel? | Why / what it needs |
| --- | --- | --- |
| Home page and all marketing pages | **yes** | static files |
| `/docs/`, legal, download, install, install-guide | **yes** | static |
| Navigation, redirects (`/login`, `/signup`, `/dashboard`, `/pricing`), the `/site/:slug` rewrite | **yes** | declared in `vercel.json`, verified locally in §6 |
| CSS, JS modules, fonts, icons, brand assets | **yes** | served from `public/`, cache headers declared |
| `/system-check/` | **yes** | it reports what the live project says; no local dependency |
| Sign up, sign in, sign out, session refresh | **yes** | Supabase Auth in the browser |
| Google OAuth button | **yes, once configured** | needs the new origin in Supabase → Providers → Google; otherwise the UI already says "not enabled" |
| Email verification | **yes, once configured** | needs Site URL + redirect allow-list in Supabase (§7) |
| Password reset / forgot password | **yes, once configured** | same, plus a working SMTP sender in Supabase |
| Customer dashboard `/app/` (17 views) | **yes** | reads/writes Postgres through RLS |
| Uploads (avatars etc.) | **yes** | Supabase Storage buckets + policies |
| Published customer sites `/site/:slug` | **yes** | rewrite + `site` Edge Function |
| AI assistant | **yes, if the `ai` function is deployed and its key is set** | key lives in Supabase secrets, never in the bundle |
| Admin console — overview, customers, messaging | **yes** | ordinary tables/actions |
| **Admin console — Access, Payments, Operations, Monitoring** | **partial on day one** | these call the `admin` Edge Function, which is **not deployed** and whose tables do not exist until `0009` is applied. The pages report that honestly instead of showing fake data |
| Manual UPI payments | **depends** | needs `payments` + `payments-webhook` deployed and `UPI_ID` set |
| Prelaunch sandbox sign-in (2 demo accounts) | **degraded** | see §2.2 |
| Admin Monitoring page | **degraded** | see §2.2 |
| Desktop app download | **unaffected** | it is a separate Electron build; the site only links to it |
| Domains, GitHub/Vercel integrations | **yes, unconfigured** | they report "not connected" until provider keys exist |

## 2.2 Things that work locally but behave differently online

These are the honest gaps. None of them stop the website going live; all of them should be known before you point a domain at it.

**1. The pre-launch sandbox is not durable on Vercel.**
`api/prelaunch/[...path].js` writes its sandbox database to `/tmp/shinzora-prelaunch` because Vercel's project directory is read-only. Each serverless instance gets its own `/tmp`, and instances are recycled. Consequence: the two sandbox accounts can sign in, but rows they create may not be visible on the next request, and reseed whenever a new instance starts. The file's own header comment states this. Real customer accounts are not affected — they never touch this path.

**2. The sandbox sign-in is unavailable unless `PRELAUNCH_*` is set.**
Without those five variables, `/api/prelaunch/health` reports no accounts and the two demo logins are simply not offered. Everything else keeps working because `signIn()` falls through to Supabase.

**3. Admin Monitoring will be near-empty online.**
The page reads a probe log produced by `server/prelaunch/monitor.mjs`, which only exists where that server has been running. On Vercel the log is per-instance `/tmp`, so the panel will usually show no entries. The endpoint itself works and still authorises properly — it just has nothing to read. Also: it returns 403 unless `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY` are set (see §1.7).

**4. The local dev server is not deployed.**
`scripts/dev-server.mjs` exists only for development. On Vercel, `vercel.json` + the `api/` function replace it. Nothing in `public/` requires it.

**5. Phase 3 admin features depend on Supabase state, not on hosting.**
Migrations `0006`–`0009` and the `admin` function are not applied/deployed. That is a Supabase task (`docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md`), independent of GitHub and Vercel. Hosting will not fix it, and it does not block the public site.

**6. Service worker and cache scope.**
`public/sw.js` (v16) is origin-scoped. The `vercel.app` preview origin and `shinzora.in` are separate origins with separate caches — expected and harmless. `sw.js` is served with `no-store` and `Service-Worker-Allowed: /`.

**7. `X-Frame-Options: SAMEORIGIN`.**
Set in `vercel.json`. The live site cannot be embedded in someone else's iframe. This is intentional; only relevant if you ever want to embed Shinzora pages elsewhere.

**8. Cold starts on `/api/prelaunch`.**
The first request after idle may take ~1s. Only affects sandbox endpoints.

---

# PHASE 3 — GitHub preparation and security audit

## 3.1 What `.gitignore` actually excludes (verified with real `git check-ignore`, not by reading)

| Path | Status |
| --- | --- |
| `.env`, `.env.local`, `.env.production`, `.env.*` | **ignored** |
| `.backups/` (database dumps with customer data) | **ignored** |
| `.prelaunch/` (sandbox data, monitor log) | **ignored** |
| `node_modules/` | **ignored** |
| `public/js/config/runtime.js` (generated config) | **ignored** |
| `*.zip`, `dist/`, `build/`, `release/`, `coverage/`, `test-results/`, `.tmp/`, `*.log` | **ignored** |
| `supabase/.temp/`, `supabase/.branches/`, `supabase/.migrations-applied` | **ignored** |
| `.env.example` | **committed on purpose** — placeholders only, verified: values are `sb_publishable_xxxxx` and blanks |
| `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*` | **were NOT ignored — fixed in this pass** |
| `supabase/.env`, `supabase/.env.*` | **ignored** |

The certificate gap was the only miss. I appended six rules to `.gitignore`. It changes no application behaviour.

## 3.2 Is any real credential in the tree?

Scanned every file outside `.env`, `.prelaunch/` and `node_modules/` for Gemini key shapes (`AIza…`), service-role and secret keys (`sb_secret_…`), legacy JWTs (`eyJhbGci…`) and personal access tokens (`sbp_…`):

**No matches.** The only occurrences of the string `service_role` are in prose explaining that it must never be exposed (`public/js/config/env.js`, `public/docs/index.html`). The one key that *is* in `public/` is the **publishable** key `sb_publishable_…`, which is public by design — RLS is the control.

## 3.3 Credentials that exist locally, and what to do with them

| Credential | Where it lives | In Git? | Action |
| --- | --- | --- | --- |
| Supabase publishable key | `public/js/config/env.js` fallback + `.env` | yes (intended) | none — public by design |
| Supabase URL | same | yes | none |
| `SHINZORA_AI_API_KEY` (Gemini) | `.env` only, 53 chars | **no** | **rotate — see 3.4** |
| `PRELAUNCH_USER_PASSWORD_HASH`, `PRELAUNCH_ADMIN_PASSWORD_HASH` | `.env` | no | generate fresh ones for Vercel |
| `PRELAUNCH_SESSION_SECRET` (48 bytes hex) | `.env` | no | generate a **new** one for production; do not reuse the development value |
| Service-role key | not present anywhere in the tree | no | never add it — not needed by the frontend or the sandbox function |

## 3.4 Exposure report — is rotation necessary?

**The Gemini API key: yes, rotate it.** Two independent reasons:

1. It was used through the whole development cycle in this workspace and is already recorded in the project's own delivery notes as exposure-tainted.
2. **Your GitHub repository was Public before it was made Private.** If `.env` was ever committed during that window, the key has been publicly readable, and GitHub's caches and forks are not something you can reliably recall. `.gitignore` covers `.env` today, but the history is what matters.

Check the history — on your machine, in the repo:

```bash
git log --all --oneline -- .env
git log --all -p -- .env | grep -E "^\+[A-Z_]+=" | cut -c1-40
git log --all --oneline -- .prelaunch .backups
```

No output from the first command means `.env` was never committed. On GitHub itself you can search the repository for `SHINZORA_AI_API_KEY` and check **Settings → Code security → Secret scanning** for alerts.

If anything shows up:
1. Revoke that Gemini key in Google AI Studio and issue a new one.
2. Put the new key **only** in Supabase → Project Settings → Edge Functions → Secrets as `SHINZORA_AI_API_KEY` — never in the repo, never in Vercel's frontend env.
3. Generating a new key makes history exposure irrelevant; rewriting Git history is optional and not worth the risk for a single key.

**The publishable Supabase key:** no rotation needed. It is designed for browsers and constrained by RLS.
**The service-role key:** not in the repository; no action.
**Supabase database password / access token:** not in the tree. Keep it that way — `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_URL` are listed in `.env.example` because the maintenance scripts use them; they must only ever be set in your local shell.

## 3.5 Original files preserved

Nothing was deleted, no backup was removed, and `shinzora-1.0.0.zip` was not modified. The only file changed in this pass is `.gitignore` (six added lines). No hosting-ready copy is needed: the tree is already exactly what Vercel should import.

---

# PHASE 4 — Vercel configuration

## 4.1 `vercel.json` is already correct

| Setting | Declared | Correct? |
| --- | --- | --- |
| `outputDirectory` | `public` | yes |
| `buildCommand` | `node scripts/generate-config.mjs` | yes |
| `cleanUrls` | `true` | yes |
| `trailingSlash` | `true` | yes — matches the folder-per-route structure |
| Security headers | `nosniff`, `SAMEORIGIN`, `strict-origin-when-cross-origin`, `Permissions-Policy`, HSTS 2 years | yes |
| Cache: `/js`, `/css` | `max-age=0, must-revalidate` | yes — so a new deploy is picked up |
| Cache: `/assets` | 1 year, immutable | yes |
| `/sw.js` | `no-store` + `Service-Worker-Allowed: /` | yes — required for a correct service worker |
| `noindex` | `/app/`, `/admin/`, `/admin-login/`, `/onboarding/` | yes |
| Redirects | `/dashboard`→`/app/`, `/login`→`/auth/login/`, `/signup`→`/auth/signup/`, `/pricing`→`/#pricing` | yes |
| Rewrite | `/site/:slug` → `/site/index.html?p=:slug` | yes |

`api/` sits at the repository root, outside `public/`, exactly as it should. `public/index.html` exists.

## 4.2 Build behaviour, tested

I ran the real build with production-shaped environment variables and no `.env`:

```
SHINZORA_SUPABASE_URL=… SHINZORA_SUPABASE_PUBLISHABLE_KEY=… \
SHINZORA_SITE_URL=https://shinzora.in SHINZORA_ENVIRONMENT=production \
node scripts/generate-config.mjs
```

Output written to `public/js/config/runtime.js`:

```js
window.__SHINZORA_ENV__ = {
  "SUPABASE_URL": "https://zmkgfmlcpzjfgxdmbtvi.supabase.co",
  "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_…",   // public by design
  "SITE_URL": "https://shinzora.in",
  "SUPPORT_EMAIL": "official.shinzora@proton.me",
  "APP_NAME": "Shinzora",
  "ENVIRONMENT": "production",
  "RAZORPAY_KEY_ID": ""
};
```

The script also refuses to write anything whose name contains `SERVICE_ROLE`, `SECRET`, `GEMINI`, `PRIVATE` or `WEBHOOK`. I restored the local development values afterwards, so the workspace still matches `.env`.

## 4.3 Runtime and imports

- `package.json` has `"type": "module"` and `"engines": { "node": ">=20" }`; `api/prelaunch/[...path].js` uses `export default` and `export const config = { api: { bodyParser: false } }` — the standard Vercel Node-function contract.
- It imports `fs`, `os`, `path` and reads the raw request stream. **It must run on the Node.js runtime, not Edge.** Vercel's default for `/api/*.js` is Node, so no configuration is needed — just do not switch the function to Edge.
- No package installation is required: there are zero dependencies, so `npm install` on Vercel is a no-op and cannot fail.

## 4.4 Files that must not move

`api/` stays at the root. `public/` stays the output directory. `supabase/functions/*` are deployed by the Supabase CLI, not by Vercel — Vercel will simply ignore them.

---

# PHASE 5 — Supabase configuration

## 5.1 Public vs private configuration

**Public — goes in Vercel (and ends up in the browser):**

```
SHINZORA_SUPABASE_URL=https://zmkgfmlcpzjfgxdmbtvi.supabase.co
SHINZORA_SUPABASE_PUBLISHABLE_KEY=sb_publishable_fXoUaZPWuEceigIlk63htA_WavvP5Al
SHINZORA_SITE_URL=https://shinzora.in
SHINZORA_SUPPORT_EMAIL=official.shinzora@proton.me
SHINZORA_APP_NAME=Shinzora
SHINZORA_ENVIRONMENT=production
```

**Public-ish — also needed by the serverless function (do not confuse with secrets):**

```
SUPABASE_URL=https://zmkgfmlcpzjfgxdmbtvi.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_fXoUaZPWuEceigIlk63htA_WavvP5Al
```

**Private — never in Vercel's frontend variables, never in the repo:**

| Secret | Where it belongs |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Edge Functions → Secrets (Supabase sets it automatically) |
| `SHINZORA_AI_API_KEY` (Gemini) | Supabase → Edge Functions → Secrets |
| `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Supabase → Edge Functions → Secrets |
| `UPI_ID`, `UPI_PAYEE_NAME` | Supabase → Edge Functions → Secrets (the VPA is shown to payers, but it is configured server-side) |
| Database password, `SUPABASE_ACCESS_TOKEN` | your local shell only |
| `PRELAUNCH_*_PASSWORD_HASH`, `PRELAUNCH_SESSION_SECRET` | Vercel → Environment Variables (server-side function only; never `NEXT_PUBLIC_`/`VITE_` prefixed) |

## 5.2 Supabase Auth settings that must change for the new domain

These are dashboard settings, not code. **I have not changed them** — they are on your production project.

1. **Authentication → URL Configuration → Site URL**
   `https://shinzora.in`
2. **Redirect URLs** (add all that apply):
   ```
   https://shinzora.in/auth/callback/**
   https://shinzora.in/auth/reset-password/**
   https://www.shinzora.in/auth/callback/**
   https://<your-project>.vercel.app/auth/callback/**
   https://<your-project>.vercel.app/auth/reset-password/**
   ```
   The wildcard at the end matters: the callback URL carries `?next=…`, and a non-wildcard entry will not match.
3. **Authentication → Providers → Google** (only if you use the Google button): add `https://shinzora.in` and your Vercel preview origin to the authorised JavaScript origins / redirect URIs in the Google Cloud console.
4. **Email delivery:** verification and reset emails are sent by Supabase. If custom SMTP is not configured, they use Supabase's rate-limited sender and may be slow or land in spam. Nothing in the website can fix that; it is a project setting.
5. **CORS:** Supabase accepts browser requests from any origin for the publishable key, constrained by RLS. No allow-list entry is needed for REST/Auth. (If you later restrict allowed origins in a proxy, add `https://shinzora.in`.)

No migration and no schema change is required to host the frontend. The `0006`–`0009` work is a separate, already-documented step and remains untouched.

---

# PHASE 6 — Validation results (actually run, in this workspace)

| Check | Command | Result |
| --- | --- | --- |
| Deployment rules | `node scripts/verify-deploy.mjs` | **Pass — 18 assertions** |
| Static integrity | `node scripts/check.mjs` | **Pass** — 69 modules, 23 pages, 9 migrations, backup table list covers 35/35 |
| Route smoke | `node scripts/smoke.mjs` | **23 routes + 4 header checks passed** |
| Branding | `node tests/branding.test.mjs` | **14 passed, 0 failed** |
| AI error handling | `node tests/ai-errors.test.mjs` | **56 passed, 0 failed** |
| Admin authority | `node tests/admin-authority.test.mjs` | **58 passed, 0 failed** |
| Migration verification SQL | `node tests/migration-verify-sql.test.mjs` | **27 passed, 0 failed** |
| Backup/restore tool | `node tests/db-restore.test.mjs` | **17 passed, 0 failed** |
| Staging database | `node scripts/staging-db.mjs` | **84 checks, 0 failed — STAGING PASSED** |
| Config build | `node scripts/generate-config.mjs` with production env | **Wrote correct runtime.js, no secrets** |

`verify-deploy.mjs` in full:

```
✓ all 21 pages resolve to 200
✓ redirect /dashboard → /app/ — 307 → /app/
✓ redirect /login → /auth/login/ — 307 → /auth/login/
✓ redirect /signup → /auth/signup/ — 307 → /auth/signup/
✓ redirect /pricing → /#pricing — 307 → /#pricing
✓ /auth/login 308s to /auth/login/
✓ following that redirect lands on the sign-in page
✓ rewrite /site/:slug serves the site renderer — 200
✓ /admin/ is noindex — noindex, nofollow
✓ security headers apply (nosniff)
✓ HSTS is set on the document
✓ framing is restricted in production (SAMEORIGIN)
✓ CSS served as text/css
✓ CSS revalidated, not immutable
✓ unknown path returns the branded 404
✓ /js/config/runtime.js exists in the build
✓ runtime config carries a Supabase URL
✓ runtime config carries no service-role key
```

(21 routable pages + `404.html` + `offline.html` = the 23 HTML files.)

**What was not run, and why:** the Playwright browser suites (`test:admin-ui`, `test:browser`, `test:layout`, `test:visual`, `test:install`, `test:shell`) need a Chromium download that is not present in this environment; the Deno function tests need Deno. Nothing failed — they did not run, and I am not counting them as passes. Run them on your machine with `npx playwright install chromium` and `deno` if you want that coverage before go-live.

**Nothing failed.** No blocker for hosting was found in any check above.

---

# PHASE 7 — The deployment, step by step

Beginner-friendly. Nothing here has been done for you, and nothing here touches Supabase.

### STEP 1 — Prepare the GitHub project

1. Download `shinzora-1.0.0.zip` and unzip it. You get a folder `shinzora/`.
2. Open a terminal **inside that folder** (the one containing `package.json` and `public/`).
3. Confirm the two safety files exist:

```bash
ls -a | grep -E "^\.gitignore$|^\.env$"
```

4. Confirm `.env` is excluded before anything else happens:

```bash
git init -q && git check-ignore -v .env
```

You want a line showing `.env` matched. If it prints nothing, **stop** — do not continue until `.env` is ignored.
5. Never type the contents of `.env` into any file that will be committed. If you need the values on Vercel, copy them from the `.env` file into the Vercel dashboard directly.

### STEP 2 — Upload to `https://github.com/shinzora-ai/shinzora`

The repository already exists and is Private. Two cases:

**If the repository is empty** (no commits yet):

```bash
git init -q
git add .
git status --short | head -30          # only project files, no .env, no node_modules
git commit -m "Shinzora 1.0.0"
git branch -M main
git remote add origin https://github.com/shinzora-ai/shinzora.git
git push -u origin main
```

**If the repository already has content you want to replace:**

```bash
git clone https://github.com/shinzora-ai/shinzora.git remote-check
cd remote-check && git log --oneline | head -5 && cd ..
```

Then copy the project files in (not `.env`), commit, and push. Do not force-push until you have confirmed the remote has nothing you need — force-pushing deletes commits.

**Before you push, verify nothing private is staged:**

```bash
git ls-files | grep -E "^\.env$|^\.backups/|^\.prelaunch/|runtime\.js|\.pem$|\.key$"
```

That must print nothing.

### STEP 3 — Connect GitHub to Vercel

1. Sign in at vercel.com.
2. **Add New… → Project**.
3. Choose **Continue with GitHub** and authorise Vercel. If the private repo does not appear, click **Adjust GitHub App Permissions** and grant access to `shinzora-ai/shinzora`.

### STEP 4 — Import the SHINZORA repository

1. In the repository list, find `shinzora-ai/shinzora` → **Import**.
2. Leave **Root Directory** empty (the repository root). **Do not set it to `public`.**
3. Do not click Deploy yet — the next two steps override the defaults.

### STEP 5 — Exactly which settings to select

| Setting | Value |
| --- | --- |
| Project Name | `shinzora` (this becomes part of the free `.vercel.app` URL) |
| Framework Preset | **Other** |
| Root Directory | *(blank — repository root)* |
| Build Command | `node scripts/generate-config.mjs` |
| Output Directory | `public` |
| Install Command | *(leave default)* |
| Node.js Version | **20.x** or newer (Project → Settings → General → Node.js Version) |

`vercel.json` already declares the build and output, so Vercel will prefill them. Confirm they match anyway.

### STEP 6 — Environment variables

Add these in **Settings → Environment Variables**. Select **Production** and **Preview** for each (and Development if you like).

| Name | Value | Environment |
| --- | --- | --- |
| `SHINZORA_SUPABASE_URL` | `https://zmkgfmlcpzjfgxdmbtvi.supabase.co` | Production, Preview |
| `SHINZORA_SUPABASE_PUBLISHABLE_KEY` | your `sb_publishable_…` key | Production, Preview |
| `SHINZORA_SITE_URL` | `https://shinzora.in` | Production (use the vercel.app URL for Preview if you prefer) |
| `SHINZORA_SUPPORT_EMAIL` | `official.shinzora@proton.me` | Production, Preview |
| `SHINZORA_APP_NAME` | `Shinzora` | Production, Preview |
| `SHINZORA_ENVIRONMENT` | `production` | Production |
| `SUPABASE_URL` | `https://zmkgfmlcpzjfgxdmbtvi.supabase.co` | Production, Preview |
| `SUPABASE_PUBLISHABLE_KEY` | same publishable key | Production, Preview |

Optional — only if you want the two pre-launch demo accounts on the live site:

| Name | Value |
| --- | --- |
| `PRELAUNCH_USER_EMAIL` | `business@business.com` |
| `PRELAUNCH_USER_PASSWORD_HASH` | generate with `node scripts/prelaunch-credentials.mjs --show` |
| `PRELAUNCH_ADMIN_EMAIL` | `Shinzora@admin` |
| `PRELAUNCH_ADMIN_PASSWORD_HASH` | same tool |
| `PRELAUNCH_SESSION_SECRET` | a **fresh** 32+ character random string (not the development one) |

Leave these out and the sandbox is simply unavailable; real accounts are unaffected. **Never** put the service-role key, the Gemini key or any password in plain text here.

### STEP 7 — Deploy

Click **Deploy**. First build takes about a minute. Expected log lines:

```
Running "install" command: npm install        → up to date (no dependencies)
Running "build" command: node scripts/generate-config.mjs
[shinzora] wrote public/js/config/runtime.js
Build Completed
```

Every later push to `main` redeploys automatically.

### STEP 8 — Connect `shinzora.in`

1. Vercel → your project → **Settings → Domains → Add**.
2. Add `shinzora.in`, then add `www.shinzora.in`. Vercel shows the DNS records to create.
3. At your registrar (where you bought `shinzora.in`):
   - **Apex `shinzora.in`** → `A` record to Vercel's IP (`76.76.21.21` — confirm the value Vercel shows you, it can change).
   - **`www`** → `CNAME` to `cname.vercel-dns.com`.
   - If you want customer sites on subdomains (`acme.shinzora.in`), also add the **wildcard** domain `*.shinzora.in` in Vercel and a wildcard CNAME at the registrar.
4. Wait for Vercel to show **Valid Configuration**. HTTPS is issued automatically.
5. Now update Supabase (§5.2) — Site URL and redirect URLs. Emails sent before this step will point at the wrong address.

### STEP 9 — Verify the live website

Work down this list; each line is a pass/fail you can see.

| Check | How | Pass looks like |
| --- | --- | --- |
| Home page | open `https://shinzora.in` | the real marketing page, correct fonts, images, dark/light styling |
| Config reached the browser | open `https://shinzora.in/js/config/runtime.js` | contains your Supabase URL and `SITE_URL: https://shinzora.in` |
| Redirects | open `/login`, `/signup`, `/dashboard` | land on `/auth/login/`, `/auth/signup/`, `/app/` |
| 404 | open `/this-does-not-exist` | branded "Page not found", not a Vercel error |
| Security headers | DevTools → Network → any HTML document | `x-content-type-options: nosniff`, `strict-transport-security` |
| Signup | create a test account | account created, verification email received |
| Email verification | click the link in that email | lands on `/auth/callback/` on **shinzora.in**, then the dashboard |
| Login / logout | sign in, reload, sign out | session persists across reload, ends on sign-out |
| Password reset | `/auth/forgot-password/` | email arrives, link lands on `/auth/reset-password/` |
| Dashboard | `/app/` | real data sections load; no placeholder numbers |
| Uploads | Settings → avatar | image uploads and displays |
| Admin console | `/admin-login/` with an account in `admin_users` | console opens; pages that need the undeployed `admin` function say so honestly |
| System check | `/system-check/` | reports the live provider state truthfully |
| Service worker | DevTools → Application → Service Workers | `shinzora-v16` registered, HTTPS |
| API route | `https://shinzora.in/api/prelaunch/health` | JSON with `enabled` — `false` is correct if you skipped the sandbox variables |

### STEP 10 — Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build fails at `generate-config.mjs` | env vars missing | add the variables from Step 6, redeploy (they are read at build time, so **redeploy** after adding) |
| Site loads but sign-in does nothing, console shows a wrong URL | `runtime.js` empty or wrong | open `/js/config/runtime.js`; if empty, the build did not see the env vars |
| Verification email links to `localhost:4173` | Supabase Site URL still points at localhost | set Site URL + redirect URLs (§5.2) |
| Reset link says "link expired / wrong browser" | the link was opened on a different device, or the redirect is not allow-listed | open on the same browser; add the wildcard redirect |
| `/admin/` opens but Access/Payments/Operations say "unavailable" | the `admin` Edge Function is not deployed and `0009` is not applied | that is expected until the Supabase phase; not a hosting problem |
| `/api/prelaunch/health` returns `enabled:false` | `PRELAUNCH_*` not set | expected unless you opt into the sandbox |
| Monitoring page is empty | the probe log lives in per-instance `/tmp` | expected on serverless |
| Password reset or verification email never arrives | Supabase SMTP not configured | configure custom SMTP in Supabase → Authentication → Settings |
| Google sign-in says "not enabled" | provider not configured | enable Google in Supabase + Google Cloud, add the new origin |
| A page shows old content after deploy | service worker cache | hard-reload once; `sw.js` is `no-store` so the new worker takes over |
| Custom domain shows "Invalid Configuration" | DNS not propagated or wrong record type | recheck A vs CNAME at the registrar; wait up to 24h |
| Images or CSS 404 on the live site but fine locally | case sensitivity — Vercel's filesystem is case-sensitive | match the filename exactly as in `public/` |

---

# PHASE 8 — Final report

### 1. Actual project root
`/home/user/shinzora` — repository root. The website is `public/`; the one serverless function is `api/prelaunch/[...path].js`; Edge Functions live in `supabase/functions/`.

### 2. Complete feature inventory
23 HTML pages (21 routable), 17 customer-dashboard views, 6 admin views, 6 auth screens, onboarding, PWA/offline, 69 front-end modules, 12 stylesheets, 35 database tables, 9 Edge Functions, 1 Vercel function. Full tables in §1.3.

### 3. Hosting compatibility report
Everything in `public/` is static and deploys cleanly. One serverless function is required and already present in the correct place. **Verified locally:** all 21 routes, 4 redirects, 1 rewrite, headers, cache rules, 404, and runtime-config generation. **Degraded on Vercel by design:** pre-launch sandbox durability, sandbox availability without env vars, and the admin Monitoring panel. **Dependent on Supabase state, not hosting:** the Phase 3 admin pages (`0006`–`0009` + `admin` function not yet deployed).

### 4. Security audit report
- No credentials anywhere in the tree outside `.env` (scanned for four key formats).
- `.gitignore` verified with real `git check-ignore`: `.env*`, `.backups/`, `.prelaunch/`, `node_modules/`, generated `runtime.js`, `*.zip`, `supabase/.temp/` all excluded.
- **Gap found and fixed:** certificates/private keys (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`) were not ignored. Six rules added.
- `.env.example` is committed deliberately and contains placeholders only.
- **Rotation required:** the Gemini key — it is exposure-tainted and the repository was public. Commands to check history are in §3.4. Rotate regardless; it costs nothing and removes the question.
- Publishable Supabase key: public by design, no rotation. Service-role key: not present, never needed.

### 5. GitHub preparation report
Nothing to delete; the tree is ready. Two pre-push guards are in §7 Step 2 (`git check-ignore -v .env`, and the `git ls-files` check). **I could not inspect your private remote from this environment** — confirm it matches this tree, and check its history for a previously committed `.env`.

### 6. Vercel configuration report
`vercel.json` is already correct; settings are Framework **Other**, Root Directory **blank**, Build `node scripts/generate-config.mjs`, Output `public`, Node **20+**. `api/` stays at the root. No dependencies to install. The eight environment variables (six `SHINZORA_*`, two `SUPABASE_*`) are listed in §7 Step 6 — the `SUPABASE_*` pair is newly discovered and required for admin Monitoring.

### 7. Supabase configuration requirements
Dashboard-only changes: Site URL → `https://shinzora.in`; redirect URLs with wildcards for `shinzora.in`, `www` and the vercel.app origin; Google provider origins if used; working SMTP for verification and reset emails. No migration, no schema change, nothing touched by me.

### 8. Validation and test results
`verify-deploy` 18/18 · `check` clean · `smoke` 23 routes + 4 header checks · branding 14/14 · AI errors 56/56 · admin authority 58/58 · migration-SQL 27/27 · restore 17/17 · staging 84/84 · config build verified. Browser/Deno suites not run (no Chromium/Deno here) — not counted as passes.

### 9. Known deployment risks
1. Phase 3 admin pages read as unavailable until `0006`–`0009` and the `admin` function are deployed (Supabase work, documented separately).
2. Prelaunch sandbox rows are per-instance and ephemeral on Vercel.
3. Admin Monitoring is near-empty online and needs `SUPABASE_URL` + publishable key.
4. Email verification and password reset depend on Supabase Site URL/SMTP, not on Vercel.
5. Gemini key must be rotated before it is used in production.
6. Google OAuth needs the new origin registered in two places.
7. Wildcard subdomains (`acme.shinzora.in`) need an extra domain + DNS record; without it `/site/<slug>` still works by path.

### 10. Exact deployment instructions
§7, Steps 1–10.

### 11. Remaining manual steps (yours alone)
1. Rotate the Gemini key; check Git history for a committed `.env`.
2. Push the repository (Step 2) — I will not push without your approval.
3. Create the Vercel project and set the eight environment variables.
4. Deploy.
5. Add and verify the domain at your registrar; add the wildcard if you want subdomains.
6. Update Supabase Site URL and redirect URLs.
7. Walk the Step 9 verification list and send me the result of each line.
8. Then, separately and only when you decide: the Supabase Phase 3 deployment (`docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md`) to make the admin console fully functional.

---

**Nothing in this document has been executed against GitHub, Vercel or your production Supabase project.** The only change made to the project during this review is six `.gitignore` rules for private keys.
