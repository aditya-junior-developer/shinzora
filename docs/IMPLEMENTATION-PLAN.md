# SHINZORA — platform upgrade plan

Written after inspecting the codebase on 7 November 2026, before changing
anything. Everything below is based on what is actually in the repository, with
the file that proves it. Where a claim could not be verified, it says so.

---

## 1. How the platform is built today

| Layer | Reality |
| --- | --- |
| Frontend | Vanilla ES modules, **no build step, no framework**. 23 HTML pages, 71 JS modules, 12 stylesheets, served as written. `scripts/check.mjs` validates the module graph, CSS references and page wiring (68 modules, 23 pages). |
| Data access | One Supabase client (`public/js/lib/supabase.js`), storage key `shinzora.auth`, auth flow `pkce`. Every view reads and writes through `sb.from(...)` / `sb.rpc(...)`; there is exactly one data layer (`modules/dashboard/data.js`). |
| Backend | Two interchangeable paths behind the same client: **(a)** Supabase with Row Level Security, **(b)** a local pre-launch sandbox (`server/prelaunch/`, file-backed) that mirrors PostgREST and the edge functions so the same frontend runs with no database. `prelaunch.prelaunchFetch` decides per request. |
| Edge functions | 8: `admin`, `ai`, `config`, `domains`, `integrations`, `payments`, `payments-webhook`, `site`, plus `_shared/` (auth, gemini, http, prompts, webhook). |
| Database | 8 migrations, ~30 tables, RLS on every table, `is_admin()`, `admin_role()`, `handle_new_user()`, `consume_ai_credit()`, `log_activity()`. Buckets: `avatars`, `brand-assets`, `payment-proofs`. |
| Payments | Manual UPI only (your instruction): proof upload → admin review → verified. No gateway in the product; `payments-webhook` exists for future use and is idempotent. |
| Delivery | `scripts/package.mjs` → `shinzora-1.0.0.zip`, 23 pages / 71 modules / 12 stylesheets / 8 migrations / 9 edge-function dirs, no secrets. `vercel.json` + `api/prelaunch/[...path].js` for the pre-launch API on Vercel. |

**Live database state (measured, not assumed):** `node scripts/verify-migration.mjs`
reports migrations **0006, 0007 and 0008 are not applied**. The project is at the
`0001`–`0005` baseline. No `SUPABASE_ACCESS_TOKEN` exists in this environment, so
I cannot apply them; they are staging-proven (57 checks, 0 failed).

---

## 2. What already works — do not rebuild this

Verified in this and recent sessions, with the run behind each claim:

| Capability | Evidence |
| --- | --- |
| Public site, responsive everywhere | 87 page/viewport combinations, 0 issues (`docs/RESPONSIVE-REPORT.md`, 87 JPEGs) |
| Header layout after the seventh link | 13 widths 1600→390 px, 72/72 checks |
| Auth: sign-up, sign-in, verify, forgot, reset, callback | reset paths 12/12 checks; callback copy fixed and re-tested this week |
| Admin console shell + 10 views | gate, RBAC via `is_admin()` / `admin_role()`, real queries |
| Manual UPI payments with proof upload and admin review | `payments` function, `payment-proofs` bucket |
| Service requests, with tracking fields | migration 0006 + dashboards |
| Payment idempotency (webhook side) | 18/18 assertions + staging replay |
| Customer reference uniqueness | 6-way concurrent burst → 1 row, 5 `reused:true` |
| Builder engine: brief → generate → versions → publish to `/site/` | `builder-core.js`, 730 lines, sandboxed iframe |
| PWA | `manifest.webmanifest`, `sw.js` (v15), `ui/pwa.js`, `ui/install-panel.js` (751 lines), `/install/`, `/install-guide/` |
| Static + integrity + packaging scripts | `check.mjs`, `package.mjs`, responsive sweep, staging harness |

The platform is a real product with real database operations. The work below is
extension and repair, not replacement.

---

## 3. Gap analysis, mapped to your parts

Status: **works** · **partial** · **missing** · **blocked** (needs a credential)

### Admin (Part 3)

| Part | State | What is actually missing |
| --- | --- | --- |
| 3.1 Payment management | mostly works | List, status tabs (`Awaiting verification` / `Not paid` / `Verified` / `Rejected · failed` / `All`), detail modal and approve/reject all exist and are real (`admin:payments`, `payment_review`). Missing: **delete** with a soft-delete + audit path, and free-text search. Legally significant rows must never be hard-deleted — see §6. |
| 3.2 Subscriptions | partial | `subscription_update` exists. No AI-credit reset action, no credit-score (see §6 — **no such column exists anywhere**), no subscription history table. |
| 3.3 Service requests | works | Keep as is; it just needs 0006 applied live. |
| 3.4 Support tickets | partial | `ticket_reply` + `ticket_status` exist. No archive/delete of resolved tickets. |
| 3.5 Contact messages | partial | `contact_update` exists. No delete, no owner-directed reply. |
| 3.6 Announcements | partial | `announcement_create` exists. No edit, no delete, no publish/unpublish split. |
| 3.7 Activity stream | partial | `customer_activity` + monitor exist. No filter/search/delete. Business events are not all logged — website generation, app generation, subscription changes and admin actions are missing `log_activity()` calls. |
| 3.8 Monitoring | partial (repaired this week) | Fixed: accepts a verified Supabase admin token, RLS-checked. Still only served by the pre-launch router — a Supabase-only deployment gets 404. Probe set is thin: no storage/auth/AI/compile probes yet. |
| 3.9 User + admin listing | **broken by design** | `admin_users` has exactly one policy: *select your own row*. That is why you only ever see yourself. Needs a deliberate fix (§7), not a frontend patch. |
| 3.10 Permission hierarchy | partial | `role` column already stores `admin` / `superadmin`, and `is_admin()` understands both. Missing: promote/demote functions, a protected-owner safeguard, last-superadmin protection, and any UI. |

### User dashboard (Parts 4, 10–18)

| Part | State | Notes |
| --- | --- | --- |
| 4.1 AI documents/images | **missing** | The assistant is chat only. No PDF generation, no image generation, no file outputs. `ai` function has `chat`/`generate`/`revise`/`copy`/`domain_ideas`/`support_reply` — no document or image action. |
| 4.2/5 Website builder | partial → the main work | Single-shot generation, 4 trace steps (not your 5), no consultation, no questions, no approval gate, `framework: "html"` only, no assets, no images. |
| 4.3/9 App builder | partial | Same engine as websites (`TYPES.app`), so it inherits every gap. No thumbnails, no logos, no asset upload. |
| 10 Store | partial | `store_products.image_url` exists and is **never used** — there is no product image upload anywhere. Only the avatar has an upload control in the whole app. |
| 11 Inventory | partial | Add/edit/delete, stock and search exist (`inventory.js` deletes via `store_products`). Missing: no stock-change history, no filter-by-status, and product images (see 10). |
| 12 Orders | works | Preserve. |
| 13 Customers | works | Preserve. |
| 14 Marketing | **missing** | Campaign records and an AI plan. Zero OAuth, zero connections, no gating. `integrations` / `integration_tokens` tables exist but are unused. |
| 15 Analytics | partial | Reads real tables; needs a pass to confirm every figure is derived, not defaulted. |
| 16 Notifications | partial | Read + mark-all work. No delete. |
| 17 Billing | partial | Views exist; no deletion of eligible requests. |
| 18.1 Profile photo | partial | A bare `<input type="file">`. No click-the-avatar menu, no remove, no preview, no cropping. |
| 18.2 Business logo | **missing** | Nothing in the Business section uploads a logo, though a `brand-assets` bucket already exists for it. |
| 18.3 Password change | **unsafe** | `sb.auth.updateUser({ password })` is called **without re-authentication** — an unlocked laptop is enough to change the password. Must verify the current password or go through email first. |
| 19 PWA / Get App | works | Audit against your Android/iOS/Windows/macOS list; no rebuild needed. |
| 20 Design system | works | Refine only. |

### Builder, compiler, preview (Parts 5, 6)

What the code does today (`modules/dashboard/builder-core.js`, `supabase/functions/ai/index.ts`):

1. One textarea + page checkboxes + style field → one AI call → a `files` map of
   HTML/CSS/JS strings → stored as a `project_versions` row → rendered in a
   sandboxed iframe (`allow-scripts allow-forms allow-popups`, **no**
   `allow-same-origin`).
2. `buildPreviewDocument()` inlines `<link>`/`<script>` by **regex**, keyed on the
   file path. Anything else — `srcset`, background images, fonts, ES imports,
   relative navigation between pages — stays broken, which is why richer
   generations preview badly or blank.
3. **No compiler.** Nothing parses the generated HTML/CSS/JS, nothing reports
   errors, nothing repairs them. A syntax error produces a blank iframe.
4. Download is a `.txt` dump of concatenated files, not a project.
5. `generate` is not available in the local sandbox at all — it answers `501
   not_available_prelaunch` (`server/prelaunch/functions.mjs:877`).

So "the preview does not work" is accurate, and the cause is architectural, not
cosmetic. The plan replaces the inlining regex with a real compile step and adds
diagnostics + repair, while keeping the iframe sandbox.

---

## 4. Hard dependencies — what I cannot do without you

These are not preferences; without them the corresponding parts cannot be built
honestly.

| # | Dependency | Blocks | Without it |
| --- | --- | --- | --- |
| D1 | **AI provider key** — *supplied 7 Nov, valid* | Parts 4.1, 5, 6, 7, 9 | Key works, but it is on the **free tier: 20 text requests/day**, so a day of real iteration is a handful of generations. Measured, not assumed — `docs/AI-PROVIDER.md`. |
| D2 | **Image generation access** | 4.1 image assets, 4.2 site imagery, 4.3/9 logos and thumbnails | Measured: the image model returns 429 with **free-tier limit 0**. Needs billing enabled on the provider project. Until then those surfaces stay honestly disabled. |
| D3 | `SUPABASE_ACCESS_TOKEN` **or** you pasting SQL | Applying 0006–0008 and every new migration (0009+) | All DB-level work stays proven on staging only. |
| D4 | Edge-function deployment (`supabase` CLI + token) | Making `ai`, `admin`, `payments`, `site` changes live | Code exists in the repo, live behaviour unchanged. |
| D5 | Meta / Google / email provider app credentials + redirect URIs | Part 14 connections | I build the OAuth flow and status model; every channel stays "not connected" until you register the apps. I will not fake a connection. |
| D6 | A real mailbox | Password-reset proof (P2, still open) | UI half is proven; delivery half is not. |

Anything not on this list I can build and verify in this environment.

---

## 5. Phased plan

Each phase ends with a verification run and a written result — the same standard
as this week: no "done" without a test behind it.

### Phase 3 — Admin panel (first, as you ordered)

1. **Migration 0009 — administration and audit** (staging first):
   - `admin_users` read policy for administrators, plus `admin_list()` and
     `admin_directory()` security-definer functions returning safe columns only.
   - `promote_admin()` / `demote_admin()`: superadmin-only, cannot touch the
     protected owner, cannot remove the last superadmin, cannot self-escalate.
   - `payments.deleted_at` + `payment_audit` (who, when, why, before-state).
   - `subscription_events` (plan/status/credit changes with actor + reason).
   - `inventory_movements` (stock deltas with reason and actor).
   - `tickets.archived_at`, `contact_messages.archived_at`, `announcements.deleted_at`.
2. Admin views: status filters and detail panes for payments; delete with
   confirmation → soft delete + audit; subscription editor with plan, status,
   credits, and history; ticket archive; contact reply/archive; announcement
   edit/publish/delete; activity filter/search/delete; user directory split into
   Administrators / Super administrators / Users with promote/demote.
3. Monitoring: real probes only — database reachability and latency, edge-function
   reachability, storage read, auth endpoint, last generation outcome, last
   compile failure. Every figure timestamped and labelled with its source.
4. Event coverage: `log_activity()` at registration, sign-in, project creation,
   website/app generation, subscription change, payment events, admin actions,
   ticket updates.

**Verify:** staging SQL checks for every new function and policy, including
attempted privilege escalation as an `authenticated` non-admin and as an `admin`
trying to become `superadmin`; browser run of every admin action against a
pre-launch admin; 403/404/200 states.

### Phase 4 — User dashboard

Profile (click-avatar menu with exactly two options, remove, validated upload,
database sync), business logo via `brand-assets`, **password re-authentication**,
notification delete, billing request deletion with confirmation, store product
images, inventory delete + movement history, analytics verification.

**Verify:** browser flows for each, storage objects inspected, DB rows compared
before/after, destructive actions confirmed as refusing unauthorised users.

### Phase 5 — AI website builder (the centrepiece)

- **Consultation engine:** brief → AI extracts business, audience, purpose,
  actions, differentiators → *only relevant* follow-up questions → proposed plan
  (concept, visual direction, pages, sections, features, assets, backend,
  architecture) → **explicit approval** → generation. No generation before
  approval, enforced in code (the generate call refuses without a plan id).
- **Design intelligence:** per-industry design briefs (fashion, SaaS, restaurant,
  studio, retail, clinic, portfolio…), typography and palette systems, layout
  archetypes chosen by content type, motion presets by intensity, 3D/WebGL only
  where the brief justifies it. Different industries must produce structurally
  different sites — asserted in tests, not asserted in prose.
- **Assets:** real imagery through D2, deterministic SVG/CSS art as fallback,
  fonts with proper fallbacks, uploads via `brand-assets`.
- **Five visible stages** in the UI, each with real status; a stage cannot say
  "done" unless its operation succeeded.

**Verify:** three briefs from three industries generated end to end; structural
diff between outputs; asset HTTP checks; approval gate refuses early generation.

### Phase 6 — Compiler and live preview

- **Compile step:** project file tree → resolve HTML/CSS/JS, inline assets as data
  URIs, resolve ES modules, detect missing references, parse findings, produce a
  single self-contained document **plus a diagnostics list** (file, line, kind).
- **Syntax validation:** JS and CSS are parsed inside a throwaway sandboxed iframe
  that reports `error` + line back to the parent — the untrusted code never runs in
  the app's context.
- **Auto-repair loop:** diagnostics → AI repair → recompile, max 2 rounds, real
  status shown, never "compiled" on failure.
- **Preview:** desktop/tablet/mobile viewports, refresh, full screen, loading and
  error states, automatic re-render on version change, console/jserror capture
  from inside the sandbox.
- **Visual checks:** render the compiled document at three widths inside the
  sandbox, detect horizontal overflow, zero-height sections, broken images,
  unreachable controls.

**Verify:** deliberately broken projects fail with the real error shown; a repair
round succeeds; overflow injected on purpose is caught; three viewport switches
screenshot-compared.

### Phase 7 — App builder

Same pipeline for applications: screens, data model, state, validation, forms,
persistence layer (local for prototype, Supabase for real backend), plus generated
logo/thumbnail or user upload, project management and reopen.

### Phase 8 — PWA and responsiveness

Audit Get App against Android/iOS/Windows/macOS/Chromium reality, install prompt,
iOS guidance, offline fallback, update handling, honest per-platform claims. Re-run
the 87-combination sweep plus the new builder screens.

### Phase 9 — Testing

Extend `tests/` with the new surfaces; every phase's checks re-run together; report
in `TESTING-REPORT.md` with counts, not adjectives.

### Phase 10 — Deployment package

Refresh `package.mjs`, README, deployment docs, `.env.example`, migrations, and a
single unambiguous archive.

**Sequence note:** Phase 3 first because admin authority is what makes 3.9/3.10 and
every audited destructive action safe. Phase 5 depends on D1, so if the key arrives
late I will build Phases 3, 4, 6's compiler skeleton, 8 and the non-AI halves of 5
first, and wire generation the moment the key exists.

---

## 6. Decisions I need from you

1. **Credit score (3.2).** There is no credit score anywhere in the schema or code.
   Do you mean (a) add a real `credit_score` field to profiles, (b) reset AI credit
   usage, or (c) drop it?
2. **Payment deletion (3.1).** My proposal: verified/successful payments are never
   deleted — they are voided with a reason and kept for audit. Rejected/failed rows
   can be soft-deleted (hidden everywhere, recoverable). Hard delete only for rows
   that never reached a money state. Confirm or change.
3. **Admin visibility (3.9).** Proposal: administrators may read the admin list and
   the user directory through a security-definer function returning safe columns
   (no emails beyond what the panel already shows, no tokens). Alternative: a
   table policy. The function is tighter; say if you prefer the policy.

## 7. What I will not do, even if it makes a demo look better

- Generate a website without approval, or claim a stage passed when it failed.
- Show uptime, analytics, activity or "connected" states that no real query
  produced.
- Substitute a template for generation and call it AI.
- Hard-delete a payment with financial significance.
- Let a frontend permission stand in for a database one.

## 8. Immediate next step

Phase 3, starting with migration 0009 written and staging-proven, then the admin
views on top of it. D1 (AI key) is the only dependency that changes the ordering —
everything else above can proceed now.
