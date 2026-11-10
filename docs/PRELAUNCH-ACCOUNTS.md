# Pre-launch accounts

Two accounts exist so the product can be exercised end to end before customer
sign-ups open. They are **ordinary accounts on this deployment**, not a demo
mode: they hold real rows in the pre-launch store, they drive the real
dashboards, and every privileged action still goes through the same
server-side checks as a customer's.

| Account | Identifier | Role | Lands on |
| --- | --- | --- | --- |
| Pre-launch tester | `business@business.com` | `user` | `/app/` — full customer workspace |
| Administrator | `Shinzora@admin` | `admin` | `/admin/` — operations console |

`Shinzora@admin` is a literal identifier, not a mailbox: it is matched
case-insensitively on the server. Both accounts sign in on the **normal
`/auth/login/` page**; there is no separate administrator login, and
`/admin-login/` is now only a pointer page.

---

## 1. How authentication works

```
browser ──POST /api/prelaunch/auth/login──▶ server/prelaunch/router.mjs
                                             ├─ auth-core.mjs: scrypt verify
                                             ├─ issueSession(): HMAC-SHA256 token
                                             └─ Set-Cookie: sz_prelaunch
                                                HttpOnly · SameSite=Lax · Path=/ · 12 h
```

* Passwords are stored as scrypt digests (`N=16384, r=8, p=1`) in `.env`, which is
  gitignored and never served. No password, hash or secret is present in
  `public/` — check with `grep -rn "PRELAUNCH" public/` (no matches).
* The session cookie is `HttpOnly`, so page JavaScript cannot read or forge it.
  The token is signed with `PRELAUNCH_SESSION_SECRET`; tampering fails closed.
* The server derives the tenant from the session. A signed-in non-admin can only
  see and write its own tenant's rows — the browser cannot pass a role or a
  tenant id that the server trusts.
* Sign-in attempts are rate limited (25 per 5 minutes per address; loopback is
  exempt so local testing is not locked out) and every attempt is logged.
* Normal Supabase registration and sign-in are untouched: any address that is
  not a pre-launch account returns `{ "prelaunch": false }` and the page falls
  through to Supabase Auth exactly as before.

### Provisioning

```bash
node scripts/prelaunch-credentials.mjs --init \
  --user 'business@business.com' --user-password 'Business@dmin' \
  --admin 'Shinzora@admin'      --admin-password 'shinzora@dmin'

node scripts/prelaunch-credentials.mjs --show    # what is configured (never the password)
```

`--init` also generates `PRELAUNCH_SESSION_SECRET`. To change a password, re-run
with a new `--user-password`; the digest is replaced and existing cookies remain
valid until they expire (12 h) because the secret is unchanged.

---

## 2. What the pre-launch tester can actually do

Everything in `/app/` reads and writes the pre-launch store through the same
`supabase-js` call sites the production app uses — the transport is swapped, not
the code paths:

| Area | State |
| --- | --- |
| Overview, projects, orders, products, customers, support, notifications, billing, analytics, domains | Live reads and writes against the seeded workspace |
| Business profile, settings, avatar + logo upload | Live — uploads are stored under `.prelaunch/uploads/` and served from `/api/prelaunch/storage/...` |
| AI Assistant (chat), copy, support reply, domain ideas | Real Gemini call **once `SHINZORA_AI_API_KEY` is set**. Without it the assistant is disabled and says exactly which variable is missing — nothing is simulated |
| Website/app **generation** (`generate`, `revise`) | Not available in the sandbox (HTTP 501 with an honest hint). Full generation needs the deployed `ai` Edge Function |
| Domains, payments, GitHub/Vercel integrations | HTTP 501 with an honest hint. No fake availability, prices or deploy success |

### AI in one line

```bash
# .env (local) or Project → Settings → Environment Variables (Vercel)
SHINZORA_AI_API_KEY=<your Gemini API key>
SHINZORA_AI_MODEL=gemini-3.8-flash     # optional
```

Reload the page; `GET /api/prelaunch/health` reports `ai_configured: true`, and
the assistant enables itself. `SHINZORA_AI_BASE_URL` is supported for a proxy or
self-hosted endpoint.

---

## 3. Data separation

| | Pre-launch | Customers |
| --- | --- | --- |
| Storage | `.prelaunch/sandbox.json` (gitignored), uploads in `.prelaunch/uploads/` | Supabase Postgres + Storage |
| Identities | `pl_user_1`, `pl_admin_1` from `.env` | `auth.users` |
| Access | tenant `pl_tenant_user` / `pl_tenant_admin` | RLS on the customer's own tenant |

The seed also carries two throwaway tenants (`pl_tenant_c1`, `pl_tenant_c2`) so
the isolation is provable: signed in as the tester, `GET
/api/prelaunch/rest/v1/projects` returns only the tester's two projects, while
the administrator sees all three.

`POST /api/prelaunch/reset` (administrator only) re-seeds the sandbox store and
touches nothing else. It cannot reach Supabase.

---

## 4. Monitoring

The administrator's **Monitoring** view (and `/api/prelaunch/monitor`) reports
what the server recorded — never browser-invented numbers:

* `auth.login` / `auth.logout` — every attempt, including refused ones and rate limiting
* `data.write` — every insert, update and delete made through the sandbox API
* `admin.action` — every console action (payment review, ticket reply, subscription change…)
* `client.error` — uncaught errors and rejected promises reported by the browser while a pre-launch account was signed in
* `feature.use` — feature-level activity the app reports
* `feature.change` — files added, removed or modified in `public/` since the previous check (website changes and feature updates)
* `system.boot`, `system.reset` — server starts and sandbox resets

Unread state is a single watermark ("Mark all read"), and the nav badge shows the
count so an administrator sees activity without opening the view.

Log file: `.prelaunch/monitor.jsonl` (append-only, capped at 5,000 lines read at
a time). On Vercel the store lives in `/tmp` — the log survives within an
instance, and reseeds with the sandbox when a new instance starts.

---

## 5. Deploying the accounts to Vercel

The static site alone cannot sign these accounts in: the API has to exist.

1. `api/prelaunch/[...path].js` is already in the repository — Vercel picks up
   the `api/` directory automatically, alongside `outputDirectory: "public"`.
2. Add the environment variables from `.env.example` → *Pre-launch accounts*:
   the two `_EMAIL` values, the two `_PASSWORD_HASH` values and
   `PRELAUNCH_SESSION_SECRET`. Generate the hashes locally with
   `node scripts/prelaunch-credentials.mjs --show` — paste the `PRELAUNCH_*`
   lines. Never paste a plain password into Vercel.
3. Optional: `SHINZORA_AI_API_KEY` to turn the assistant on.
4. Deploy. Then check:
   `curl -s https://<your-domain>/api/prelaunch/health`
   → `{"enabled":true,"accounts":[…],"ai_configured":…}`.

Serve the site over HTTPS so the cookie is issued `Secure` (the server sets that
automatically when `x-forwarded-proto: https`).

**Persistence note:** Vercel's filesystem is read-only apart from `/tmp`, so the
adapter points `PRELAUNCH_DATA_DIR` at `/tmp`: sign-in always works, and the
seeded rows and monitor log reset when a fresh function instance starts. If you
need durable pre-launch rows, run the Node server (`node scripts/dev-server.mjs`)
on a host with a writable disk, or mount a volume and set `PRELAUNCH_DATA_DIR`.

---

## 6. Files involved

| Path | Job |
| --- | --- |
| `server/prelaunch/auth-core.mjs` | scrypt verify, HMAC session token, cookie helpers |
| `server/prelaunch/store.mjs` | sandbox schema + seed, JSON persistence, tenant constants |
| `server/prelaunch/rest.mjs` | PostgREST subset the app actually uses (filters, projections, counts, single-row semantics, writes) |
| `server/prelaunch/functions.mjs` | `ai`, `admin` (all 20 actions), `site`, `config`; honest 501s elsewhere |
| `server/prelaunch/storage.mjs` | uploads, public reads, signed URLs, listing |
| `server/prelaunch/monitor.mjs` | event log, unread watermark, website-change fingerprint |
| `server/prelaunch/router.mjs` | the `/api/prelaunch/*` routes, throttling, JSON replies |
| `server/prelaunch/../../api/prelaunch/[...path].js` | Vercel entry point |
| `scripts/prelaunch-credentials.mjs` | provisioning CLI |
| `public/js/lib/prelaunch.js` | browser bridge: probe, sign-in, supabase-js transport swap, storage URLs, error reporting |

## 7. Known limits (stated plainly)

* Generation actions and the domain/payment/integration providers are not
  available in the sandbox; the UI shows the server's 501 message rather than a
  fake success.
* The sandbox is a JSON store, not Postgres: it implements the queries this
  frontend issues, not arbitrary SQL.
* Function access matches `supabase/config.toml`: `/api/prelaunch/fn/config` and
  `/fn/site` answer without a session (exactly like the deployed
  `verify_jwt = false` functions, and `site` only ever returns a **published**
  project); `ai`, `admin`, `payments`, `domains` and `integrations` return 401
  without a session, like their deployed `verify_jwt = true` counterparts.
* Website-change tracking needs the deployable tree on disk, so it is reported as
  unavailable on serverless hosts instead of claiming "no changes".
