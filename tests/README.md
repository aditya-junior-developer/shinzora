# Tests

There is no test framework here on purpose — the project has no dependencies and no build step, and adding Vitest or
Playwright would mean shipping a lockfile that changes the supply-chain story.

What exists instead:

| Command | File | Coverage |
| --- | --- | --- |
| `npm run check` | `scripts/check.mjs` | Parse every module; resolve every import and named export; verify HTML asset references; scan for secrets; verify CSS cascade order; verify migration files |
| `npm test` | `scripts/check.mjs` + `scripts/smoke.mjs` | Everything above, plus a real server on port 4199: 22 routes, page markers, security headers, 404 behaviour, `noindex` on `/admin/` |

The manual walkthrough — the part that needs a session, a database and provider credentials — is
[`docs/TESTING.md`](../docs/TESTING.md) §3.

## Adding browser tests

Playwright works against the dev server without any project changes:

```bash
npm run dev                     # terminal 1
npx playwright test             # terminal 2, after `npx playwright install chromium`
```

Write assertions against the markers the smoke test already relies on, and keep authenticated flows behind a fixture that
creates its own account through the Supabase Auth API — never commit a session token.

## What cannot be tested without credentials

- Account creation, verification email delivery, login, password reset, Google sign-in
- Any dashboard view with real rows
- AI chat and generation (needs `GEMINI_API_KEY`)
- Payments, approvals and webhooks (needs `UPI_ID` or Razorpay keys)
- Domain ordering (needs a registrar)
- GitHub pushes and Vercel deployments (needs OAuth/tokens)

Deploy first, then open `/system-check/` while signed in: it converts the list above into live pass/warn/fail results for
your own project.

---

## Browser harness (`tests/browser/`)

Two Playwright scripts, kept out of `npm test` because they need a Chromium download. Run them before shipping UI
changes; they caught the kinds of defect that static checks cannot see (a header that pushed the page sideways at
320px, an offline page whose script was blocked by the app's own CSP, a `/site/` route that read an IP address as a
subdomain).

```bash
npm run dev &                                    # http://localhost:4173
npm i -D playwright-core && npx playwright install chromium

npm run test:browser    # tests/browser/flows.mjs  — 32 behavioural checks
npm run test:layout     # tests/browser/sweep.mjs  — 16 public routes × 3 widths
npm run test:visual     # tests/browser/visual.mjs — 32 render/FX checks
npm run test:shell      # tests/browser/shell.mjs  — 20 signed-in shell checks
npm run test:admin      # tests/browser/admin.mjs  — 29 admin console checks

npm run test:fn-unit    # deno test — 14 Gemini client tests (no key, no network)
DENO=$(command -v deno) npm run test:functions   # boots all 8 Edge Functions
npm run verify:deploy   # serves public/ through vercel.json's rules
```

`flows.mjs` asserts: landing-page sections exist and are reachable from the nav, anchors actually scroll, every icon
name resolves to real geometry (an unknown name silently renders a "?"), images have alt text, there is exactly one
`h1`, no horizontal overflow at 390px, the mobile menu opens and contains the new links, `/app/` `/admin/`
`/onboarding/` do not expose anything to a signed-out visitor, every auth page renders, a wrong password shows a real
error and does not navigate, and `/system-check/` reports the schema-compatibility result.

`sweep.mjs` loads every public route at 360/768/1440px and fails on horizontal overflow or a page error. Edge Function
CORS failures are expected until the functions are deployed — they are reported as environment, not as band failures.

`visual.mjs` needs a renderer rather than a DOM: it asserts the hero stage layers exist and animate, the particle canvas
actually lights pixels on a capable device, the scene pauses off-screen, `prefers-reduced-motion` and low-core devices
fall back to a static stage, the header gains its glass state on scroll, the install panel opens/closes with Escape and
restores focus and scroll position, primary CTA labels are not covered by an overlay, and nothing overflows at 390px.
Screenshots go to `$SHOTS` (default `/tmp/shinzora-shots`).

`shell.mjs` renders the signed-in surfaces, which normally need a session. It does **not** mock the app: it seeds a
syntactically valid local session and answers Supabase REST from a fixed fixture, so the real boot, guard, router and
view code runs. Nothing is written to any database. It covers the sidebar scroll region (Billing and Settings must be
reachable at 700px tall), the phone-width search that collapses to an icon and expands on tap, the opaque results
popover, and onboarding label/description stacking.

Two behaviours are environment-dependent and are expected, not failures:

- low-core CI machines set `html.fx-low-power`, so the particle canvas stays small; the painted-pixel assertion only
  runs in a context that spoofs `hardwareConcurrency` and `deviceMemory` to 8
- headless Chromium never fires `beforeinstallprompt`, so the install panel correctly offers **Show me the steps**
  (the manual-instruction fallback) instead of a native prompt

Screenshots from `flows.mjs` are written to `/tmp/qa/` when run from that directory; adjust the paths if you want them
kept.
