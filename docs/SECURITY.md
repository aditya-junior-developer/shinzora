# Security

Model: the browser is untrusted, generated code is untrusted, and the administrator role is the highest-value target.
Every control below exists because of a specific failure it prevents.

---

## Secrets

| Secret | Where it lives | Never |
| --- | --- | --- |
| `SUPABASE_PUBLISHABLE_KEY` | `public/js/config/env.js` / `runtime.js` | — it is designed to be public; RLS is the control |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function environment | in HTML, JS, `.env` committed, or a client request |
| `GEMINI_API_KEY` | Edge Function environment | in the browser bundle |
| `UPI_ID` / `UPI_PAYEE_NAME` | Edge Function environment | exposed with a masking claim — the UPI id is shown to the paying user only, via `payments` |
| `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Edge Function environment | anywhere client-side |
| `GITHUB_CLIENT_SECRET`, `VERCEL_TOKEN` | Edge Function environment | anywhere client-side |
| `INTEGRATION_ENCRYPTION_KEY` | Edge Function environment | in the database |

`scripts/generate-config.mjs` refuses to write a value whose key looks secret-shaped, and `npm run check` scans `public/`
for Google keys, `service_role` assignments, Razorpay live secrets and private-key blocks. Both run in CI-able scripts.

---

## Authorisation

**Users cannot become administrators.** `admin_users` has RLS enabled and exactly one policy: select your own row.
There is no insert, update or delete policy for `anon` or `authenticated`. The only way in is
`0004_admin_bootstrap.sql`, run manually in the SQL editor.

`is_admin()` is `SECURITY DEFINER` with `set search_path = public`, so policies can consult it without granting table
access. The `admin` Edge Function calls `requireAdmin()` on **every** request — a valid JWT is not sufficient, and there
is no client-supplied role parameter it could trust.

Owner access is enforced by RLS predicates (`owner_id = auth.uid()`), not by filters in the UI. Removing a `where` clause
from a view cannot widen access.

### Monitoring access

`/api/prelaunch/monitor` and `/monitor/read` accept two identities, and nothing else:

1. A **pre-launch administrator** session cookie, whose role the server already holds.
2. A **Supabase account** presenting `Authorization: Bearer <access token>`.

The second path never trusts the caller's claim. The token is verified against
`/auth/v1/user`; only the `id` from that answer is used; the `admin_users` row is
then read **with the same token**, so row-level security — not the endpoint —
decides whether the account is an administrator. A missing, expired or invented
token, and a valid token belonging to a non-administrator, both get the same
`403` and the same remedy, so the endpoint reveals nothing about who is on the
list. The verified answer is cached for 60 seconds per token.

The panel's own failures are worded for the owner, not for a developer: 403 →
"not on the administrator list", 404/405 → "the service is not running on this
deployment", anything else → "monitoring could not be read".

---

## Payments

The invariant: **a payment becomes `verified` only through an administrator or a signature-verified webhook.**

How it is held:

1. `payments` has a `SELECT` policy for owners and **no** `INSERT`/`UPDATE`/`DELETE` policy for client roles. Writes go
   through the service role inside `functions/payments`.
2. `guard_payment_status()` (a `BEFORE UPDATE` trigger) raises `check_violation` if a non-admin, non-service call tries to
   set `status = 'verified'`. Defense in depth in case a future policy is added carelessly.
3. Amounts are resolved server-side from `PLAN_PRICES` / `SERVICE_PRICES` and a registrar quote. The client's
   `amount` field is ignored — sending `1` for Pro still requires ₹2,499.
4. `payments-webhook` recomputes the HMAC-SHA256 over the raw body and compares it before touching any row.
5. There is no code path that maps "the dialog closed" or "the user clicked done" to a status change. Abandoning the
   payment leaves `pending`.

The client never sees a secret and never decides a status.

---

## Generated code

Generated HTML/CSS/JS can be attacker-influenced in one realistic scenario: prompt injection inside a brief, producing a
`<script>` that tries to read the owner's session.

- Previews and published sites render in `<iframe sandbox="allow-scripts allow-forms allow-popups">` — no
  `allow-same-origin`, so the frame is an opaque origin without access to cookies, `localStorage` or the parent DOM.
- The injected document CSP is `default-src 'none'`, with `base-uri 'none'` and `form-action 'none'`; only inline styles
  and scripts and `https:`/`data:` images are permitted.
- `sanitiseFiles()` in the `ai` function enforces a filename allowlist (`*.html|css|js|json|svg|txt`), a per-file size cap,
  a file-count cap, and strips `<script src="http…">` from HTML before it is stored — so a published site cannot load a
  third-party script.
- Published reads go through the `site` function, which returns only the *published* version of *published* projects.
  Drafts are never reachable publicly.

---

## Input handling

- Every interpolation into HTML goes through `esc()` (`lib/dom.js`), which escapes `& < > " '`.
- Text from the database is treated as text, never as markup.
- Length caps exist at three layers: form `maxlength`, `validateForm`, and `clean()` inside each function (which also
  strips non-strings).
- SQL is never string-concatenated: all access is through supabase-js or parameterised RPC.
- Files uploaded to storage are constrained by bucket MIME allowlists and size limits, and paths are namespaced per user
  (`{userId}/…`) with folder-scoped policies.

---

## AI abuse and cost

- `consume_ai_credit()` runs before every model call and is atomic (`SELECT … FOR UPDATE`), so parallel requests cannot
  overspend.
- Credits are per user per billing cycle; the counter resets lazily when the month rolls over.
- Prompt sizes are capped (`clean(..., 4000)` on the brief, 16 messages of history for chat).
- Provider errors are logged with a code but the provider's raw payload is never returned to the client, so keys and
  internal details do not leak through error messages.
- A missing key returns `functions_unavailable` — the function does not silently fall back to fake content.

---

## Integration tokens

GitHub and Vercel tokens are stored in `integration_tokens`, a table with RLS enabled and **no policies**, so only the
service role can read it. When `INTEGRATION_ENCRYPTION_KEY` is set, values are sealed with AES-GCM (`enc:v1:<iv>:<ct>`)
before insert; a deployment without that key still protects the table by policy but stores plaintext, which is documented
in the deployment guide rather than hidden.

Tokens are never returned to the browser. The `status` action selects only `provider`, `account_name`, `scopes` and
`connected_at`.

---

## Transport and headers

`vercel.json` and `scripts/dev-server.mjs` both set:

- `Content-Security-Policy` — `default-src 'self'`, script/style `'self' 'unsafe-inline'`, `connect-src` limited to the
  Supabase project, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` denying camera, microphone and geolocation
- `Strict-Transport-Security` with preload
- `X-Robots-Tag: noindex, nofollow` on `/app/`, `/admin/` and the admin subpaths
- `Cache-Control: no-store` on the service worker

`'unsafe-inline'` for styles is required by the CSS-variable driven design and inline critical styles; scripts are inline
only where a page needs a tiny amount of boot logic. If you tighten this further, move those snippets into modules.

---

## Session handling

- Sessions are managed by supabase-js with refresh; `guard.js` redirects unauthenticated visitors and preserves the
  intended destination in `?next=`.
- "Sign out of all devices" uses `signOut({ scope: 'global' })`.
- The admin console checks the role *after* sign-in and immediately signs out an account that authenticates but is not an
  administrator, so a customer cannot leave a usable session on the admin surface.

---

## Logging

- Client errors surface through `normalizeError` with a stable code and a human hint; nothing is silently swallowed.
- `customer_activity` records account-relevant actions with `auth.uid()` as the actor.
- `ai_usage_log` records every AI call, including failures, for cost and abuse review.
- Edge Functions `console.error` the message only — never the payload, the key or the provider response body.

---

## Known limits, stated plainly

1. **Manual UPI verification depends on a human.** The system guarantees the *state machine*, not that an administrator
   checked the statement. That is why approval requires a typed confirmation and is recorded against the administrator.
2. **Email deliverability** depends on the Supabase mail provider. On the free tier, signup emails are rate-limited; add
   your own SMTP for production.
3. **Rate limiting on the assistant is quota-based**, not per-IP. A determined attacker with many accounts is limited by
   account creation checks, not by a WAF.
4. **`'unsafe-inline'` for scripts** in the site CSP is needed for generated sites to run at all. The sandbox is the real
   control there, not the directive.
5. **No penetration test has been performed.** `/system-check/` includes two live authorisation probes (client cannot
   write a payment; client cannot self-promote to admin) but that is not a substitute for a review.
