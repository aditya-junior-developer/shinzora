# Testing

Two kinds of proof, kept separate: what a machine verified in this build, and what needs a live project and a session.

---

## 1. Automated

```bash
npm run check      # static integrity
npm run test:unit  # behavioural unit tests (no browser, no network)
npm test           # check + unit + route/header smoke
```

### `npm run check`

1. Parses every JavaScript module (`node --check`, ES-module mode).
2. Resolves every relative import and verifies each named import exists as an export in the target module.
3. Rejects any non-relative import — the frontend must stay dependency-free.
4. Checks every `<link href>` and `<script src>` in every HTML file resolves inside `public/`.
5. Scans `public/` for secret-shaped strings (Google API keys, `service_role` assignments, Razorpay live secrets, private
   key blocks, `GEMINI_API_KEY=`).
6. Verifies the CSS cascade order per surface (`tokens → components → …`), which is what keeps shared shell rules from
   being overridden by page styles.
7. Confirms the migration files exist in order.

### `npm run test:unit` — `tests/branding.test.mjs`

Imports the **real** builder module in Node (it has no module-scope DOM dependency) and asserts the published-site
branding contract:

- a Free-plan build contains the "Made with Shinzora" badge, inside `<body>`;
- a Pro/Enterprise build is byte-identical to an unbranded build;
- nothing is injected unless the caller asks for it;
- the badge carries inline styles and `rel="noopener"` (it has to render inside a sandboxed iframe with no network);
- CSS inlining and the sandbox CSP guard still apply to a branded document;
- `brandingRemovable()` follows the subscription, and a missing subscription resolves to Free.

### `npm test` (adds `scripts/smoke.mjs`)

Starts the dev server on port 4199 and asserts:

- 22 routes return 200 **and** contain a marker unique to the real page (so a 200 from the 404 fallback fails the test);
- `/app/` and `/admin/` carry a `Content-Security-Policy` with `default-src` and `X-Content-Type-Options: nosniff`;
- an unknown route returns 404 rather than crashing;
- `/admin/` is `noindex`.

That is hosting-level coverage. It does not authenticate.

---

## 2. Verified in this build

Executed in a headless Chromium at 1440 × 900 and 390 × 844:

| Check | Result |
| --- | --- |
| Landing page, all sections, progressive scroll | Renders, no console errors |
| Auth: login, signup, verify, forgot, reset, callback | Render, no console errors |
| Onboarding wizard | Renders; unauthenticated visit redirects with `?next=` preserved |
| Dashboard shell `/app/` | Guard redirects to login when signed out — no flash of content |
| Admin console `/admin/` | Gate renders; **a real sign-in attempt with wrong credentials shows the provider's error and leaves the shell hidden**; no page errors |
| Install page | Renders, platform tabs switch, `beforeinstallprompt` wiring present |
| System check | Runs 23 live checks against Supabase; correctly reports missing tables/RPCs and undeployed functions |
| Legal pages (4) | Render, table of contents anchors resolve, no console errors |
| `/site/?p=` with no slug | Renders the slug prompt; unknown slug path handled by the function's 404 |
| PWA manifest + service worker | Served, icons resolve, manifest parses |
| Static integrity + routes + headers | `npm run check` and `npm test` both pass |

Not executed, and therefore **not claimed as working**: any flow that requires a confirmed account. That includes
signup confirmation email delivery, login, onboarding autosave, every dashboard view with data, AI generation, payments,
domain ordering, GitHub/Vercel work and admin approvals. Those paths are implemented and code-reviewed, and
`/system-check/` measures the infrastructure they depend on — but they need credentials this environment did not have.

---

## 3. Manual walkthrough

Run this after deploying, signed in as a real account. Tick each line; if something fails, note the console error and the
network response.

### Account

1. Sign up with a new email → verification screen appears.
2. Open the email → link returns to `/auth/verify-email/` and confirms.
3. Sign in → onboarding opens.
4. Reload mid-onboarding → the saved step and answers restore.
5. Complete onboarding → dashboard opens; `profiles`, `businesses`, `subscriptions`, `onboarding_progress` all have rows.
6. Sign out → `/app/` redirects to login with `?next=%2Fapp%2F`.
7. Forgot password → email arrives → reset link → new password works.
8. (If configured) Google sign-in → returns through `/auth/callback/`.

### Assistant

9. Ask "what should I sell first given my business?" → the answer references your saved business profile, not placeholders.
10. Reload → the conversation is still listed and its messages load.
11. Send 3 messages quickly → no duplicate conversations, no dropped messages.
12. Check `ai_usage_log` → one row per call.

### Builder

13. Website builder: brief → generate → four-step trace completes → preview renders inside the sandbox.
14. In devtools, run `parent.document` inside the preview frame → it must fail (sandbox has no `allow-same-origin`).
15. Request a revision ("make the hero calmer, remove the pricing section") → new version number, old version still listed.
16. Restore the previous version → preview updates.
17. Publish with a slug → `/site/?p=<slug>` serves it; an unpublished project returns "not published".
18. App builder: generate → interactive view responds to clicks in the preview.

### Commerce

19. Add a product with stock 3 → appears in Inventory and in the storefront checklist.
20. Record an order → appears in Orders, appears on the Dashboard overview, updates Analytics.
21. Advance the order to shipped → status persists after reload.
22. Add a customer → visible in Customers with a computed lifetime value.

### Money

23. Billing → create a Pro payment → QR (or the "provider not configured" notice) appears with the exact amount.
24. Pay, submit the UTR → status becomes **awaiting verification** and the message reads exactly
   "Your payment is awaiting verification. We will notify you once it is confirmed."
25. **Close the modal without submitting** → reload → the payment is still `pending`. Nothing was marked paid.
26. As the administrator, approve it in `/admin/?view=payments` → the customer's plan changes, a notification appears,
    `verified_by` is recorded.
27. Reject a second payment → customer notified, nothing activated.
28. (If Razorpay configured) pay via provider → the webhook flips the status, and a forged signature is rejected.

### Domains

29. Without a registrar: search shows "registrar not connected", no invented prices.
30. With one: search returns live availability; create an order; the price shown is the registrar's.

### Admin

31. Non-admin account signing in at `/admin/` → refused with the provider's error, shell stays hidden.
32. Attempt `insert into admin_users` from the browser console with your own JWT → refused.
33. Customers list shows name, email, phone, business, category, plan, onboarding state, join date.
34. Search and plan filter narrow the list.
35. Open a customer → projects, payments, tickets, service requests, activity all listed.
36. Send an announcement to one account → it appears in that account's notification centre; another account does not see it.
37. Support: reply to a ticket → the customer is notified, ticket moves to pending.

### PWA and responsiveness

38. Visit `/install/` on Android Chrome → prompt or clear manual steps; installed app opens standalone.
39. iOS Safari → Add to Home Screen instructions are correct.
40. 390 px: sidebar becomes a drawer, tables scroll horizontally, no horizontal page overflow, tap targets ≥ 40 px.
41. Turn the network off → `offline.html` appears; turning it back on restores the app.
42. Run Lighthouse → check Accessibility and PWA badges; fix anything under 90.

### Security spot checks

43. `/system-check/` while signed in → "Payments are not client-writable" and "Self-promotion to admin refused" both pass.
44. `curl` the REST API with the publishable key and no JWT against `profiles` → empty array, not rows.
45. `curl` the `ai` function without an `Authorization` header → 401.
46. Search the built site for `AIza`, `service_role`, `rzp_` → no matches (also covered by `npm run check`).

### Schema compatibility (0005)

47. On a database that was migrated from the early schema, `/system-check/` shows **Schema compatibility (0005)** as
    failing, listing `current_step is still text`, `data is missing`, `body / read_at are missing` and the missing
    quota columns.
48. Run `0005_schema_compat.sql`. It prints a summary notice ending with the resulting `current_step` type and any
    constraint it could not add. Re-run it — every count should be `0` the second time.
49. `/system-check/` now shows the same line as passing.
50. Open onboarding for a user who started it on the old schema: their answers are present (copied from `answers`) and
    the wizard resumes at their stored step.
51. `select * from public.notifications` still shows the old `message`/`is_read` values alongside the new `body`/`read_at`.

### Branding on published sites

52. On Free, generate and publish a site → `/site/?p=<slug>` shows the "Made with Shinzora" badge, and the builder
    preview showed the same badge.
53. Switch the account to Pro (admin panel → subscription) and reload → the badge is gone on both preview and
    published page. The decision is made by the `site` function from the owner's subscription row, not by the browser.
54. On Free, the builder's Publish card explains the badge instead of hiding it.

---

## 4. Regression habit

Before shipping a change:

```bash
npm run check && npm test
```

Then re-run the three or four manual steps closest to what you touched. Deleting a column, renaming a CSS token or
changing an Edge Function payload will be caught by `check`; a broken interaction will not.

## 5. Visual pass — automated

`tests/browser/visual.mjs` drives a real Chromium against `npm run dev` and asserts the things a static check cannot
see: hero layers actually paint, the particle canvas lights pixels on a capable device, the scene pauses when it is
scrolled away, `prefers-reduced-motion` and low-core devices fall back to a static stage, the header gains its glass
state on scroll, the install panel opens/closes with Escape and restores focus and scroll, and nothing overflows at
390 px.

```bash
BASE=http://127.0.0.1:4173 node tests/browser/visual.mjs   # 32 assertions
```

Two behaviours in that suite are deliberately environment-aware and should not be "fixed":

- The sandbox that runs CI reports `hardwareConcurrency: 2`, so `html.fx-low-power` is the **expected** state and the
  canvas stays small. The enabled path asserts paint only when the context spoofs `hardwareConcurrency`/`deviceMemory`
  to 8.
- `promptInstall()` returns `unavailable` in headless Chromium (no `beforeinstallprompt`), so the panel correctly shows
  **Show me the steps** instead of **Install now**. The manual-instruction tab is the tested fallback.

## 6. Dashboard shell — regression checks worth repeating

These three were real defects found by driving the shell in a browser, and each has a cheap manual check:

48. **Sidebar scrolls.** Set the window to 700 px tall, open `/app/`, scroll the sidebar to the bottom → Billing and
    Settings are reachable and the AI-usage card never sits on top of a link. (Cause: `.sidebar-scroll` is a flex child
    and needs `min-height: 0` or it refuses to shrink below its content and gets clipped by the sidebar's
    `overflow: hidden`.)
49. **Search expands on a phone.** At 390 px the topbar search is a 38 px icon; tapping it expands it across the bar and
    the results popover is opaque. (Cause: the popover sits inside the topbar's `backdrop-filter`, which means its own
    `backdrop-filter` cannot blur anything — a translucent fill let page headings ghost through.)
50. **Label and description never run together.** On `/onboarding/` the step list and the choice cards must read
    "Your profile" / "Name, phone, photo" on separate lines. Any `*-desc`/`*-label` pair styled inline loses its
    `margin-top` and collides with its label; `display: block` is required.

## 7. Build path guard

`npm run check` now asserts that the runtime-config URL in the HTML, in `scripts/generate-config.mjs` and in
`scripts/dev-server.mjs` are the same path. A mismatch is invisible in development (the dev server injects the config
per request) and fatal in production (pages 404 the config and boot with an empty Supabase URL). Reproduce the real
thing with:

```bash
npm run build
(cd public && python3 -m http.server 4199)   # plain static host, no dev server
curl -s http://127.0.0.1:4199/js/config/runtime.js | grep SUPABASE_URL
```

## 8. Admin console — `npm run test:admin`

The console is the one surface that needs a deployed `admin` Edge Function *and* an `admin_users` row before it will
render, so `tests/browser/admin.mjs` stubs that single endpoint and drives the real console against fixtures. Nothing
is written anywhere.

It proves the access rule first (a signed-in non-admin never sees `#admin-shell`), then walks all eleven views and
every privileged mutation, asserting the action and payload each one sends:

| Interaction | Expected call |
| --- | --- |
| Approve a payment (requires typing `APPROVE`) | `payment_review` `{ paymentId, decision: "approve", note }` |
| Advance a service request | `service_request_update` `{ id, status, note }` |
| Change a subscription plan | `subscription_update` `{ userId, plan, status }` |
| Reply to a support ticket | `ticket_reply` `{ ticketId, body }` |
| Send an announcement (confirm dialog) | `announcement_create` `{ title, body, audience }` |
| Search customers | `customers` `{ search }` |

It also checks that a failing function surfaces `Database unavailable (simulated).` in the table instead of stale or
blank rows, that no control anywhere promotes the signed-in user to administrator, and that the drawer works at 390 px
with no horizontal overflow.

Two real defects came out of writing it, both fixed:

1. `sb.rpc("admin_role").catch(...)` in `public/js/modules/admin/api.js` — a Supabase query builder is thenable but has
   no `.catch`, so `checkAdmin()` threw a `TypeError` and **the console could never open for anyone**, administrator or
   not. Wrapped in `Promise.resolve(...)`.
2. `service_requests.details` is JSONB, so it arrives as an object; calling `.slice()` on it threw inside the row
   template and replaced the whole service-requests table with the error text. Now stringified through `detailText()`.

## 9. Edge Functions — `npm run test:fn-unit` and `npm run test:functions`

`supabase/functions/_shared/gemini.test.ts` (14 tests, `deno test`, no key, no network) locks the AI contract: no key
means `functions_unavailable` 503 and **no outbound request at all**; the key is sent in the `x-goog-api-key` header and
never appears in the URL, in an error message or in a serialised error; 400/429/blocked/empty/timeout/network each map
to a distinct code the UI can explain; JSON survives code fences.

`scripts/smoke-functions.mjs` boots each function on Deno, exactly as Supabase will, and asserts its contract —
401 without a session for `admin`/`ai`/`payments`/`domains`/`integrations`, 200 for `config`, a clean 4xx for `site`,
503 `webhook_unconfigured` for `payments-webhook`, and no secret value or stack trace in any response body.

## 10. Deployment config — `npm run verify:deploy`

Serves the built `public/` through a re-implementation of `vercel.json` and asserts routing, redirects, rewrites,
headers, 404 behaviour and the runtime config. See `docs/DEPLOYMENT.md` §4.
