# Shinzora — repair log

Execution record for the full platform repair order. One section per priority:
what was wrong, what changed, what was tested, and what still needs an external
action. No claim here is made without a test or a file reference behind it.

Last updated: 7 November 2026.

---

## Priority 1 — authentication, sessions, performance

### 1. Random logouts, slow first paint, frozen sign-out

**Root cause.** `prelaunchFetch` (the custom `fetch` every Supabase request runs
through) awaited a network probe of `/api/prelaunch/auth/session` before it would
send anything:

```js
const pl = await session();          // network call, every request
if (!pl) return nativeFetch(...);
```

On a deployment where that path is a cold serverless function, the first Supabase
call of every page load waited on it. When the probe was slow or failed, the
session looked missing — the app rendered as signed out, or sat on a blank shell
until the boot watchdog fired. Sign-out awaited the same class of round trip with
no ceiling, so the button appeared dead.

**What changed**

| File | Change |
| --- | --- |
| `public/js/lib/session-policy.js` *(new)* | Browser-scoped hint that records "this browser has used a sandbox account", plus a `withTimeout` helper. |
| `public/js/lib/prelaunch.js` | The probe now only blocks when that hint is set. Ordinary Supabase accounts resolve from memory — synchronously when the cache is empty — so their traffic never queues behind `/api/prelaunch`. The probe itself is capped at 2.5 s (`AbortSignal.timeout`). Sign-in sets the hint; sign-out clears it. |
| `public/js/lib/supabase.js` | `getSession()` / `getUser()` use the same rule. `signOut()` is bounded at 2.5 s and always clears the local session, so Sign out cannot hang on an unreachable auth endpoint. |

**Tested** — `tests/session-policy.test.mjs`, 21 assertions:

* no hint → exactly one network call, straight to Supabase, no probe
* hint set → REST calls are rewritten to the API; the session is not re-probed per request
* sandbox session → `/functions/v1/*` rewritten to `/api/prelaunch/fn/*`, Supabase `authorization` and `apikey` dropped, `content-type` preserved
* storage URLs rewritten; sign-out clears both the cache and the hint
* `withTimeout` returns fast work, the fallback on slow work, and the fallback on rejection

### 2. Google OAuth + PKCE

**Root cause.** `createClient` was configured with `detectSessionInUrl: true`
*and* the callback page called `exchangeCodeForSession()` itself. supabase-js
consumes the PKCE verifier on init, so one of the two exchanges always lost the
race — surfacing as the intermittent "PKCE code verifier not found in storage".

**What changed**

* `public/js/lib/supabase.js` — `detectSessionInUrl: false`, with the reason
  recorded in the file. The exchange now happens exactly once, in
  `auth-service.completeRedirect()`.
* `public/js/modules/auth/auth-service.js` — a spent or already-exchanged code
  first checks for a live session and treats it as success instead of telling the
  user to request a new link.
* `public/js/lib/guard.js` — `watchSession` now also notices a cross-tab sign-out
  (storage event on `shinzora.auth`) and re-checks the session when the tab is
  looked at again. A transient network failure never signs anybody out.

**Not yet verified end to end** — a real Google round trip needs the Supabase
project's Google provider enabled and `https://shinzora.in/auth/callback/` in the
redirect allowlist. See "External actions" below.

### 3. What the Access page says when it cannot read the directory

The screenshot showed *"The account directory could not be read / Unknown admin
action."* The message with no action name comes from
`supabase/functions/admin/index.ts:103` — the deployed `admin` function is an
older build that predates the `directory` action. The repository's copy already
implements it (`directory()` → `admin_directory()` RPC), so this is a deployment
gap, not a code gap.

`public/js/modules/admin/views/access.js` now distinguishes the three real causes
and names the command that fixes each: stale function (deploy `admin`), missing
function (deploy `admin`), missing database objects (apply migrations). The
generic message is gone, and the server's own words are shown beneath it.

---

## Priority 2 — AI routing, builder, export, assistant history

### 4. Model eligibility — nothing offered unless the server proved it works

**Root cause.** The frontend had no way to know which models the key could use,
and the fallback chain in `_shared/gemini.ts` ended in two hard-coded ids. Google
retires models without notice — measured during this repair,
`models/gemini-2.5-flash` now answers **404: "no longer available to new users.
Please update your code to use models/gemini-3.8-flash"** — so a chain written
months ago is a silent outage.

**What changed**

| File | Change |
| --- | --- |
| `supabase/functions/_shared/models.ts` *(new)* | Capability registry (`text`, `site`, `code`, `debug`, `reasoning`, `project_modification`, `image`, `pdf`) plus live discovery via the provider's model list, cached 10 minutes. A model is offered only if the provider listed it for this key; an unknown family is given **text only** — never site or code — because guessing would be a false claim. Discovery failure returns an empty list, never an invented one. |
| `supabase/functions/_shared/gemini.ts` | `resolvedModelChain()` appends the discovered models after the configured ones, so a retired primary still leaves working models behind it. An explicit `model` is honoured exactly, never silently swapped. |
| `supabase/functions/ai/index.ts` | New `models` action (answered **before** the quota check — listing models must not spend a credit) returning `{ verified, models, usage }`. `generate` and `revise` accept `model`, refuse an unverified id with `model_unavailable`, and `generate` now returns the real remaining allowance instead of `null`. |
| `server/prelaunch/ai.mjs` *(new)* | The sandbox equivalent, so a pre-launch session sees the same list and the same refusal. |
| `public/js/lib/api.js` | `api.ai.models(capability)`. |
| `public/js/modules/dashboard/builder-core.js` | A model picker populated only from the server's verified list, remembering the choice per browser, and falling back to "Automatic — best available" when the list cannot be verified. |

**Tested** — `tests/prelaunch-ai.test.mjs`, 45 assertions: discovery filters out
embedding/speech/image models for site building; the configured model is marked
recommended; an unknown id is not usable; without a key the list is empty rather
than guessed; a retired model falls through to the configured fallback; a spent
quota maps to `ai_quota_exhausted` (429) and a bad key to `ai_bad_key`; the key
travels as a header and never in a URL.

### 5. The builder could never generate from a pre-launch session

**Root cause.** `server/prelaunch/functions.mjs` answered every builder action
with `501 not_available_prelaunch`. From the owner's own sandbox account,
"Generate" could not succeed at all.

**What changed.** Generation and revision are implemented in the sandbox
(`server/prelaunch/ai.mjs`) against the same contract as the Edge Function: same
house style, same hard technical rules, same JSON output shape, same file
sanitisation, same fallback chain, same provider error translation. Wiring lives
in `server/prelaunch/functions.mjs` (`models`, `generate`, `revise`), with a
monitor record per generation.

### 6. The stuck trace in the builder screenshot

The trace steps are now what the work actually is (reading the brief → writing
HTML/CSS/JS → checking the files → saving the version). While a request is in
flight the UI shows **elapsed seconds**, and after 45 s says so in words. The
Generate button doubles as **Cancel**, which ends the run and states that nothing
was saved. Every failure branch now names its real cause — AI unreachable, no
generations left this cycle, timed out, cancelled — instead of leaving step 2
active indefinitely.

### 7. Export downloaded a `.txt`, not a project

**Root cause.** `downloadFiles()` concatenated every file into one
`text/plain` blob named `…-files.txt`.

**What changed.** `public/js/lib/zip.js` *(new)* writes a real ZIP archive —
local file headers, central directory, end-of-central-directory record, correct
CRC-32 per entry, UTF-8 name flag, deterministic ordering, path hardening
(no absolute paths, no `..`, no drive letters). `builder-core.js` now downloads
`<project>-v<n>.zip` containing the files at their real paths inside a folder.
An empty version reports that there is nothing to export rather than producing a
broken archive.

**Tested** — `tests/zip.test.mjs`, 22 assertions, verified with the system
`unzip`: `unzip -l` lists the archive, `unzip -t` reports **No errors detected**,
and a full extraction round trip returns the original file contents at their
nested paths.

### 8. Assistant history

Conversations were already persisted server-side, but the panel could only list
the 20 most recent and could not rename or delete. `assistant.js` now has: a
search field over titles, explicit loading / empty / no-match / error states,
open-and-continue, rename (`formDialog`), delete (`confirmDialog`, removes the
conversation and its messages), correct `updated_at` ordering, and an explicit
`user_id` filter on every query on top of RLS.

---

## Preview setup (7 Nov 2026)

The preview server was not running at the start of this session — no
`scripts/dev-server.mjs` process existed and nothing was listening on 4173.
Three setup problems were found and repaired while bringing it back:

1. **`SITE_URL` pointed into the sandbox.** `.env` ships
   `SITE_URL=http://localhost:4173`. The server sent that value to every browser,
   including one loading the page from a hosted preview origin — so OAuth
   redirects, email-verification links and canonical URLs all pointed at an
   address that only resolves inside this sandbox. `scripts/dev-server.mjs` now
   treats a loopback `SITE_URL` as a laptop default: when the request arrives on
   a non-loopback host, the request origin is used instead. A real configured
   domain is always honoured, and the production build is untouched.
   Verified: a loopback request still reports `http://localhost:4173`, a request
   with `x-forwarded-host: 4173-abc123.e2b.app` reports
   `https://4173-abc123.e2b.app`.
2. **Dev dependencies were missing after the environment reset**, so `npm test`
   died on `Cannot find package 'esbuild'` and again on `@electric-sql/pglite`.
   Both are dev-only (never shipped, never in `public/`). They are now declared in
   `devDependencies`, and the two suites that need them **skip loudly** — printing
   the exact `npm install` command — instead of reporting a pass that never ran.
3. Confirmed the preview is iframe-friendly (`frame-ancestors *`, no
   `X-Frame-Options`) and that `/js/config/runtime.js` is served `no-store` per
   request, so configuration changes appear without any cache handling.

## Test status

```
summary                          result
-------------------------------- ---------
scripts/check.mjs (static)       ✓ pass (71 modules, 23 pages)
tests/branding.test.mjs          ✓ 14 / 0
tests/session-policy.test.mjs    ✓ 21 / 0
tests/zip.test.mjs               ✓ 22 / 0  (validated by unzip -t)
tests/prelaunch-ai.test.mjs      ✓ 45 / 0
tests/ai-errors.test.mjs         ✓ 56 / 0
tests/admin-authority.test.mjs   ✓ 58 / 0
tests/db-restore.test.mjs        ✓ 17 / 0
tests/migration-verify-sql.test.mjs ✓ 27 / 0
scripts/smoke.mjs                ✓ 23 routes, 4 header checks
-------------------------------- ---------
total                            260 assertions + 23 routes, 0 failures
```

Browser suites (Playwright) cannot run in this environment — no Chromium binary
is available — so nothing in this log claims a browser observation that was not
made. The preview server on port 4173 serves the rebuilt code (`/app/`,
`/js/lib/zip.js`, `/js/modules/dashboard/builder-core.js` all 200).

## External actions required

1. **Deploy the `admin` Edge Function** — fixes the Access page. Its source in
   `supabase/functions/admin/index.ts` already implements `directory`.
2. **Deploy the `ai` Edge Function** — adds the `models` action and model
   selection. Without it, the picker honestly shows "Automatic" only.
3. **Enable the Google provider** in Supabase → Authentication → Providers, and
   add `https://shinzora.in/auth/callback/` (and the local equivalent) to the
   redirect allowlist.
4. **Rotate `GEMINI_API_KEY`** — the key was exposed earlier in this project's
   history and should be treated as compromised.
5. The AI provider's free-tier allowance for this key answered **429** during
   this repair, and `gemini-2.5-flash` is **retired** (404). Neither is a code
   fault; both will clear with a paid tier or a fresh key.

No production deployment, migration or data change has been made.

## Still pending

* Builder: clarifying questions before a large generation, and a
  validate-then-self-fix pass over generated files.
* Builder: reopening an existing project directly into the builder (saving and
  versioning already work).
* Priority 3 — profile photo, password, business profile, preferences, security,
  admin's own profile.
* Priority 4 — GitHub and Vercel OAuth integrations.
* Priority 5 — prompt guidance guide, PWA install, SEO/site files, payment
  accuracy, the 20-workflow end-to-end test list.

---

# Priority 1 — code changes (7 Nov 2026, second pass)

| # | Reported | Actual root cause | Files |
| --- | --- | --- | --- |
| 3 | Finish Setup: "Row Level Security blocked the request" | `onboarding.js` upserted `public.subscriptions`; the signup trigger has already created that row, so the upsert became an INSERT/UPDATE that the table deliberately does not allow (plan changes go through payments). PostgREST returned 403. | `supabase/migrations/0010_subscription_business_link.sql` (new), `public/js/boot/onboarding.js` |
| 4 | Finish button did nothing | Same throw, raised *before* `location.replace`, so the catch branch just repainted an error. A second, independent fault: the paid-plan branch inserted `service_requests.status = 'pending'`, which the CHECK constraint and insert policy both reject. | `public/js/boot/onboarding.js` |
| 9 | Admin treated as a customer | `landingPath()` only routed administrators to `/admin/` when they had **not** completed onboarding — creating a business (which onboarding encourages) sent the same account to `/app/` as a plan customer. | `public/js/lib/store.js`, `public/js/boot/admin.js`, `public/js/modules/dashboard/shell.js` |
| 12 | Sign out slow / never returns | pre-launch sign-out awaited `/api/prelaunch/auth/logout` with no timeout; the redirect went to `/auth/login/`, not the public homepage, so the homepage never returned to Sign in / Get started. | `public/js/lib/guard.js`, `public/js/lib/prelaunch.js`, `public/js/modules/dashboard/shell.js` |
| 5 | Read notifications revert to unread | clicking a notification **with a link** navigated first and returned before the read write ran. | `public/js/modules/dashboard/views/notifications.js`, `public/js/modules/dashboard/shell.js` |
| 10 | "View public site" opens shinzora.in | the link was hard-coded `href="/"`. | `public/app/index.html`, `public/js/modules/dashboard/shell.js`, `public/js/lib/site-url.js` (new) |
| 11 | Homepage ignores auth state | no header module existed; the markup always rendered Sign in + Get started. | `public/js/boot/site-auth.js` (new), `public/index.html`, `public/css/marketing.css` |
| 1 | Confirmation email never arrives | two causes: (a) an already-registered address returns a user object with **no identities** and no email, and the client sent the person to "wait for the email"; (b) provider send failures were shown as generic errors. | `public/js/modules/auth/auth-service.js`, `public/js/lib/supabase.js`, `public/js/boot/auth-verify.js` |
| 2 | Google/PKCE | fixed in the previous pass (`detectSessionInUrl: false`, single exchange, spent-code tolerance). | `public/js/lib/supabase.js`, `public/js/modules/auth/auth-service.js` |
| 13 | Chrome unresponsive | hero typing loop rescheduled itself forever regardless of visibility; hero tilt read `getBoundingClientRect()` on every pointermove; verify-email polled 40× regardless of tab visibility. | `public/js/ui/reveal.js`, `public/js/boot/auth-verify.js` |

## Tests added

```
tests/onboarding-writes.test.mjs   18 assertions — real PostgreSQL (PGlite), real RLS
tests/routing.test.mjs             12 assertions — landingPath + published-site resolution
```

The first suite reproduces the reported 403 as a failing statement *before*
asserting the fix, and proves the new function cannot touch another customer's
row, cannot change plan/status/credits, and refuses an anonymous caller. It also
fails if a future change adds an INSERT/UPDATE policy to `subscriptions`.

## Advanced AI Builder & Marketing Upgrade — first slice (7 Nov 2026)

| Area | Root cause / decision | Files |
|------|----------------------|-------|
| Five stages | The builder was one long form plus a trace of four fixed steps. Replaced by a stage model with required-field gating and a rail the customer can move back through. | `public/js/modules/dashboard/builder/stages.js`, `builder-core.js` |
| Progress bar | The old trace was decorative. Percentage is now computed from completed tasks only, weighted per stage, and cannot reach 100 before the save stage. | `stages.js` (`computeProgress`), `tests/builder-stages.test.mjs` |
| One `index.html` | The model returned multi-file sites; the download could not be opened from disk. Local CSS/JS are inlined, extra pages become routed sections, links rewritten, router installed. | `public/js/lib/single-file.js`, `tests/single-file.test.mjs` |
| Validation | "Preview" claimed nothing. Real checks now run on the exact saved document: broken routes, missing assets, script syntax, viewport, alt text, dead buttons, external hosts. | `public/js/lib/site-validate.js`, `tests/site-validate.test.mjs` |
| Editing | Revision applied to a fresh v1 every time. Now an existing project opens at Preview, revisions are staged, and saving requires a confirmation that names the version. | `builder-core.js` |
| Restore | "Make current" mutated the project. Restore now creates a new version from the old one; nothing is rewritten. | `builder-core.js` |
| Research | No research path existed. `research` action added with Google Search grounding; sources come from grounding metadata; no sources means no research, stated in the UI. | `supabase/functions/ai/index.ts`, `_shared/gemini.ts`, `researchUsable()` |
| Marketing/conversion schema | None existed. 0011 adds five tables, two guard triggers, `notify_admins` and `app_platform_slots`, all under RLS with admin-only transitions. | `supabase/migrations/0011_generation_conversion_marketing.sql`, `tests/marketing-rls.test.mjs` |
| Admin writes | A first pass of 0011 had no admin UPDATE policy, so an admin review would have updated zero rows silently. Caught by the test suite, not by review. | same migration, administrator policy block |
| Package pairing | AAB/IPA were free-form text. A CHECK constraint now refuses `platform='android', target='ipa'` and the reverse. | same migration |
| Backup coverage | The five new tables were missing from `APPLICATION_TABLES`, so a backup would have looked complete and omitted them. | `scripts/lib/supabase-admin.mjs` |

Tests added: `marketing-rls` (52), `single-file` (37), `site-validate` (32),
`builder-stages` (56). Full suite: 479 assertions + 23 routes, green.

## Part 1 verification + Part 2 (7 Nov 2026)

| Area | Root cause / decision | Files |
|------|----------------------|-------|
| Shared navigation | The header sat inside the entry page's route container, so the router hid the menu on every other page. | `public/js/lib/single-file.js` |
| Cross-page fragments | `page.html#section` became `#/page#section`, which is a route that does not exist. The page is kept, the fragment dropped, the count reported. | same |
| Page titles | The entry page had no `data-title`, so returning home left the previous page's title in the tab. | same (`ROUTER`, entry wrapper) |
| Relative links | `<a href="pricing.html">` inside a one-file site was not reported by any check. Now an error (`broken-link`). | `public/js/lib/site-validate.js` |
| Forms on published sites | The published page carried `form-action 'none'`, which silently blocked a working form. The guard is now a caller decision: previews block forms, published pages do not. | `builder-core.js`, `boot/site.js` |
| App output | A package format is now bound to its platform in three places: the option list, the database trigger and the CHECK constraint. | `lib/app-package.js`, `migrations/0012` |
| Fake builds | `status='built'` now requires a path, a byte count and a checksum — enforced for the service role too. | `migrations/0012` |
| Plan limits | Free/Pro may not queue an iOS build; the refusal is in the database, not only in the picker. | `migrations/0012` + 27 assertions |

Tests added: `part1-verification` (51), `app-package` (57), `app-package-rls` (27).
Full suite: 625 assertions + 23 routes, green.
