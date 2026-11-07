# SHINZORA

**Your business. Built, powered and managed with intelligence.**

Shinzora is an AI-powered business operating platform for small businesses in India. You describe the business; Shinzora
generates a website or web app, publishes it, and then runs the operational side — store, inventory, orders, customers,
marketing, support, analytics, domains and billing — from one dashboard.

It is not a landing page and not a static prototype. The dashboard reads and writes real Postgres rows behind Row Level
Security, every AI call happens server-side, and any feature that depends on an unconfigured provider says so instead of
faking a result.

---

## What is in the box

| Surface | Path | Notes |
| --- | --- | --- |
| Marketing site | `public/index.html` | Hero, product, features, builder and management showcases, how it works, pricing, FAQ, contact form, footer |
| Auth | `public/auth/*` | Login, signup, email verification, forgot password, reset password, OAuth callback |
| Onboarding | `public/onboarding/` | Five steps — personal, business, goals, preferences, plan — with autosave and resume |
| Dashboard | `public/app/` | 16 views behind a responsive shell (sidebar, mobile nav, search, profile menu, notification drawer) |
| Admin console | `public/admin/` | Separate app. Customers, payments review, service requests, subscriptions, projects, deployments, support, announcements, activity |
| Published sites | `public/site/` | `/site/?p=slug` renders a published version in a sandboxed iframe |
| Get app | `public/js/ui/install-panel.js` | Download centre: Phone / Computer → platform → the real action. Nothing is offered that a build registry does not back |
| Setup guide | `public/install-guide/` | Standalone guide — Android, iOS, Windows, macOS, Linux, PWA explanation, troubleshooting |
| Install | `public/install/` | Honest PWA install instructions per platform (linked from the guide) |
| System check | `public/system-check/` | Live deployment diagnostics: schema, RLS, RPCs, functions, providers, assets |
| Legal | `public/legal/*` | Terms, privacy, refunds, acceptable use |
| Backend | `supabase/` | Four idempotent migrations and eight Deno Edge Functions |

### Dashboard views

Overview · AI Assistant · Website Builder · App Builder · Projects · Domains · Online Store · Inventory · Orders ·
Customers · Marketing · Customer Support · Analytics · Notifications · Billing · Settings.

---

## Deploy from this repository to Vercel

This repository is a complete, buildable site. Connecting it to Vercel needs no configuration:

| Setting | Value |
| --- | --- |
| Framework preset | **Other** |
| Install command | `npm install` (the site has no runtime dependencies; this only prepares scripts) |
| Build command | `node scripts/generate-config.mjs` |
| Output directory | `public` |
| Node version | 20.x |

`public/js/config/runtime.js` is committed with the project URL and the **publishable** key — both
public by design, and protected by Row Level Security. That is why a fresh clone deploys and works
immediately. Any environment variable you add in Vercel overrides the committed value at build time
(`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SITE_URL`, `SUPPORT_EMAIL`).

Two things Vercel does **not** do, and no setting will change that:

- **The database.** Migrations are applied with `node scripts/apply-migrations.mjs` (needs
  `SUPABASE_ACCESS_TOKEN`), not by the frontend host.
- **The Edge Functions.** `supabase/functions/*` are deployed with
  `npx supabase functions deploy <name> --project-ref <ref>` or `node scripts/deploy-functions.mjs`.

A deployment that serves the site but skips those two steps renders pages that cannot read data, and
`/system-check/` will say so on the page instead of hiding it.

---

## Stack

- **Frontend** — HTML5, CSS3, vanilla JavaScript as native ES modules. No framework, no bundler, no CDN, no
transpiler — the only build step is writing the public runtime config (`npm run build`). Lucide-style
  icons are inlined as SVG (`public/js/lib/icons.js`); Supabase JS and a QR encoder are vendored under `public/js/vendor/`.
- **Backend** — Supabase: Postgres with RLS, Auth (email + Google), Storage, Realtime and Edge Functions.
- **AI** — Google Gemini, called only from the `ai` Edge Function. `GEMINI_API_KEY` never reaches the browser.
- **Hosting** — Vercel for the static frontend (`vercel.json`), GitHub for repository pushes, Vercel for deployments.
- **Payments** — manual UPI QR with administrator verification first; Razorpay order + signed webhook architecture is in
  place and activates when keys are configured.

---

## Project structure

```
shinzora/
├─ public/                     # the deployable frontend root
│  ├─ index.html               # marketing site
│  ├─ auth/                    # 6 auth surfaces
│  ├─ onboarding/              # 5-step wizard
│  ├─ app/                     # dashboard shell
│  ├─ admin/                   # admin console shell
│  ├─ site/                    # published-site renderer
│  ├─ install-guide/           # setup guide (own tab, never inside the modal)
│  ├─ downloads/               # build registry — the only source of download links
│  ├─ install/  system-check/  legal/
│  ├─ css/                     # tokens, components, marketing, auth, app, onboarding, views, admin, legal
│  ├─ js/
│  │  ├─ boot/                 # page entry modules (one per surface)
│  │  ├─ config/env.js         # public config + plan catalogue
│  │  ├─ lib/                  # icons, dom, format, validate, supabase, api, store, guard
│  │  ├─ ui/                   # toast, modal, reveal, form, pwa
│  │  ├─ modules/
│  │  │  ├─ auth/              # auth-service
│  │  │  ├─ dashboard/         # data, components, shell, router, builder-core, views/*
│  │  │  └─ admin/             # api, shell, views/*
│  │  └─ vendor/               # supabase-js, qrcode
│  ├─ assets/                  # icons, fonts, photographs, logo
│  ├─ manifest.webmanifest  sw.js  404.html  offline.html
├─ supabase/
│  ├─ migrations/              # 0001 schema → 0002 functions + RLS → 0003 storage/realtime → 0004 admin → 0005 compat
│  ├─ functions/               # ai, config, sites, domains, payments, payments-webhook, integrations, admin
│  └─ config.toml
├─ scripts/                    # dev-server, generate-config, check, smoke, package
├─ docs/                       # architecture, database, deployment, testing, security, API
├─ tests/                      # automated and manual test notes
├─ vercel.json  package.json  .env.example  .gitignore
```

---

## Quick start (local)

```bash
git clone <your-repo> shinzora && cd shinzora
cp .env.example .env            # fill SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
npm run dev                     # http://localhost:4173
```

`scripts/dev-server.mjs` serves `public/`, resolves clean URLs like Vercel, sets security headers and writes
`/js/config/runtime.js` from the environment on each request — including the correct `SITE_URL` when the page is reached
through a proxy (`X-Forwarded-Host`), so auth redirects point at the host you are actually using.

The dev server is intentionally embeddable (`frame-ancestors *`, no `X-Frame-Options`) because hosted previews and
screenshot tools frame the page from another origin.

Any other static host needs the same file written once before the site will authenticate:

```bash
npm run build        # writes public/js/config/runtime.js from .env / the platform env
```

Pages load `/js/config/runtime.js` and nothing else. The dev server generates it per request, so a mistake in that path
is invisible locally — `npm run check` now pins the page, the build script and the dev server to the same URL, and
`docs/TESTING.md` §7 shows how to verify a plain static build. Production does not inherit this: `vercel.json` keeps framing
restricted. To reproduce production behaviour locally, run `node scripts/dev-server.mjs --strict-frames`.

Verification commands:

```bash
npm run check          # parse + import graph + asset references + secret scan + CSS cascade order
npm run test:unit      # behavioural unit tests (branding contract) — no browser needed
npm test               # check + unit tests + route/header smoke test against a throwaway server

# database (needs the Postgres connection string — see docs/DEPLOYMENT.md §1)
npm run migrate:dry    # snapshot + plan, changes nothing
npm run migrate        # apply, then prove no rows were lost

# deployment and Edge Functions
npm run verify:deploy  # serves public/ through vercel.json's rules
npm run test:fn-unit   # 19 Gemini client tests (deno, no key, no network)
npm run test:functions # boots all 8 Edge Functions and checks their contract
npm run deploy:functions        # deploys all 8 (token + --use-api, no Docker)
npm run deploy:functions:dry    # prints the plan; public/JWT flags included
npm run test:functions:remote   # checks the *deployed* functions from outside

# browser suites (need `npm run dev` in another terminal)
npm run test:browser   # 48 public-flow checks
npm run test:layout    # 17 routes × 3 widths
npm run test:visual    # hero, header, get app + guide render checks
npm run test:install   # 96 download-centre + setup-guide checks
npm run test:shell     # 20 signed-in shell checks
npm run test:admin     # 29 admin console checks
npm run gallery        # rebuilds preview/gallery.html from the running site
```

### Database

The project was built without database credentials, so migrations ship as ordered `.sql` files to run in the Supabase
SQL editor:

```
supabase/migrations/0001_schema.sql          tables, indexes, triggers
supabase/migrations/0002_functions_rls.sql   is_admin, quota, activity log, payment guard, RLS
supabase/migrations/0003_storage_realtime.sql buckets, storage policies, realtime publication
supabase/migrations/0004_admin_bootstrap.sql the FIRST administrator (edit the email first)
supabase/migrations/0005_schema_compat.sql   reconciles a database that already had the early tables
```

All four are idempotent — re-running them is safe.

### Edge Functions

```bash
supabase functions deploy config            --no-verify-jwt
supabase functions deploy site              --no-verify-jwt
supabase functions deploy payments-webhook  --no-verify-jwt
supabase functions deploy ai
supabase functions deploy domains
supabase functions deploy payments
supabase functions deploy integrations
supabase functions deploy admin
```

Full secrets list, OAuth setup and provider-by-provider steps: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## Design language

Glossy black through deep charcoal into violet ink, with lavender highlights and white typography. Atmospheric purple
lighting is a **flame aurora**: five flowing violet ribbons painted on a canvas (`public/js/ui/aurora.js`) and blurred by
CSS into luminous haze, with a shape-less radial wash underneath so the page still has depth with JavaScript disabled or
reduced motion enabled. It replaced the earlier floating particles, glass orbs and light trails entirely — there are no
dots, bubbles or circles left in the background. Glass is used only on chrome that floats over content (topbar,
notification drawer, modal). No emoji anywhere — every icon is an inline Lucide-style SVG. The wordmark is text, letter-spaced, next
to the original hexagonal mark.

Type is Inter (variable) with Instrument Serif italic for emphasis. All colour, spacing, radius, shadow and motion values
are tokens in `public/css/tokens.css`; no stylesheet invents its own scale.

---

## Brand assets

The product ships with a hand-built SVG mark (`public/assets/icons/favicon.svg`, inlined in every page header) so it
renders with zero requests. When the official `logo.png` is supplied, one command applies it everywhere:

```bash
npm run brand          # ingest logo.png → icons, PWA sizes, CSS, page links
npm run brand:check    # report what is currently in place
npm run brand:revert   # restore the SVG mark and the original icons
```

`scripts/brand.mjs` reads `logo.png` from the repository root, `public/assets/brand/`, or the parent directory; writes
favicon 16/32, apple-touch 180, PWA 192/512 and 64/128 display sizes; writes `public/css/brand.css`, which swaps the SVG
for the image; and links that stylesheet into every page. Each derivative is letterboxed onto a transparent square with
a safety margin, so the aspect ratio is preserved — the logo is never stretched, cropped or redrawn. The shipped icons
are backed up to `public/assets/icons/_original/` on the first run, which is what `--revert` restores.

PNG decoding uses a small built-in codec rather than a dependency: the project has no build chain and should not grow
one for this. 8-bit RGB/RGBA/greyscale/palette, non-interlaced — anything else fails with an instruction instead of
writing a broken icon.

---

## Pre-launch accounts

Two accounts sign in on the normal `/auth/login/` page and are verified by this
deployment rather than by Supabase Auth:

| Account | Identifier | Lands on |
| --- | --- | --- |
| Pre-launch tester | `business@business.com` | `/app/` |
| Administrator | `Shinzora@admin` | `/admin/` |

```bash
node scripts/prelaunch-credentials.mjs --init \
  --user 'business@business.com' --user-password '<the tester password>' \
  --admin 'Shinzora@admin'      --admin-password '<the admin password>'
```

Passwords are stored only as scrypt digests in `.env`; nothing about them reaches
the browser. Full detail — including monitoring, data separation, the AI key and
the Vercel function — is in [`docs/PRELAUNCH-ACCOUNTS.md`](docs/PRELAUNCH-ACCOUNTS.md).

## Honesty rules the code actually enforces

These are product rules, implemented rather than promised:

- **No fake downloads.** The Get app panel renders a Download button for a platform only when
  `public/downloads/manifest.json` lists that build *and* the file answers a `HEAD` request. A listed-but-missing
  file is reported as unavailable, never linked. Progress is measured from the streamed response body; where a native
  package is not published the panel shows the supported browser-install route and says exactly that — no APK, IPA,
  DMG or EXE is ever offered as a placeholder. The setup guide opens in its own tab.
- **No fake states.** Domain availability and prices appear only when a registrar is connected; AI output only when
  `GEMINI_API_KEY` is set; deployment success only when Vercel returns `READY`; a GitHub push only when a commit SHA comes
  back.
- **No fabricated social proof.** There are no invented reviews, testimonials, customer logos or statistics on the
  marketing site, and generated sites are instructed never to invent them.
- **Payments.** Creating a payment records `pending`. Submitting a UTR moves it to `awaiting_verification`. Only an
  administrator approval or a signature-verified Razorpay webhook can set `verified` — enforced by a Postgres trigger and
  by the absence of any client write policy on `payments`. Closing a window changes nothing.
- **AI is server-side.** The browser calls an Edge Function; keys live in function secrets. A missing key returns
  `functions_unavailable` with the exact fix, and the builder shows a setup notice.
- **Generated code never runs in the app's context.** Previews and published sites render in
  `<iframe sandbox="allow-scripts allow-forms allow-popups">` — no `allow-same-origin` — with CSS/JS inlined and a CSP of
  `base-uri 'none'; form-action 'none'`.
- **No administrator self-promotion.** `admin_users` has RLS enabled with no client write policy; `is_admin()` is a
  `SECURITY DEFINER` function; the admin Edge Function re-checks the role on every call. The administrator doorway lives
  at `/admin-login` (its own page, outside the customer sign-in); a correct password on an account without the role ends
  the session instead of proceeding, and `/admin/` re-runs the same check.

---

## Verified vs. awaiting credentials

Recorded honestly, because an untested feature is not a working feature.

| Area | Status |
| --- | --- |
| Static integrity (`npm run check`), route + header smoke (`npm test`) | **Verified** — passing in this build |
| Unit tests (`npm run test:unit`) — published-site branding per plan | **Verified** — 14 assertions, no browser required |
| `0005_schema_compat.sql` against a PostgreSQL 17 replica of the legacy production schema | **Verified** — data preserved, constraint set identical to a clean install |
| Schema-compatibility probes in `/system-check/` | **Verified** against the live project (correctly reports the four legacy defects) |
| Marketing, auth, onboarding, dashboard, admin, site, install, system-check, legal pages render | **Verified** in a headless browser at 1440 px and 390 px, no console errors |
| Auth guard on `/app/` and `/admin/` | **Verified** — redirects to login; a signed-in non-admin is refused with an explicit message |
| Pre-launch accounts (`business@business.com`, `Shinzora@admin`) | **Verified** — server-verified sign-in on `/auth/login/`, full `/app/` workspace for the tester, full `/admin/` console for the administrator, tenant isolation and admin-only authorisation checked in a headless browser |
| Pre-launch AI chat | **Verified end to end against a local test double** — request shaped, response parsed, conversation and credit counter updated. The real Gemini call activates when `SHINZORA_AI_API_KEY` is set; until then the assistant is disabled and names the missing variable |
| Marketing contact form → `contact_messages` | Verified path, requires the migration to have run |
| Signup / login / email verification / password reset / Google | Implemented against Supabase Auth. **Needs a live project with the migration applied and redirect URLs configured** |
| AI chat and site generation | Implemented; returns `functions_unavailable` until `GEMINI_API_KEY` is set |
| Payments (UPI QR + proof + admin approval + Razorpay webhook) | Implemented; QR requires `UPI_ID`, Razorpay requires keys |
| Domains | Implemented; returns "registrar not connected" until a provider is configured |
| GitHub / Vercel | Implemented; disabled with an explanation until credentials are set |
| Full end-to-end walkthrough with a real session | **Not executed** — no credentials were available in this environment |

The `system-check` page turns that table into something measurable in your own deployment: open `/system-check/` after
configuring everything and it will list what is still missing.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module graph, data flow, rendering and sandboxing
- [`docs/DATABASE.md`](docs/DATABASE.md) — every table, policy, trigger and RPC
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Supabase, secrets, OAuth, Vercel, DNS, Razorpay
- [`docs/TESTING.md`](docs/TESTING.md) — automated checks and the manual walkthrough checklist
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model and the controls that answer it
- [`docs/API.md`](docs/API.md) — Edge Function request/response contracts and error codes
- [`docs/PRELAUNCH-ACCOUNTS.md`](docs/PRELAUNCH-ACCOUNTS.md) — the two pre-launch accounts, monitoring, data separation and the Vercel API

---

## Licence

Proprietary. All rights reserved. Branding, copy and code are original to this project.

### Pre-launch accounts and the demo fixture

The application starts clean: two accounts, no customers, no orders, no
payments. Everything the tester creates is real data in `.prelaunch/`,
never sample rows.

```bash
node scripts/seed-demo.mjs --status   # what is in the store right now
node scripts/seed-demo.mjs            # load the developer fixture (tests use this)
node scripts/seed-demo.mjs --empty    # restore the clean store
```

The fixture is developer tooling. It is not shipped to customers and it holds
no customer data. The browser suites in `scripts/` expect it to be loaded.

### Verification scripts

| Script | What it proves |
| --- | --- |
| `node scripts/check.mjs` | Static integrity: module graph, CSS references, page wiring |
| `node scripts/staging-db.mjs` | The migrations apply, preserve data and enforce their constraints — against real PostgreSQL, using rows that look like production |
| `node scripts/verify-migration.mjs` | Whether the live project has the objects the migrations add (publishable key only) |
| `node scripts/db-backup.mjs` | A backup that reads back with matching hashes, or a failure |
| `node scripts/apply-migrations.mjs` | Preflight → backup → apply → verify → receipt (needs `SUPABASE_ACCESS_TOKEN`) |
| `node scripts/responsive-audit.mjs` | Every page at 1440/834/390 px: overflow, offending elements, tap targets, console errors, screenshots |
| `node scripts/responsive-audit.mjs --no-shots` | The same measurements without writing images |
