# Honesty report — 6 November 2026

This file exists so nothing has to be inferred. Every line states either what is
running and was checked in this environment, or what is not there yet and why.
If a feature is source-only, it says so. If a screen needs something the owner
has to do, it says that too.

The rules this pass was held to: no invented logo, no invented documentation
URL, no invented installer, no demo data presented as real, no fabricated
statistics or reviews, no "sent" message that was not handed to a provider, no
Google verification claimed on the customer's behalf.

---

## 1. Built, running, and verified in this pass

| Area | What is real | How it was checked |
| --- | --- | --- |
| Brand mark | Every brand mark on all 23 pages is generated from the supplied `uploads/logo.png` | Loaded `/`, `/docs/`, `/download/`, the six auth pages, legal pages and `/admin-login/` and read back the element source: every `.brand-mark` holds `<img src="/assets/icons/mark.png">`; no hand-drawn SVG mark remains |
| Icon set | `mark.png` 256², `icon-192`, `icon-512`, `icon-maskable-512`, `favicon-16/32`, `apple-touch-icon-180`, `desktop/assets/icon.ico` (16–256 px) | Inspected each file; maskable art sits inside the 80% safe zone; the mark stays legible at 16 px |
| Favicon / manifest | Tab icon is the official mark; manifest lists 192, 512 and a maskable 512 | Loaded a page and read `/manifest.webmanifest` |
| Contact email | `official.shinzora@proton.me` only, as a clickable `mailto:` on every page that offers contact | 34 old addresses replaced across 13 files; a full-tree search returns 0 old addresses and 20 correct ones in `public/` |
| Documentation | One in-project page at `/docs/` — 14 sections, sticky contents, every anchor resolves | Opened it, followed each anchor, compared the wording against what the code does |
| Download page | `/download/` — Browser **Available**, Windows **source build ready** with copy-paste commands, Android/iOS/macOS/Linux **Coming soon** | Opened it at 1440 px and 390 px; no download button exists on any unreleased platform; the page states outright that a PWA install is not the desktop app |
| Navigation | Documentation in the primary nav; Documentation and Applications in the footer; both linked from the install pages | Clicked through from the home page; sitemap now has 13 URLs including the two new pages |
| Desktop application source | `desktop/` — Electron main process with hardened `webPreferences`, single-instance lock, origin-locked navigation, offline page; preload exposing `window.shinzoraDesktop`; NSIS configuration (`in.shinzora.desktop`, `Shinzora-Setup-1.0.0.exe`); real multi-size Windows icon | Both source files pass `node --check`; `package.json` parses; the icon is a genuine ICO |
| Service requests (customer) | New dashboard view: reference, stage rail, target date, amount, note from Shinzora, empty state, and a submit dialog that writes a real row | Signed in and opened `?view=requests`: 2 fixture requests rendered with rails; submitting created a third; activity logged; 0 console errors |
| Track a request | Requested → Approved → In progress → Completed, with rejected/cancelled shown as terminal states instead of a rail | Rendered requests in `requested` and `in_progress` and compared the rail to the stored status |
| Communicate about a request | "Message us about this" opens the support composer with the request reference prefilled | Clicked it; the dialog opened with the subject filled and the `?subject` parameter stripped from the URL |
| Clean start | A fresh environment holds two accounts and nothing else — no sample customers, orders, payments, projects or notifications | Wiped the store, signed in, walked 13 dashboard views: onboarding is offered, every view renders a real empty state, 0 console errors, 0 HTTP 500s |
| Demo fixture isolation | Sample data exists only as `scripts/seed-demo.mjs`, which must be run deliberately and can be undone with `--empty` | Loaded it, reloaded the app, then restored the clean store and confirmed the counts |
| Migration 0006 | `supabase/migrations/0006_service_request_tracking.sql` — additive columns, backfill from existing ids, a trigger, indexes, and a separate notes table so an internal note can never be read by a customer | Reviewed against the existing schema and RLS in `0001`/`0002`; **not yet applied to the live database** (see §4) |
| Packaging | `shinzora-1.0.0.zip` — 4.37 MB, 275 entries, 23 pages, 71 JS modules, 6 migrations, 9 edge-function directories, desktop source and icons, `.env.example` | Listed the archive: no `node_modules`, no `.prelaunch`, no `.env`, no keys or certificates |

## 2. Built earlier and still intact

Accounts and auth pages, onboarding, dashboard shell with 17 views, website and
app builders, store/inventory/orders/customers, marketing, support, analytics,
notifications, billing with manual UPI verification, domains with live RDAP
availability, the admin console (overview, customers, payments, service
requests, subscriptions, projects, support, contacts, announcements, activity,
monitoring, administrator access), the pre-launch account system, 8 deployed
edge functions, RLS policies, and the deployment documentation.

Nothing in that list was rebuilt, renamed or migrated in this pass.

## 3. In the product but not verified here

| Item | Why not |
| --- | --- |
| Password reset, end to end, against the live project | Needs a real mailbox to receive the recovery link. The code paths for PKCE (`?code=`) and implicit (`#access_token=`) returns both exist, but "the link arrives, validates, expires correctly, and the new password works" cannot be proven from this sandbox |
| Email delivery of any kind | The provider credentials belong to the owner. No message was sent from here, and no screen claims one was |
| Google sign-in, Razorpay, registrar purchases, AI model output | Same reason: external accounts belong to the owner. Unconfigured paths return a clear "not configured" state rather than a fake success |

## 4. Not built, and stated as not built

1. **A Windows installer.** The Electron source, window policy, icons and NSIS
   configuration are complete, and the download page gives the exact commands.
   No `.exe` exists, and no page offers one. A Windows binary cannot be compiled
   or launched on this Linux machine, so claiming one would be false.
2. **Android, iOS, macOS and Linux packages.** Not built. The download page says
   "Coming soon" on all four with no button.
3. **Migration 0006 on the live database.** Authored, reviewed, not applied. It is
   additive and safe on existing rows, but applying it to the production project
   is the owner's action. The customer view is written to work with or without
   those columns, so nothing breaks in the meantime.
4. **Administrator assignment of a representative and a target date.** The columns
   exist in 0006 and the customer view already renders `due_at` when it is set,
   but the admin UI does not yet write them. The admin can already change status
   and leave a customer-visible note.
5. **A dedicated "Get listed on Google" workflow.** The dashboard offers Google
   listing as a service request, which creates a real tracked row with the 24-hour
   contact commitment and the 48-hour target stated as Shinzora's own goal. The
   separate multi-step flow (send form → customer submits → admin assigns → rep
   follows up) is not built. No screen claims Google will contact anyone, and no
   Google verification or approval status is ever shown.
6. ~~Database-level uniqueness for a customer reference.~~ **Done in this pass.**
   `0007_customer_reference_uniqueness.sql` adds the partial unique index, the
   reuse helper and an audit table; the payments function reuses instead of
   creating. Verified on staging (duplicates resolved without deleting a row) and
   live in the sandbox (6 simultaneous creates → 1 reference). Not yet applied to
   the live project, for the reason in item 3.
7. ~~Idempotency keys on the payment webhook.~~ **Done in this pass.**
   `0008_payment_webhook_idempotency.sql` adds the event inbox and two further
   unique keys; `_shared/webhook.ts` and the handler claim the event before acting
   on it. 18 logic assertions, plus a replay simulation that leaves exactly one
   event, one notification and one verified payment. Not yet applied to the live
   project.
8. ~~A full responsive sweep.~~ **Done in this pass.** 23 pages plus seven
   dashboard views, at 1440 / 834 / 390 px: 87 combinations, 87 screenshots, two
   real defects found and fixed (`/download/` mobile overflow, `/system-check/`
   never settling). See `docs/RESPONSIVE-REPORT.md` and `docs/RESPONSIVE-FIXES.md`.

## 5. Deliberate omissions

- No demo mode, no sample accounts beyond the two pre-launch credentials, no
  seeded analytics, no placeholder testimonials or review counts.
- No invented documentation URL — the documentation is a page in this project.
- No invented phone number, address or company registration detail.
- No PWA install described as a desktop app, anywhere.
- No AI-generated illustration: the only artwork is the supplied logo.

## 6. What the owner has to do

1. Apply `0006`, `0007` and `0008`. Either add `SUPABASE_ACCESS_TOKEN` to `.env`
   and run `node scripts/apply-migrations.mjs` (preflight → backup → apply →
   verify → receipt), or paste the three files into the SQL editor in order. The
   staging proof and the exact commands are in `docs/MIGRATION-REPORT.md`; the
   verification tool `node scripts/verify-migration.mjs` needs no credentials.
2. Build the Windows installer on a Windows machine: `cd desktop && npm install &&
   npm run dist:win`. Then, and only then, replace "source build ready" with a
   download link on `/download/`.
3. Run the eight-step mailbox checklist in `docs/PASSWORD-RESET-TEST.md`. Every
   failure path around it is already verified; the email arriving and the new
   password working are the two things this environment cannot prove.
4. Configure the email provider and confirm one payment, one service-request and
   one security message actually arrive.
