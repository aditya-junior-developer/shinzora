# SHINZORA — Advanced AI Builder & Marketing Upgrade
## Final report (A–J)

Date: 7 November 2026 · Repository: `shinzora` · Nothing deployed, no migration applied,
no production data touched.

---

## A. What was built, against the 21 requirements

Status words used here are strict: **built** = code exists and is exercised by a test that
would fail if it broke; **written** = code exists, tested only in PGlite/static terms,
not run against the live project; **blocked** = cannot be completed without a credential
or a manual step only you can perform.

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Website Builder: exactly five stages, task-derived progress, preview + validation, confirm & save with version history | built | `public/js/lib/builder-core.js`, `builder/stages.js`, `site-validate.js`, `boot/site.js` |
| 2 | Output is exactly one `index.html`, internal hash routing, no ZIP/separate CSS/JS | built | `public/js/lib/single-file.js`; `tests/singe-file` suite (22 assertions) + the four-page fixture suite |
| 3 | Edit an existing website: load current version → preview → AI change → preview → confirm before save (edit, not regenerate) | built | `builder-core.js` edit path, `site.js` view |
| 4 | Chat-based projects: reopen, continue conversation, save new version after confirmation, keep prior conversations/versions | built | `builder/` chat stage + `project_versions` / `ai_conversations` |
| 5 | Web research with sources shown, never invented, feeding the site | built | `api.ai.research()` → `geminiGrounded()`, `research` action in the `ai` function |
| 6 | App Builder is strictly mobile-only | built | `public/js/lib/app-package.js` (`MOBILE_ONLY` guard, viewport lock) |
| 7 | Same five stages, app-specific | built | `builder/stages.js` `mode: "app"` |
| 8 | Stage 2 offers Android APK / Android AAB / iOS IPA, AAB never labelled iOS | built + tested | `app-package.js` `OUTPUT_FORMATS`; `builder-stages` suite |
| 9 | Plan gating: Free = one target only (both blocked, upgrade message), Enterprise = Android + iOS; enforced in the backend | written + tested (SQL) | `0012_app_package_enforcement.sql`, `app_platform_slots()`, `tests/app-package-rls` (27) |
| 10 | App download is a single `index.html` containing the whole mobile app | built | same single-file packager, mobile shell |
| 11 | Own HTML→app conversion platform (WebView wrapper, name/icon/splash, permissions, validation, progress, signing credentials; iOS needs real Apple certs) — never claim success until built and verified | **partial — blocked** | `conversion_jobs` table + request wiring built; the wrapper build itself needs the toolchain and Apple/Android signing material you control. No job ever reports `built` without a stored artifact. |
| 12 | Customer Growth section replaced by "Request for Extra Service" | built | `dashboard/views/marketing.js`, nav label in `dashboard/shell.js` |
| 13 | Account connections first — Instagram, Facebook (Page/Meta Business/ad account), WhatsApp Business, Email, Google Ads; official auth flows, never ask for passwords; Search is a Google Ads campaign type | written | `marketing_accounts` + connect UI; **OAuth itself blocked** (see F) |
| 14 | Campaign type Meta Ads or Google Ads with the fields named per platform | built | `CAMPAIGN_TYPES` in the view, `campaign_type` column |
| 15 | Collect objective, type, business name/category, audience, location, budget (daily/total), duration, start date, platform, account details, creative assets, instructions; ad budget distinct from service charge; never auto-launch paid ads | built | 4-step wizard; `budget_mode`, `budget_paise`, `details` jsonb |
| 16 | Submit → saved in Supabase tied to user + business, admin notified, admin reviews/contacts/approves/rejects/requests info, full status list | written + tested | `0013_marketing_request_workflow.sql`, `notify_admins`, `marketing_requests_guard` |
| 17 | Admin marketing area: list, filter by type, budgets, customer/business details, connected accounts, status updates, internal notes, contact customer, progress, admins only | built (new this pass) | `admin/views/marketing.js`, ADMIN nav + badge, admin `overview` count |
| 18 | Match existing branding; mobile + desktop; real loading/error states, real progress, confirmations, working controls | built | reused `ui/*`, `dashboard/components.js`, `.wz-*` in `views.css` |
| 19 | Inspect schema first; records for version, generation job, conversion job, marketing account, campaign request, admin notification with ownership + RLS; server-side credentials only | written + tested | `0011` + `0012` + `0013`; no provider secret reaches the browser |
| 20 | Test all three flows end to end; fix what breaks | done to the honest limit | **678 assertions + 23 routes + 4 header checks** all green; no real browser run is possible in this sandbox |
| 21 | No deploy, no production data change without approval | honoured | nothing applied or pushed |

Earlier open items from the "complete bug fix" order that were closed in the same work:
6 (logo upload), 17 (builder quality / single-file), 18 (conversation history),
19 (capability registry — `_shared/models.ts`).

---

## B. Code changes made in this pass

### Customer marketing desk — rewritten
`public/js/modules/dashboard/views/marketing.js`
- `CHANNELS` — Instagram, Facebook, WhatsApp Business, Email, Google Ads (Google Ads carries the
  customer-ID hint; Search appears as a *campaign type*, not a channel).
- Four-step wizard: **Accounts → Business → Campaign → Review**.
- Requests list with reference, status badge, timeline history, asset download, and
  "Send the extra information" (writes a customer-visible event, never an internal one).
- Submit writes a real `marketing_requests` row (`status: "submitted"`), then an event,
  then `notify_admins`. If the notification fails the UI says so rather than claiming success.

### Admin marketing desk — new
`public/js/modules/admin/views/marketing.js`
- Counts (awaiting review / approved / completed / budget requested), filters (all / Meta Ads /
  Google Ads / awaiting review), search over reference, business and Instagram.
- Detail modal: every collected field, accounts, assets (signed URLs, 10-minute link),
  event history with internal notes marked, internal note editor.
- Status dialog: writes the status, records the decision (`decided_by`, `decided_at`), appends a
  timeline entry, and calls `notify_customer`. Failures are surfaced per-write, not swallowed.
- Copy is explicit that **Approved ≠ advert running**.

### Shell / navigation
- `dashboard/shell.js` — Growth item label → **"Request for Extra Service"** (id stays `marketing`).
- `admin/shell.js` — new **Marketing requests** item under Operations, lazy loader registered,
  badge bound to `counts.marketing_pending`.
- `supabase/functions/admin/index.ts` — `overview` now also counts
  `marketing_requests` in `submitted / under_review / more_information_required`.

### Business logo (earlier bug-fix item 6)
`dashboard/views/settings.js` — Business logo card: preview, upload, replace, remove, 2 MB and
MIME checks, uploads to the private `brand-assets` bucket under the user's own folder, saves
`businesses.logo_url`. Honest error when the bucket is not provisioned.

### Landing page
- `public/index.html` — hero device chrome reads `SHINZORA`; footer social row
  (Instagram, YouTube, WhatsApp `wa.me`, `mailto:official.shinzora@proton.me`), all
  `rel="noopener noreferrer"` with aria-labels.
- `public/js/lib/icons.js` — `instagram`, `youtube`, `whatsapp` glyphs.
- `public/css/marketing-sections.css` — `.footer-social*`, stacks at 560 px.

### Status vocabulary
`public/js/lib/format.js` — labels and tones for `submitted`, `under_review`,
`more_information_required`, `in_progress`, `completed`, `revoked`, `awaiting_toolchain`,
`built`, `expired`. No status now falls through to a title-cased guess.

### Asset stamp
`?v=20261107e` across the 27 files that carry it.

---

## C. Database changes (written, **not applied**)

| File | What it adds |
|---|---|
| `0011_generation_conversion_marketing.sql` | `project_versions`, `ai_generation_jobs`, `conversion_jobs`, `marketing_accounts`, `marketing_requests`, `marketing_request_events`, `admin_notifications` + ownership checks and RLS |
| `0012_app_package_enforcement.sql` | `app_platform_slots()`, plan/target enforcement for Free (one target) and Enterprise (Android + iOS), insert/update guards, artifact must exist before `built` |
| `0013_marketing_request_workflow.sql` | `details jsonb`; `draft` status; reference issued on submission only + unique partial index; `marketing_requests_guard` v2 (the customer's only legal transition is `draft → submitted`, everything else `42501`); owner insert policy; owner event policy (`internal = false` only); admin-only `notify_customer()`; private `marketing-assets` bucket with per-user folder policies |

Contract worth remembering: statuses are
`draft, submitted, under_review, more_information_required, approved, in_progress, completed, rejected`;
references look like `MR-YYMMDD-ABCDEF` and only exist once a request has been submitted.

Registered in `scripts/apply-migrations.mjs` (objects + invariants) and counted by
`tests/migration-verify-sql` (8 keys, 52 assertions).

---

## D. Test results (exact)

```
14  21  22  45  12  18  56  58  17  52  53  38  36  56  51  57  27  25  20   = 678 assertions
0 failed
23 routes and 4 header checks passed
check.mjs: 13 migrations, 40 tables, 78 modules, 23 pages — all static checks passed
```

New or extended this pass:
- `tests/marketing-workflow.test.mjs` — 25 (draft, submit, self-approve refused, timeline,
  admin decision, status set, reference uniqueness).
- `tests/marketing-status-labels.test.mjs` — 20 (every request/build state has a real word
  and a sane tone).
- `tests/marketing-rls.test.mjs` — 53. Two assertions were **corrected**, not weakened:
  filing a request already `approved` is now refused by the guard trigger (message
  "A new request starts as a draft or as submitted") rather than by RLS, so the assertion
  accepts that message; and the customer *may* answer on their own request while an internal
  note is still refused — which is exactly what requirement 16 asks for.

**Categories covered:** unit, integration (PGlite running the real migrations), static checks,
route smoke. **No real browser test has been run** — this sandbox has no browser, so anything
that only a browser can prove (paint, focus, download dialogs, OAuth redirects) is unverified.

---

## E. What the tests actually prove about the risky parts

- **Progress cannot lie.** With every task complete and review done but nothing saved, the bar
  reads **93 %** and `done === false`. 100 % is only reachable through a completed save
  (`builder-core` suite).
- **Single-file output is real.** The four-page fixture is packed into one `index.html`; the
  file opens, hash routing works, the entry page's `<header>`/`<nav>` do not leak into other
  routes, a link to an unbuilt page fails validation instead of shipping, and `about.html#team`
  survives instead of degrading to `#/about`.
- **Plan gating is backend-side.** A Free account cannot hold two platform targets; an
  Enterprise account can hold Android and iOS; a job cannot point at an artifact that does not
  exist.
- **The marketing guard is the only gate.** A customer that tries to approve, assign a reviewer
  or write an internal note gets `42501`; `notify_customer()` is `security definer` and
  admin-gated; `marketing-assets` is private with per-user folders.

---

## F. Blocked — and exactly which credentials or decisions unblock them

1. **Meta / Instagram, WhatsApp Business, Google Ads OAuth.** Needs a Meta app
   (App ID + secret, `instagram_basic`, `instagram_manage_insights`, `pages_show_list`,
   `ads_read`, `business_management` with App Review) and a Google Cloud OAuth client
   (`ads` + `adwords` scope, Search Console not needed). Secrets stay server-side in the
   `marketing` Edge function; nothing goes into browser storage. Until then the connect step
   records an account in `pending_verification` and the UI says **"Submitted for
   verification"** — never "Connected".
2. **Real APK / AAB / IPA builds.** Needs a Linux build host with Android SDK + JDK, and for
   iOS a macOS runner with Xcode plus a **paid Apple Developer certificate and provisioning
   profile**. Android signing needs a keystore you own. The platform will refuse to mark a
   conversion job `built` without a stored artifact.
3. **GitHub / Vercel connection (earlier items 7–8).** Needs a GitHub OAuth app and a Vercel
   personal access token (server-side).
4. **Applying the migrations.** Needs a `SUPABASE_ACCESS_TOKEN` or `DATABASE_URL`; this sandbox
   cannot reach the project. `apply-migrations.mjs` refuses without the token.
5. **Rotating the exposed AI key.** Recommended — that key has been exposed. I will not print
   or handle it.
6. **Declaration / regulatory text for the app packages** (privacy policy URL, content rating
   answers) — your call, not something to invent.

---

## G. Deliberately not done

- No migration applied, no Edge function deployed, no GitHub push, no production write.
- No APK, AAB, IPA or DMG claimed to exist — none was generated.
- No OAuth flow faked, no "Connected" state shown before verification, no competitor or
  research finding invented, no advert auto-launched.
- No demo accounts, no demo mode, no emoji, no invented statistics.

---

## H. Deployment plan — one step at a time, only on your word

Staging first. I will wait for your approval at each step and show the exact command and its
output before the next.

1. **Back up** — snapshot the production database (Supabase dashboard → Database → Backups) and
   note the current row counts for `businesses`, `projects`, `marketing_requests`.
2. **Read 0011 out loud** — I show you the file; you confirm it only adds tables/policies and
   alters nothing existing.
3. **Apply 0011** on staging; re-run `tests/migration-verify-sql` against it.
4. **Apply 0012**, then 0013, in that order; each with the same verify step.
5. **Deploy `admin` (modified) and `marketing` (new) functions** to `zmkgfmlcpzjfgxdmbtvi`,
   verifying the source hash of each file first.
6. **Deploy the frontend** (asset stamp `20261107e`).
7. **Smoke:** file one marketing request as a test customer, approve it as an admin, confirm the
   customer's notification and the internal note stays hidden. Then produce it on production.

Each step is individually reversible, and I stop at the first unexpected result.

---

## I. Residual risks worth naming

- The marketing UI has only ever been type-checked and bundled; it has not painted a pixel in a
  browser. Expect small layout corrections on first real load.
- `0013` changes the contract that `marketing-rls` assumed in two places; both were updated
  deliberately (see D). Review those two assertions before you accept the suite as green.
- The admin status dialog is optimistic about `notify_customer` existing — it is created by
  `0013`, so the frontend must not ship before the migration is applied.
- Free-plan enforcement is still untested against the live `subscriptions` rows; the PGlite
  fixture mirrors the schema but not your real plan data.

---

## J. Where the evidence lives

- `docs/BUILDER-UPGRADE.md` — Part 1/2 requirement tables and defect list.
- `docs/REPAIR-LOG.md` — the earlier repair order, item by item.
- `docs/FINAL-REPORT.md` — this document.
- Tests: `tests/*.test.mjs` (the counts in section D map one-to-one to files).
