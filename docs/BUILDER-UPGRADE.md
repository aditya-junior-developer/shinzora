# Shinzora — Advanced AI Builder & Marketing Upgrade

Status of the 21-item order, part by part. Everything below is what is **in the
working tree**, what has been **executed and verified**, and what is **not built
yet**. Nothing has been deployed, no migration has been applied to Supabase, and
no production data has been touched.

Last updated: 7 November 2026.

---

## Part 1 — Website Builder AI (in progress, first slice done)

### 1. The five stages — done

`public/js/modules/dashboard/builder/stages.js` is the single definition used by
both builders:

| # | Stage | Asks for |
|---|-------|----------|
| 1 | Brief | purpose, industry, audience, desired design/function, references |
| 2 | Information | name, description, pages, contact, brand colours, logo, images, launch needs, (Supabase URL + publishable key **only when the brief has a form**), asset upload |
| 3 | Build | seven tasks, each completing on a real event |
| 4 | Preview | interactive preview, every page, desktop/tablet/phone, validation report, "ask the AI for a change" |
| 5 | Save | confirmation, new version, full version history with restore |

Required fields are checked before a stage can be left, and the message names the
field and how short it was — not "something is missing".

### 2. The progress bar measures work, not time — done

`computeProgress()` derives the percentage from the tasks that reported
completion, weighted `brief 2 · information 3 · build 8 · preview 1 · save 1`.

| Task | Completes when |
|------|----------------|
| Reading the brief | the instruction set is built and normalised |
| Planning the structure | the page plan (routes) is computed |
| Generating layouts | the model's response arrives |
| Writing the code | the response's files pass the sanitiser |
| Adding assets | CSS/JS are inlined and uploaded images embedded as data URIs |
| Checking responsiveness | the document is measured (viewport, media queries, fluid units) |
| Validating | the real validation report has run |

Elapsed time is shown beside the task, so a long model call looks like a long
model call. The bar cannot reach 100% before the last stage is finished, and a
stage that has not reported is not credited. Covered by 21 assertions in
`tests/builder-stages.test.mjs`.

### 3. Exactly one `index.html` — done

`public/js/lib/single-file.js` converts whatever the model returns into the
promised shape:

- local stylesheets and scripts inlined, once each, in order
- every extra HTML page becomes `<section data-route="/about" data-title="About">`
  inside the entry document
- every internal link rewritten to the hash route that now owns that page
  (`href="#/about"`), external/mailto/tel links untouched
- a dependency-free router installed, with `hashchange`, active-link marking,
  `aria-current` and `document.title`
- a missing viewport meta added, and said out loud
- a download named `<project>.html` containing the whole site

Verified by 37 assertions in `tests/single-file.test.mjs`, including "no local
`.css`/`.js`/`.html` reference survives", so the file opens from disk.

### 4. Preview and validation — done

`public/js/lib/site-validate.js` inspects the exact document that would be saved:

| Check | Level |
|-------|-------|
| link to a route no page answers | error |
| anchor with no matching id | warning |
| relative image/asset in a one-file site | error |
| inline script that does not parse (`new Function`, never executed) | error |
| no viewport meta · planned page missing | error |
| no `<h1>` · `<img>` without alt · missing `lang` · missing doctype · dead buttons · form without labels | warning |
| remote hosts that need a connection · no CSS · no navigation between pages | info |

32 assertions in `tests/site-validate.test.mjs`, each fault tested on a document
that has it and on one that does not. An empty document fails; it does not pass
by default.

### 5. Editing an existing project — done

Opening `?id=<project>` loads the project and its versions, shows the current
version, and starts at **Preview** — nothing is regenerated. A change is applied
with `ai.revise`, re-embedded, re-validated and shown in the preview. It stays
staged until the save stage's confirmation dialog; the previous version is only
replaced by a *new* version.

### 6. Version history and restore — done

Saving inserts version `n+1`; earlier versions are untouched. Restoring a version
**creates a new version from it** (`prompt: "Restored from version N"`,
`meta.restored_from`) instead of rewriting history. Download and restore are per
version.

### 7. Web research with sources — server side written, not deployed

- `supabase/functions/_shared/gemini.ts` → `geminiGrounded()`: Gemini with Google
  Search grounding. Sources come from the provider's own
  `groundingMetadata.groundingChunks`; nothing is composed from the prompt.
- `supabase/functions/ai/index.ts` → `action: "research"`: returns
  `{ summary, patterns, sections, sources, grounded }`, records the job in
  `ai_generation_jobs` (kind `research`) with its sources in `meta`, and
  **`grounded: false` when there are no citations**.
- `researchUsable()` (client) refuses research with no `http(s)` source; the
  builder then builds from the brief alone and says so. Sources are shown in
  stage 2 and again on the preview stage, and stored in the version's `meta`.

This needs an Edge Function deploy before it can answer anything; until then the
UI reports "research unavailable" and continues.

---

## Database (0011) — written, executed in a real PostgreSQL, **not applied**

`supabase/migrations/0011_generation_conversion_marketing.sql`

| Object | Purpose |
|--------|---------|
| `ai_generation_jobs` | one row per generation/research attempt, five-stage record, progress 0–100 |
| `conversion_jobs` | HTML → APK/AAB/IPA; no client UPDATE policy, so a browser cannot set `status='built'` |
| `marketing_accounts` | handles, public profile URLs, self-reported details; **no credential-shaped column exists** |
| `marketing_requests` | campaign requests with `MR-YYMMDD-XXXXXX` reference, status machine, admin-only decisions |
| `marketing_request_events` | timeline; internal notes hidden from the customer by RLS |
| `notify_admins()` | SECURITY DEFINER, one notification per admin, anonymous callers refused |
| `app_platform_slots()` | Free/Pro = 1 platform, Enterprise = 2; entitlement only, EXECUTE revoked from `anon` |

Verified by **52 assertions** in `tests/marketing-rls.test.mjs`, run against
PGlite with real RLS and real grants: cross-tenant writes refused, self-approval
refused with `42501`, self-verification refused, customer cannot write review
fields, internal notes invisible, support role not notified, iOS/Android package
pairing enforced by a CHECK constraint, plan not writable by any client role.

The migration runner now verifies 0011 (`scripts/apply-migrations.mjs`) with six
objective checks plus an invariant, and the backup table list covers all 40
tables the migrations create (`scripts/check.mjs` fails if one is missing).

---

## Test status

```
check.mjs                All static checks passed (11 migrations, 40 tables, 76 modules, 23 pages)
branding                 14    session-policy        21    zip                22
prelaunch-ai             45    routing               12    onboarding-writes  18
ai-errors                56    admin-authority       58    db-restore         17
migration-verify-sql     39    marketing-rls         52    single-file        37
site-validate            32    builder-stages        56    smoke: 23 routes + 4 header checks
```

479 assertions, all green, plus an esbuild bundle of both builder views and
`boot/site.js` (every import resolves, every named export exists).

---

## Not built yet (next, in the order the order gives)

1. **Part 2 — App Builder**: the mobile-only frame is in place (preview defaults
   to phone, desktop frame refused, `mobileOnly` sent to the server), the
   platform picker is entitlement-gated from `app_platform_slots()`, and the
   package pairing is enforced in the database. Still missing: the HTML→app
   conversion platform (WebView wrapper build, icon/splash, permissions,
   validation, signing), and its Edge Function — which cannot produce a real APK
   without an Android toolchain and a keystore, and cannot produce an IPA
   without an Apple Developer certificate and provisioning profile.
2. **Part 3 — Marketing**: rename the Growth section to "Request for Extra
   Service", account connections, the Meta/Google request form, the admin review
   area and status machine. The database for all of it is written and tested.
3. **Part 4/5**: mobile layout pass over the builder, and the end-to-end flow
   test that clicks through the five stages.

## Credentials this work will need

| What | Where it goes | Why |
|------|---------------|-----|
| `GEMINI_API_KEY` | Edge Function secret `ai` | every generation, revision and the new research action |
| Android keystore + alias/passwords | server-side secret only | signing an APK/AAB; never in the browser |
| Apple Developer team, distribution certificate, provisioning profile | server-side secret only | an IPA cannot be signed without them |
| Meta app (Instagram/Facebook) client ID + secret | server-side secret | official OAuth for account connections |
| Google Ads / Google OAuth client ID + secret | server-side secret | official OAuth; Search campaigns are a Google Ads type, not a social account |

No password is collected for any provider at any point.

---

## Part 1 verification round (7 Nov 2026, second pass)

A four-page fixture — `index.html`, `about.html`, `services.html`,
`contact.html`, `assets/styles.css`, `assets/app.js`, two embedded images and a
real form — was pushed through the whole pipeline in
`tests/part1-verification.test.mjs` (51 assertions): collapse → validate →
download → **the emitted router executed** against a DOM shim, page by page.

**Four real faults were found and fixed:**

| Fault | Effect before the fix | Fix |
|-------|----------------------|-----|
| The shared header lived inside the entry page's route container | the menu vanished on every other page once the router hid the entry page | headers/navs are lifted above the routed content, and other pages no longer repeat them |
| `page.html#section` became `#/page#section` | a link to a route that does not exist — the validator flagged it, and the click went nowhere | the page is kept and the section is dropped; the count is reported as a warning |
| the entry page had no `data-title` | after visiting any subpage, going home left the browser tab showing the subpage's title | the entry wrapper carries its own title and the router restores it |
| `<a href="pricing.html">` was invisible to the validator | a link to a file that does not exist passed as "no problems found" | relative `<a href>` is now an error (`broken-link`); a `#/route` to nowhere stays `broken-route` |

Also fixed: the published-site CSP no longer carries `form-action 'none'`
(sandboxed previews still do), because a working form was being silently blocked
on the live site the moment forms became a feature.

**Progress semantics, re-checked:** every task complete but nothing saved is
**93%**, `done === false`; only a completed save reaches 100%. Entering the build
stage credits none of its tasks, and the value is monotonic as tasks complete.

---

## Part 2 — App Builder

Built on the same five stages, the same single-file engine and the same
validation report. What is specific to an app:

### Mobile-only, measured not asserted

`public/js/lib/app-package.js` → `validateMobileApp()` checks the generated
document itself: `width=device-width`, no fixed widths above 480px, responsive
rules present, touch handling present, pinch-zoom not disabled, more than one
screen, and screens actually reachable. Findings join the same validation report
the website builder shows — one list, not two.

### Formats are tied to platforms

| Option | Platform | Extension |
|--------|----------|-----------|
| Android APK | android | `.apk` |
| Android AAB | android | `.aab` |
| iOS IPA | ios | `.ipa` |

There is no iOS AAB and no Android IPA anywhere in the code, the database or the
tests. Stage 2 asks for the package explicitly, plus the package id (reverse-DNS,
validated) and the icon.

### Plan limits, enforced in the database

`supabase/migrations/0012_app_package_enforcement.sql`:

- `app_target_allowed(platform, target, user)` — the pairing is absolute; iOS
  additionally requires two platform slots.
- `app_package_options(user)` — the per-format answer the UI reads, so the
  picker and the server cannot disagree.
- `conversion_jobs_guard` — refuses a client insert that is not `queued`, a wrong
  pairing, an iOS request from a one-platform plan, a malformed package id and a
  blank app name.
- **`status = 'built'` requires `artifact_path`, `artifact_bytes` and
  `artifact_sha256`** — for the service role too. A job cannot claim a package
  that does not exist.
- one open request per project per format, so a double click cannot queue twice.

Verified by 27 assertions in `tests/app-package-rls.test.mjs`, attacking each
rule directly: iOS AAB refused, Android IPA refused, Free/Pro refused an IPA,
Enterprise allowed all three, client self-promotion to `built` refused, a
hollow `built` refused even as the service role, and a successful save of a
whole version plus interpreted status text.

### What the UI will and will not say

`describeConversionJob()` is the only place a build state becomes a sentence:
`queued`, `running`, `awaiting_toolchain`, `built`, `failed`, `expired`. A
download button only appears when the row has a path **and** a checksum. A
`built` row without a file is described as a fault, not a build. A waiting IPA
names the macOS host, the Apple Developer team, the certificate and the
provisioning profile; a waiting APK names the JDK/SDK, the wrapper project and
the keystore.

Nothing was deployed, no migration applied, no package produced.
