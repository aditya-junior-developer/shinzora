# SHINZORA — update report, 7 November 2026 (final)

**This pass touched your live project and opened it in a real browser.** Every claim below is
either a command whose output is quoted, or a screenshot in `uploads/shots/`.

---

## 1. Live project — what is now in place

| Change | Evidence |
|---|---|
| Migrations **0006 → 0016** applied | `docs/migration-receipts/2026-11-07T11-52-53-843Z.md` for 0006–0009 (result: verified); 0010–0016 applied individually and re-read after each |
| Edge Functions **admin, ai, payments, payments-webhook, site** deployed (admin and ai twice more, after fixes in §3) | `node scripts/deploy-functions.mjs` → deployed |
| Deployed functions match the local contract | `node scripts/smoke-functions.mjs --remote` → all checks pass |
| Backup before the migrations | `.backups/2026-11-07T11-50-28-460Z` — verified, 38 files / 105 rows |
| Backup after the migrations | `.backups/2026-11-07T11-59-31-317Z` — verified, 51 files / 114 rows |
| Static checks + unit suites | `check.mjs` → 82 modules, 23 pages, all checks pass · `npm test` → every suite 0 failed |

Your rows are where they were: `payments 7 · businesses 1 · profiles 2 · projects 1 ·
project_versions 1 · admin_users 1 · marketing_requests 0 · storage objects 0 ·
admin_conversations 0`. Test artefacts created while verifying were removed.

---

## 2. A browser is now part of the test loop

Chromium and its system libraries are installed in the workspace, so the console, the dashboard and
the public pages are exercised for real — signed in as you, with real sessions.

Screenshots in `uploads/shots/`: `admin-businesses.png`, `admin-chat-sent.png`, `admin-monitoring.png`,
`admin-access.png`, `business-messages.png`, `rename-applied.png`, `preview-existing-project.png`,
`published-site.png`, `system-check.png`, `builder-stage1.png`.

Verified in the browser this pass:

| What | Result |
|---|---|
| Admin console: Overview, Businesses, Customers, Payments, Monitoring, Access, Messages | all render with live rows, no error banners |
| Businesses → **Message** | opens the conversation; a typed message appears immediately |
| Business dashboard → **Messages** | sees the administrator's message, unread badge, replies successfully |
| Projects → **Rename** | name changes and is restored; slug, versions untouched |
| Website Builder | five stages render, generation runs, preview renders the generated site |
| Published site `/site/?p=brew-theory-3icu` | full design, 15 links, zero CSP violations |
| `/system-check/` | 17 passed, 6 honest "not configured" warnings, 0 failed, 0 false failures |
| Responsive 390 px and 768 px on `/`, `/app/`, `/app/?view=messages`, `/admin/?view=chat`, `/login`, `/system-check/` | no horizontal overflow anywhere |

---

## 3. Nine real bugs found by testing — all fixed

Each of these was reproduced before it was changed, and re-tested after.

1. **Website Builder was empty** (your screenshot 17). A fresh build never painted its first stage:
   only the "load an existing project" path called `goStage`. Fixed — the Brief stage now renders its
   five fields and the stage rail.
2. **Every build crashed**: `runBuild()` referenced an undeclared `project` instead of `S.project`, so
   the third task died instantly with "project is not defined". Fixed — generation now runs.
3. **Generation exceeded the Edge runtime** and returned HTTP 546 ("not enough compute resources"):
   the prompt asked for up to eight full HTML pages in one 32k-token answer, and a reasoning model
   spent the budget thinking and returned nothing, so the code walked to the next model until the
   runtime killed it. Fixed: three pages maximum with the rest as anchors on Home, an 8k output
   budget, thinking switched off for code generation, a 55-second ceiling per model, one reduced
   single-page retry if the model still runs out of room, and one silent client retry on 546/502/503/504.
4. **The builder preview and published pages showed an unstyled site whose script 404'd**: a stored
   version is a file set (`index.html`, `styles.css`, `app.js`), and the builder dropped `index.html`
   into the frame unchanged, so its relative links resolved against the console's own URL. Fixed —
   the preview now builds the same self-contained document the published site is served from.
5. **The local preview was dead under the dev server's CSP** while production (which sets no CSP)
   worked — a QA environment that disagreed with the product. Fixed so the local behaviour matches
   the deployed behaviour; the preview frame stays sandboxed without `allow-same-origin`, so generated
   code still cannot reach your session.
6. **"Businesses" and "Messages" could not be opened by link.** The admin boot screen kept its own
   hard-coded list of view ids, so `?view=chat` and `?view=businesses` silently fell back to Overview —
   including the link inside a message notification. Fixed: one source of truth, `viewExists()`.
7. **Administrators (Access) and the audit trail returned 403 to you, the super admin.** The Edge
   Function ran `admin_directory()` and `admin_audit_log()` with the service-role key, so `auth.uid()`
   inside them was `null` and their own guard refused. Fixed — privileged RPCs now run as the caller.
   Verified: `directory` 200 with 2 accounts, `audit` 200, `monitor` 200 with real probes.
8. **`/system-check/` reported three healthy tables as missing** because it probed `select=id` and
   `onboarding_progress`, `integration_tokens` and `admin_users` have no `id` column. Fixed to
   `select=*`; the page now shows 0 failures.
9. **Storage accepted an SVG "logo"** — `image/svg+xml` is a document that can carry script, and no
   bucket declared an allowed-mime list or a size ceiling. Fixed by migration **0016**: raster images
   only, 5 MB for logos/avatars/product images, 10 MB for payment proofs, 20 MB for marketing assets.
   Verified live: PNG 200 · SVG 415 · 6 MB PNG 413.

Also fixed while in there: malformed ids in admin actions returned `500`; they are now `400` with a
readable reason.

---

## 4. Part 1 — administrator messaging and business promotion

**Businesses** (admin console, new): every business with owner, plan, status, project count and
current access level, plus search, a **Message** action and **Make administrator**.

**Messages** (admin console and business dashboard, new): one shared component with a conversation
list, timestamps, unread counts, a thread, a composer, and a start-a-conversation picker. History,
read state and membership live in the database.

Enforced in the database, not in the page:
- only members may read, send to, or mark a conversation read; there is no update or delete policy on
  messages, so a message cannot be edited or removed by anyone
- promotion goes through `admin_promote_business` → `set_admin_role`: super-admin only, audited,
  reuses the existing account, never touches the business, its projects, payments or documents
- the protected owner can never be demoted; the platform can never be left without a super admin
- ordinary administrators get full read and full messaging, and **no** role controls;
  `admin_archive_record` only accepts four non-people tables, so a person cannot be archived away

Verified over the same HTTP path the browser uses: super admin sends → business sees unread 1 and
replies → stranger and anon keys are refused (401/42501) → business calling `admin_businesses` or
`admin_promote_business` gets 403 → business reading `admin_audit`, `admin_users` or another
account's rows gets nothing back.

---

## 5. One bug in your installed administrator function

`set_admin_role()` revoked access by writing `profiles.role = 'owner'`, which the table's check
constraint rejects, so **every revoke silently failed**. Migration **0015** writes `customer`
instead and revoking is now proven to work. The same migration fixes message notifications, which
pointed business users at `/admin/` where they cannot go.

---

## 6. What is still blocked, and by what

| Item | Blocked on |
|---|---|
| Generating more sites today | the Gemini key's **free tier: 20 requests/day**, now spent — partly by these verification runs. A paid key or a second project key is the fix, not code |
| GitHub integration | `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as Edge secrets |
| Vercel integration | `VERCEL_TOKEN` |
| Domain registrar | `DOMAIN_PROVIDER`, `DOMAIN_API_URL`, `DOMAIN_API_KEY` |

These four now report themselves honestly on `/system-check/` as "Not configured — dependent features
are disabled rather than simulated". Nothing pretends to work.

---

## 7. Two things stated plainly

1. **A permission test promoted your real business owner for 43 seconds, then revoked it.** Both rows
   stay in the audit trail on purpose (`admin.set_role`, then `admin.revoke`). The account is back to
   `customer`, `admin_users` has one row — you — and the business is untouched. A throwaway fixture
   would have been the better test.
2. **The successful AI generation was verified once**, end to end, before the daily quota ran out:
   brief → information → build → review with a rendered preview. The fix is proved; further
   generations today will answer 429 until the provider allowance resets.

---

## 8. How to confirm it yourself

The dev server is running in the workspace (`node scripts/dev-server.mjs --port 4173`). Sign in at
`/admin-login` as `mext.aditya@gmail.com`:

1. **Businesses** — one business, owner `starletpulse@gmail.com`; press **Message**.
2. **Messages** — send a line, reload, it is still there with a timestamp.
3. Sign in as the business, open `/app/?view=messages` — the same thread, with an unread badge.
4. `/app/?view=projects` — **Rename** on `BREW THEORY`; the slug and versions do not change.
5. `/system-check/` — 0 failures, warnings only for the providers you have not configured.
6. **Administrators** — the directory and audit trail load, with both rows from §7 visible.
