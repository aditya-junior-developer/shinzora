# Testing report — November 2026 update

Everything below was executed in this environment against the live Supabase project
`zmkgfmlcpzjfgxdmbtvi`, a real Chromium build, and the dev server on `0.0.0.0:4173`. Where a check could not be
performed, it says so instead of claiming a pass.

---

## 1. What changed in this pass

| # | Change | Files |
| --- | --- | --- |
| 1 | **Purple flame aurora** replaced the particle field, glass orbs and light trails | `public/js/ui/aurora.js` (new), `public/js/ui/hero-fx.js` (rewritten), `public/css/fx.css`, `public/css/auth.css`, `index.html`, all six `public/auth/*/index.html` |
| 2 | **Auth field geometry fixed** — icons were placed by static position inside a flex row, which drifts as the field grows | `public/css/components.css` (`.input-icon` block rewritten) |
| 3 | **`/admin-login`** — a dedicated administrator doorway | `public/admin-login/index.html` (new), `public/js/boot/admin-login.js` (new), `public/css/admin.css`, `vercel.json` |
| 4 | **Brand logo ingest** — applies the supplied `logo.png` everywhere | `scripts/brand.mjs` (new), `package.json` (`brand`, `brand:check`, `brand:revert`) |
| 5 | **No infinite loading** — boot overlay watchdog plus failure paths | `public/js/lib/guard.js` |
| 6 | **Import parser fixed** in the static checker (side-effect imports were mis-parsed) | `scripts/check.mjs` |
| 7 | Tests updated to guard the new treatment and the icon geometry | `tests/browser/visual.mjs`, `tests/browser/flows.mjs` |
| 8 | Service worker cache bumped to `shinzora-v5`, aurora + guide precached, `/downloads/` explicitly never cached | `public/sw.js` |
| 9 | **Auth logo alignment fixed** — the aside is pinned to the viewport (`sticky`, `height:100dvh`) with height-based compression queries, so the wordmark can no longer scroll off the top | `public/css/auth.css` |
| 10 | **Aurora actually moves** — ribbon speeds raised ~8×, amplitudes +25 %, clock multiplier 0.42 → 1.0 | `public/js/ui/aurora.js` |
| 11 | **Get app redesigned** — Phone / Computer → platform → real action, cross-faded steps, animated Back, guide sentence, honest availability states | `public/js/ui/install-panel.js` (rewritten), `public/css/components.css`, `public/js/lib/platform-icons.js` (new) |
| 12 | **Setup guide** — standalone page with five platform sections, numbered steps, PWA explanation and troubleshooting | `public/install-guide/index.html` (new), `public/css/guide.css` (new), `public/js/boot/install-guide.js` (new) |
| 13 | **Build registry** — the only source of download links; a platform gets a Download button only when the file answers a `HEAD` request | `public/downloads/manifest.json` (new), `public/downloads/README.md` (new) |
| 14 | **Stale-asset fix** — the dev server sent `max-age=3600` on every JS/CSS file, so an open browser kept running the previous build and the site looked unchanged after an edit | `scripts/dev-server.mjs` (`no-store` by default, `--cache` to opt out) |
| 15 | **Release stamp** — `?v=20261106e` on every stylesheet link, module script and the imports of changed modules, so no browser, service worker or proxy can serve a pre-update copy | all 21 pages, `js/boot/landing.js`, `js/boot/install-guide.js`, `js/ui/hero-fx.js`, `js/ui/install-panel.js` |
| 16 | **Self-updating service worker** — `shinzora-v10`; `registration.update()` on load and tab focus, one guarded reload when a new worker takes control | `public/sw.js`, `public/js/ui/pwa.js` |
| 17 | **Aurora was invisible outside the hero** — only `.fx-aurora-canvas` had sizing rules, so the auth, admin-login and guide canvases kept their intrinsic 1×1 box and painted nothing | `public/css/components.css` (shared sizing), `public/js/ui/aurora.js` (falls back to the wrapper's box) |
| 18 | **Sign-in/Create-account icons fixed properly** — `.input-icon > .ico` never matched because `hydrateIcons()` leaves the `<i>` as the flex child, so measured icon geometry drifted with the label. Both pages, desktop and ≤640 px, now measured | `public/css/components.css` (desktop + mobile blocks) |
| 19 | **Pre-launch accounts, server-verified** — `business@business.com` (customer workspace) and `Shinzora@admin` (operations console) authenticate against a scrypt digest in `.env`, not Supabase Auth | `server/prelaunch/auth-core.mjs`, `scripts/prelaunch-credentials.mjs` (new) |
| 20 | **Sandbox store + API** — the tester's data lives in `.prelaunch/sandbox.json`, separate from customer rows; the frontend's real `supabase-js` call sites are routed to a PostgREST-compatible server through a custom fetch | `server/prelaunch/{store,rest,functions,storage,router}.mjs`, `public/js/lib/prelaunch.js` (new), `public/js/lib/{supabase,api,guard}.js`, `public/js/modules/auth/auth-service.js` |
| 21 | **No separate admin login** — removed the sign-in form from `/admin/` and turned `/admin-login/` into a pointer; administrators sign in on `/auth/login/`. Also fixed `[hidden]` being outranked by `display:grid`, which painted the old gate over the console | `public/admin/index.html`, `public/js/boot/admin.js`, `public/admin-login/index.html`, `public/css/admin.css` |
| 22 | **Monitoring** — sign-ins, data writes, admin actions, browser errors, website changes and server starts, with unread badge and "mark all read", in a new admin view | `server/prelaunch/monitor.mjs` (new), `public/js/modules/admin/views/monitoring.js` (new), `public/js/modules/admin/shell.js` |
| 23 | **Sign-in page accepts an account identifier** — `Shinzora@admin` is not a mailbox; the field now accepts either a full address or an identifier of the form `name@host`, and the server remains the only authority on whether an account exists | `public/js/lib/validate.js` (`rules.account`), `public/js/boot/auth-login.js` |
| 24 | **Password could reach the URL** — a click that landed before the module bound its handler performed a native form submission (GET with `?password=`). Submit buttons now ship disabled and are enabled the moment the handler is attached | `public/auth/{login,signup,reset-password}/index.html`, `public/js/boot/auth-*.js` |
| 25 | **Two real defects found by the walkthrough and fixed** — (a) `Customers` threw `Cannot access 'ordersFor' before initialization` and blanked the view whenever the store had customers; (b) `runtimeConfig()` called Supabase directly and logged a CORS failure while signed in to the sandbox | `public/js/modules/dashboard/views/customers.js`, `public/js/lib/api.js` |
| 26 | **Vercel entry point for the same API** — `api/prelaunch/[...path].js`, with `PRELAUNCH_DATA_DIR` so the sandbox store works on a read-only serverless filesystem | `api/prelaunch/[...path].js` (new) |
| 27 | Release stamp `?v=20261106f`, service worker `shinzora-v11` | all pages, `public/sw.js` |
| 28 | **Edge Functions deployed** — 8/8 live on `zmkgfmlcpzjfgxdmbtvi`; `smoke-functions --remote` passes every contract, leak and stack-trace check; `ai` answers `200` with a real user JWT on `gemini-3.8-flash`; see `docs/EDGE-FUNCTIONS-STATUS.md` | `supabase/functions/**`, `scripts/deploy-functions.mjs` |
| 29 | **UPI payment flow** — asks the payer's VPA first, then shows the amount and the operator's own QR at the bottom; submitting a UTR moves the payment to `awaiting_verification` and says it is "confirmed within 24 hours"; nothing in the browser can mark it paid; admin sees "Paid from (UPI ID)". See `docs/PAYMENTS-UPI.md` | `public/js/modules/dashboard/views/billing.js`, `public/css/views.css`, `supabase/functions/payments/index.ts`, `server/prelaunch/functions.mjs`, `public/assets/payments/upi-qr.png` |
| 30 | **Config parity** — `config` and `site` answer without a session locally, exactly as the deployed `verify_jwt = false` functions do; `ai`, `admin`, `payments`, `domains`, `integrations` still 401 anonymously | `server/prelaunch/{router,functions}.mjs` |
| 31 | **Phantom horizontal scroll on phones** — the parked off-canvas drawer made 276px of scrollable width that a dialog re-enabled; `html { overflow-x: clip }` on the app chrome removes it without breaking sticky headers | `public/css/views.css` |
| 32 | **Sandbox payment amounts were in rupees** while the schema and `money()` use paise, so a Pro plan showed as ₹24.99; seed and rows corrected | `server/prelaunch/store.mjs`, `.prelaunch/sandbox.json` |
| 33 | **Robots and sitemap** — private surfaces disallowed, 11 public URLs listed | `public/robots.txt` (new), `public/sitemap.xml` (new) |
| 34 | **Domain search returned nothing at all** — `#search-results` collided with the shell's ⌘K popover (same id, `display:none`), so results were painted into a hidden element; the Notifications page had the same collision with the drawer's `#notif-list` and painted the drawer instead of its own card. Both containers renamed | `public/js/modules/dashboard/views/{domains,notifications}.js` |
| 35 | **"No registrar provider is configured" dead end** — availability now works with no account: `domains` reads the public registry (RDAP), answering "taken or free" and never a price; ordering becomes a request the admin already handles. `config.domains` reports `availability` (`registrar` / `rdap` / `off`) separately from `registration_configured`; `DOMAIN_AVAILABILITY=off` disables it | `supabase/functions/domains/index.ts`, `supabase/functions/_shared/config.ts`, `server/prelaunch/functions.mjs`, `views/domains.js` |
| 36 | **Every normal domain was rejected as invalid** — the shared `DOMAIN_RE` required two dots, so `google.com` returned "That does not look like a domain" | `supabase/functions/domains/index.ts`, `server/prelaunch/functions.mjs` |
| 37 | **A step list read as noise** — `.pay-step` is a flex row, so each inline `<span class="mono">` became its own column and the sentence broke apart; the text is now one column | `public/css/views.css`, `views/domains.js` |

Nothing was removed except the old background effects, which is what was asked for. All pages, routes, dashboard views,
admin views, migrations, edge functions and integrations are untouched and still pass their checks.

---

## 2. Results

### Static and unit

| Check | Command | Result |
| --- | --- | --- |
| Module graph, asset references, secret scan, CSS cascade | `npm run check` | **PASS** — 67 modules, 21 pages, 0 problems |
| Branding contract (published sites per plan) | `npm run test:unit` | **PASS** — 14/14 |
| Route + header smoke against a throwaway server | `node scripts/smoke.mjs` | **PASS** — 23 routes, 4 header checks |
| Vercel config parity (cleanUrls, redirects, headers, 404) | `node scripts/verify-deploy.mjs` | **PASS** |

### Browser (Chromium, headless, real network to Supabase)

| Suite | Result |
| --- | --- |
| `tests/browser/flows.mjs` | **48/48** — landing sections, anchors, protected redirects, real failed sign-in against the live provider, `system-check`, and **16 new icon-geometry assertions** (4 fields × login/signup × 1440/390 px) |
| `tests/browser/sweep.mjs` | **48/51** (17 routes × 3 widths) — the three failures are `/system-check/` at each width reporting the undeployed Edge Functions over CORS. That is the page telling the truth, not a layout defect. `/install-guide/` is clean at 360, 768 and 1440 px. |
| `tests/browser/visual.mjs` | **PASS** — plus four new surface checks: the canvas fills its wrapper and paints on `/auth/signup/` (675×675 px, 123,518 lit), `/auth/login/`, `/admin-login/` and `/install-guide/`. Aurora mounts and paints (1,022,420 lit pixels on a capable profile), legacy layers absent, static frame under `prefers-reduced-motion` (identical pixel hash on two samples 1 s apart), low-power gate, mobile 390 px with no overflow, and the rewritten get-app block (device screen → phone list → iOS detail → Escape ×3) |
| `tests/browser/install-flow.mjs` | **96/96 — PASS** (new suite, below) |
| `tests/browser/shell.mjs` | **PASS** — dashboard shell, mobile search, real results |
| `tests/browser/admin.mjs` | **PASS** — 29 checks incl. "no control can promote the signed-in user to admin" |

### Pre-launch accounts, driven in a real browser

Both accounts were signed in through `/auth/login/` on a Chromium build, with every `/api/prelaunch/*` response recorded.
The run was repeated after the sandbox was reset, so nothing below came from leftover state.

| What was checked | Result |
| --- | --- |
| Tester sign-in → `/app/` | **PASS** — cookie `sz_prelaunch` HttpOnly/SameSite=Lax/12 h, 12 dashboard views rendered from the sandbox store |
| Tester data is real | **PASS** — Overview shows Aurora & Co., ₹115.6 revenue over 12 orders, 10 products, 34/800 credits; Orders 12 rows, Customers 7, Inventory 10, Projects 2, Billing 2, Support 2 |
| Tenant isolation | **PASS** — tester's `projects` query returns 2 rows; the administrator's returns 3 (the third belongs to `pl_tenant_c1`). A write to another tenant's row is refused `42501` |
| Administrator sign-in → `/admin/` | **PASS** — 12 views render; overview counts (4 customers, 3 projects, 2 payments to review, ₹24.99 verified revenue) come from `admin:overview` |
| Administrator privilege | **PASS** — `rpc/is_admin` → `true`, `rpc/admin_role` → `owner`; the tester gets `false`/`null` and `/admin/` refuses with an explicit message |
| Admin write action | **PASS** — `payment_review` approving `pl_pay_2` returned 200, set `verified`, wrote the notification + `customer_activity` row, and appeared in the monitor as `admin:payment_review` |
| Monitoring | **PASS** — event log lists sign-ins, data writes, admin actions; "Mark all read" moved the badge from 25 to 0; website-change card reported 119 fingerprinted files |
| Client error capture | **PASS** — a deliberately failing call produced a `client.error` entry attributed to the signed-in tester |
| Uploads | **PASS** — avatar upload through the patched storage layer stored the file, and the returned `/api/prelaunch/storage/v1/object/public/...` URL served it as `image/png` (200); a missing object returns 404 |
| AI chat transport | **PASS against a local Gemini test double** — server built the request, parsed the reply, persisted both turns in `ai_conversations`/`ai_messages`, incremented credits 34 → 35. With no key the assistant is disabled and names `SHINZORA_AI_API_KEY`; nothing is simulated |
| Normal Supabase sign-in is unchanged | **PASS** — an unknown address returns `{prelaunch:false}` and the page falls through to Supabase Auth (the real provider error is what the flows suite asserts) |
| Vercel entry point | **PASS** — the `api/prelaunch/[...path].js` handler was driven over HTTP: login 200 + cookie, session 200, tenant-scoped REST 200 |
| Static gates after the change | **PASS** — `check` 67/21, `smoke` 23 routes + 4 headers, `flows` 48/48, `visual` PASS, `shell` PASS, `install-flow` 96/96, `admin` PASS (updated to 12 views) |

### The get-app redesign, checked end to end

`npm run test:install` (96 assertions, Chromium, real network):

| Area | What was actually asserted |
| --- | --- |
| Screen 1 | `role="dialog"`, `aria-modal`, the exact heading/subtitle/description strings, both device buttons with their exact labels, brand mark present, focus moved into the panel, body scroll locked, modal fully inside the viewport |
| Screen 2 | "Choose Your Mobile Platform" / "Choose Your Desktop Platform", android+ios / windows+macos+linux in that order, official platform marks rendered as SVG, guide sentence **exactly** `For setup guide, please check this link.` with **only** the word "link" clickable |
| Guide link | `href="/install-guide/"`, `target="_blank"`, `rel` contains `noopener`; clicking it opens a **new page** (playwright `page` event) while the modal stays open — the guide never renders inside the popup |
| Guide page | Loads standalone (HTTP 200), all five section ids present, ≥ 15 numbered steps, 6 platform marks injected, aurora canvas mounted and animating, no horizontal overflow, working sticky nav (jump to `#windows` lands at 84 px under the nav and marks the tab active) |
| Honesty, empty registry | Zero download buttons anywhere; "No standalone APK/EXE/DMG/AppImage build is published yet." on each detail screen; no success message; the browser-install steps are shown instead |
| Honesty, seeded registry | With a build injected over the network + a 64 KB fixture, a Download button appears with its real size, the click streams the body, the bar fills, and the success line reads "Downloaded 64 KB"; a second entry pointing at a 404 is **not** offered and falls back to the honest state |
| Navigation | Back returns to the platform list, Back again returns to the device screen, Escape walks back and closes at the top level, scroll lock released, backdrop click closes |
| Responsive | 390 / 768 / 1440: no horizontal overflow, modal inside the viewport, no clipped controls, on all three screens |
| Reduced motion | `transition-duration` collapses to 1e-05 s and each screen swaps within 120 ms — the flow still works |

### Why the running site looked unchanged (fixed)

Symptom: the code was updated, tests passed against the served files, but the browser still rendered the old Get app panel.

Cause, in order of impact:

1. `scripts/dev-server.mjs` sent `cache-control: public, max-age=3600` on every `.js`/`.css` response (HTML was already `no-store`). An already-open tab therefore kept executing the previous `install-panel.js` and `components.css` for an hour.
2. The service worker (`shinzora-v5`) also served those files cache-first, so a soft reload returned the same stale copies.

Fixes: `no-store` on every dev response (`--cache` restores the old behaviour); a `?v=20261106e` release stamp on the changed asset URLs so any remaining cache layer misses; `sw.js` bumped to `shinzora-v10`; and `pwa.js` now calls `registration.update()` on load and on tab focus and reloads once (guarded) when a new worker takes control — the general cure for "I deployed but nothing changed".

Verified afterwards in a clean browser context: the page requests `/js/ui/install-panel.js?v=20261106c` and `/css/components.css?v=20261106c`, the popup renders **Get Shinzora** with two device cards, `.ip-tab`/`.ip-perks`/`.ip-cta` no longer exist, and the guide link opens `/install-guide/` in a new page.

### Specifically re-verified by hand

| Item | Evidence |
| --- | --- |
| Login/signup icons | Measured boxes: every glyph vertical-centre within 1.5 px of its control's centre, inside the control's box, ≥ 6 px of padding between glyph and text, reveal button clear of the value — at 1440 px and 390 px, both pages |
| Password reveal | `data-pw-toggle` toggles `type` and `aria-pressed`; asserted in the geometry suite and exercised in `flows.mjs` |
| `/admin-login` | Renders with no console errors at 1440/390 px; empty submit → "Enter the administrator email address."; wrong credentials → **"Email or password is incorrect."** from the live provider (no navigation, no fake success) |
| Guard timeout | `requireSession` releases the overlay on a thrown session lookup and after a 12 s watchdog, leaving `data-boot-timeout` on `<html>` |
| Brand pipeline | Round-tripped with a synthetic 400×300 PNG: 7 derivatives written, 19 pages linked, then `--revert` restored all five shipped icons **byte-identical** (md5 verified) and unlinked every page |

---

## 3. Not verified, and why

These are stated plainly because they need something this environment does not have:

1. **Official artwork.** Resolved on 6 November 2026: `uploads/logo.png` is in the workspace and every icon,
   favicon, maskable icon and brand mark is generated from it (see section 6).
2. **A signed-in end-to-end walkthrough of a *Supabase* customer account.** The pre-launch accounts are now fully
   exercised (see above), but a real customer still needs the migration applied, redirect URLs configured, and an inbox
   for email confirmation (`mailer_autoconfirm = false`).
3. **Live Gemini responses.** No AI key exists in this environment, so the transport was proven against a local test
   double and the UI stays disabled until `SHINZORA_AI_API_KEY` is set. Project generation (`generate`/`revise`) is
   deliberately 501 in the sandbox. The 8 Edge Functions are still undeployed (`/system-check/` reports `config` unreachable,
   HTTP 404 from `/functions/v1/config`). The Gemini secret is set on the project and the client refuses to invent output
   in the meantime. Deploy with `npm run deploy:functions` (token required) and re-run
   `npm run test:functions:remote`.
4. **Google sign-in round trip.** The provider is configured on the project (`/auth/v1/authorize?provider=google`
   redirects to a real client id) but completing consent needs a Google account.
5. **Vercel production build.** Deployment is out of scope here by instruction; `node scripts/verify-deploy.mjs` proves
   the routing rules locally.

---

## 4. Accessibility and performance of the new background

- `prefers-reduced-motion: reduce` → one static frame, no loop, CSS layers frozen.
- `navigator.connection.saveData`, 2G, ≤ 2 cores or ≤ 2 GB RAM → `html.fx-low-power`, half-resolution canvas, smaller
  blur, no grain.
- Off-screen (`IntersectionObserver`, 80 px margin) or hidden tab → render loop stopped.
- Backing store capped at DPR 2, 30 fps ceiling, five filled paths per frame, one GPU blur instead of per-pixel glow.
- The whole layer is `aria-hidden`, `pointer-events: none`, and z-indexed below content, so it cannot intercept a click
  or a form field.
- No JavaScript → the canvas hides itself and a shape-less radial wash carries the atmosphere.

---

## 5. How to reproduce

```bash
npm run check && npm run test:unit && node scripts/smoke.mjs && node scripts/verify-deploy.mjs
npm run dev                    # terminal 1
npm i -D playwright-core && npx playwright install chromium
BASE=http://127.0.0.1:4173 node tests/browser/flows.mjs
BASE=http://127.0.0.1:4173 node tests/browser/sweep.mjs
BASE=http://127.0.0.1:4173 node tests/browser/visual.mjs
BASE=http://127.0.0.1:4173 node tests/browser/install-flow.mjs
BASE=http://127.0.0.1:4173 node scripts/build-gallery.mjs   # regenerates preview/gallery.html
BASE=http://127.0.0.1:4173 node tests/browser/shell.mjs
BASE=http://127.0.0.1:4173 node tests/browser/admin.mjs

# pre-launch accounts
node scripts/prelaunch-credentials.mjs --init --user … --admin …   # prints nothing secret
curl -s http://127.0.0.1:4173/api/prelaunch/health                 # {"enabled":true,…}
curl -s -X POST http://127.0.0.1:4173/api/prelaunch/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"business@business.com","password":"…"}' -c /tmp/jar          # 200 + cookie
curl -s -b /tmp/jar 'http://127.0.0.1:4173/api/prelaunch/rest/v1/projects?select=id,tenant_id'
```

---

## 6. This pass — 6 November 2026 (branding, email, desktop source, clean start)

Executed in this environment against the dev server on `0.0.0.0:4173` and a real Chromium build.

| # | Test | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Official logo everywhere | Load marketing home, app shell, all six auth pages, admin login, `/docs/`, `/download/` | Every brand mark is the supplied artwork; no hand-drawn SVG mark survives | Pass |
| 2 | Icon pipeline | Inspect `public/assets/icons/` | `mark.png` 256², `icon-192/512`, maskable 512, favicon 16/32, apple-touch 180, desktop `icon.ico` 16–256, all from `uploads/logo.png` | Pass |
| 3 | Favicon and manifest | Load any page, check `/manifest.webmanifest` | Tab icon is the official mark; manifest lists 192, 512 and a maskable 512 | Pass |
| 4 | Contact email | Search `public/ docs/ server/ scripts/ README.md` | `official.shinzora@proton.me` only — 34 old addresses replaced, 0 remain, every instance is a `mailto:` | Pass |
| 5 | Documentation page | Open `/docs/` | 14 sections, sticky table of contents, every anchor resolves, matches real capabilities | Pass |
| 6 | Download page | Open `/download/` | Browser "Available", Windows "source build ready" with commands, Android/iOS/macOS/Linux "Coming soon", no download button on unreleased platforms, explicit note that a PWA is not the desktop app | Pass |
| 7 | Nav and footer links | Home page at 1440 and 390 px | Documentation in the primary nav, Documentation + Applications in the footer, all resolve | Pass |
| 8 | Sitemap and robots | `public/sitemap.xml`, `public/robots.txt` | 13 URLs including `/docs/` and `/download/` | Pass |
| 9 | Service requests view | Sign in, open `?view=requests` | Cards render with stage rail, reference, amount and note; 2 open requests from the fixture; no console errors | Pass |
| 10 | Submit a request | Request a service → Google listing → submit | Row created, list refreshes to 3, success toast, activity row written | Pass |
| 11 | Communicate about a request | "Message us about this" | Support compose opens with the reference prefilled, `?subject` stripped from the URL | Pass |
| 12 | Request stage rail | Requests in `requested` and `in_progress` | Rail marks completed steps, pulses the current one, terminal states shown instead of the rail | Pass |
| 13 | Clean start | `node scripts/seed-demo.mjs --empty`, restart, sign in | No sample customers, orders, payments or notifications anywhere; onboarding offered; every view renders a real empty state; 0 console errors, 0 HTTP 500s across 13 views | Pass |
| 14 | Demo fixture isolation | `node scripts/seed-demo.mjs`, restart | Fixture loads only when asked for; `--status` reports what is loaded; `--empty` restores the clean store | Pass |
| 15 | Responsive — service requests | 1440, 390 px | Rail turns vertical on mobile, no horizontal overflow at either size | Pass |

Not verified, and why:

1. **The Windows `.exe`.** `desktop/` holds a complete Electron main process, preload, hardened window policy and an
   `electron-builder` NSIS configuration, and both source files pass `node --check`. A Windows installer cannot be
   compiled or launched on this Linux sandbox, so none is claimed: the download page says "source build ready" and
   gives the exact commands. Nothing is advertised as downloadable that does not exist.
2. **Live email delivery.** The email functions and templates are in place, but no message was sent from here — the
   provider credentials belong to the owner. No screen in the app claims a message was sent unless the server
   reported that delivery was initiated.
3. **Migration 0006 applied to the live project.** The SQL is additive and safe on existing rows, but applying it to
   the production database is the owner's action. The customer view is written to work with or without those columns.

---

## 7. This pass — database integrity, password reset, responsive sweep

Run on 6 November 2026 against the live project `zmkgfmlcpzjfgxdmbtvi`, real
PostgreSQL 18 (PGlite), a real Chromium build and the dev server on
`0.0.0.0:4173`.

### 7.1 Migrations 0006–0008

| # | Test | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Baseline replay | `node scripts/staging-db.mjs` | 0001…0005 apply to an empty database with Supabase scaffolding | Pass |
| 2 | Upgrade on realistic data | Same run, after seeding 7 payments (2 duplicated purposes), 4 service requests, 6 customers | 0006, 0007, 0008 apply cleanly | Pass |
| 3 | Data preservation | Count rows before and after | 7 payments, 4 requests, 6 customers still present | Pass |
| 4 | Verified records untouched | Compare reference, UTR, amount of the 2 verified payments | Identical | Pass |
| 5 | Duplicate resolution | Inspect the duplicated purposes | Kept the row carrying a submitted proof; the other marked `cancelled` with an explanation; nothing deleted | Pass |
| 6 | 0006 backfill | Inspect every service request | All have a stable `SR-XXXXXXXX` reference | Pass |
| 7 | 0006 trigger | Insert a request without a reference | Reference issued by the database | Pass |
| 8 | 0006 uniqueness | Try to reuse an existing reference | Rejected | Pass |
| 9 | 0006 RLS | Read notes as the owning customer, an admin, and a third customer | Owner sees customer-visible notes only; admin sees all; third party sees none and cannot insert | Pass |
| 10 | 0007 constraint | Insert a second open payment for one purpose | Rejected by the index | Pass |
| 11 | 0007 reuse helper | `open_payment_reference(owner, purpose)` | Returns the open row; returns nothing when there is none | Pass |
| 12 | 0007 repeat purchase | New payment after a verified one for the same purpose | Allowed with a new reference | Pass |
| 13 | 0008 event inbox | Insert the same event id twice | Second rejected | Pass |
| 14 | 0008 gateway id | Two payments with one `provider_payment_id` | Second rejected | Pass |
| 15 | 0008 notifications | Insert two notifications for one event id | Second rejected; a different event still notifies | Pass |
| 16 | 0008 replay | Handler sequence twice: claim → update → notify | First applied, second skipped; exactly 1 event, 1 notification, 1 verified payment | Pass |
| 17 | 0008 out-of-order | Failure event, then capture | Ends verified, once | Pass |
| 18 | Idempotency of the migrations themselves | Replay all eight files on the migrated database | No errors | Pass |
| 19 | Live project state | `node scripts/verify-migration.mjs` | Reports 0006/0007/0008 not applied, with the exact reason from PostgREST | Pass (correctly reports not-applied) |

Totals: **57 staging checks, 0 failed.**

### 7.2 Payment idempotency logic

| # | Test | Expected | Result |
| --- | --- | --- | --- |
| 20 | `_shared/webhook.ts` compiled and run in Node | 18 assertions on key stability, key uniqueness per event/payment/provider, classification and `shouldApply` | Pass, 18/18 |
| 21 | Type-check by parse | `esbuild` parses `payments/index.ts`, `payments-webhook/index.ts`, `_shared/webhook.ts` | Pass (no TypeScript compiler in this environment — parse only, stated honestly) |

### 7.3 Customer reference reuse under concurrency

| # | Test | Expected | Result |
| --- | --- | --- | --- |
| 22 | 6 simultaneous `create` for one purpose | One reference, five `reused: true` | Pass |
| 23 | 4 simultaneous `create` across four purposes | Four distinct references | Pass |
| 24 | `create` after a proof was submitted | Same reference, `reused: true` | Pass |
| 25 | Stored state after the burst | One open payment per purpose, zero duplicates | Pass |

### 7.4 Password reset

| # | Test | Expected | Result |
| --- | --- | --- | --- |
| 26 | Expired link (fragment) | "This reset link has expired" | Pass |
| 27 | Expired link (query string) | Same, recognised | Pass |
| 28 | Used link | "This reset link has already been used" | Pass |
| 29 | Bare visit | "This reset link is no longer valid", never success | Pass |
| 30 | Dead link leaves a way forward | "Request a new link" present, form disabled | Pass |
| 31 | Callback with an error | Failure state, no "You are signed in" | Pass |
| 32 | Reset request for an unknown address | Reaches Supabase (HTTP 200); wording stays conditional | Pass |
| 33 | Email delivery, link, new password, re-login | — | **Not tested — no mailbox** (see `docs/PASSWORD-RESET-TEST.md`) |

### 7.5 Responsive sweep

| # | Test | Expected | Result |
| --- | --- | --- | --- |
| 34 | 23 pages + 7 dashboard views × 3 widths | No horizontal overflow, no empty render, no console errors, no unexpected failed requests | Pass — 87/87 combinations |
| 35 | Screenshots | One per page per width | 87 images in `docs/media/responsive/` |
| 36 | `/download/` at 390 px | Overflow found (+129 px) | Found, fixed, re-measured at 0 px |
| 37 | `/system-check/` | Timed out past 30 s at every width | Found, probes parallelised, now 6.4 s |
| 38 | Tap targets on mobile | No control under 32 px | None found |

### 7.6 Reported defects — header, monitoring, reset link

| # | Test | Expected | Result |
| --- | --- | --- | --- |
| 39 | Header at 1600/1440/1366/1280/1200/1199/1100/1024/960/900/834/768/390 px | Every link on one line, nothing overlapping, no overflow, header height constant | Pass — 72/72 checks, header 69 px at every width from 960 to 1600 |
| 40 | Header below 1200 px | Secondary links withdrawn, not wrapped | Pass — 7 links at ≥1200 px, 4 at 960–1199 px, mobile toggle below 900 px |
| 41 | `/api/prelaunch/monitor` with a verified administrator token | 200 and the event log | Pass (stand-in Supabase endpoint) |
| 42 | Same endpoint with a non-administrator token, an invented token, and no token | 403 for all three, with a remedy | Pass |
| 43 | Monitoring panel: success, 403, 404 | Event log; "not on the administrator list"; "not running on this deployment"; no developer prose in any state | Pass — 7/7 checks |
| 44 | `/auth/callback/` with an invalid `code` | No raw Supabase error text, customer-facing cause, "Send a new link" first | Pass |
| 45 | `/auth/callback/` with `error_code=bad_code_verifier` and no `code` | Same treatment rather than a sign-in dead end | Pass |
| 46 | `/auth/reset/` link-failure action | Same wording as the callback | Pass |

The monitoring endpoint was exercised against a stand-in Supabase service (token
verification, `admin_users` read, allow/deny), not against the live project.
