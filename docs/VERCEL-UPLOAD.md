# Putting this exact website on Vercel

Two things are hosted separately, and a deployment is only "the same website" when
both are done:

| What | Where it lives | How it gets there |
| --- | --- | --- |
| The website (`public/`), the `/api/prelaunch/*` function, redirects, headers | **Vercel** | what this guide covers |
| The database, RLS, and the `admin`, `ai`, `payments`, `site`, `config`, `domains`, `integrations` functions | **Supabase** (project `zmkgfmlcpzjfgxdmbtvi`) | `supabase functions deploy …` — step 6 |

Vercel does not run Supabase Edge Functions. If the site is on Vercel and the
functions are not deployed to Supabase, the site loads but the admin console and
the builder cannot work.

---

## 0. Before you start

* The code to deploy is `/home/user/shinzora` — and it is **not a git repository
  yet** (`ls -a` shows no `.git`). Everything below assumes that.
* Install once: Node 20+, and either Git + a GitHub login, or nothing else
  (option B and C use `npx`, which fetches on demand).
* The deployable archive already built from this workspace is
  `/home/user/shinzora-deploy.zip` (12.39 MB, 23 pages, 74 JS modules,
  9 migrations, 9 edge-function folders). It contains **no** `.env`, no
  `node_modules`, no generated `runtime.js` and no keys — checked.

---

## Option A — GitHub → Vercel (recommended: push once, redeploy for ever)

**A1. Turn the folder into a repo and push it**

```bash
cd /home/user/shinzora
git init
git add -A
git commit -m "Shinzora 1.0.0 — repaired build"
git branch -M main
git remote add origin https://github.com/shinzora-ai/shinzora.git
git push -u origin main
```

If the remote already has commits and the push is rejected, do **not** force-push
over it. Instead push to a branch and open a pull request:

```bash
git fetch origin
git checkout -b release/1.0.0
git push -u origin release/1.0.0
```

`.gitignore` already excludes `.env`, `node_modules/`, `.prelaunch/`,
`public/js/config/runtime.js`, `*.zip`, `*.pem`, `*.key` — so nothing secret can
be committed by accident.

**A2. Import on Vercel**

1. <https://vercel.com/new> → **Import Git Repository** → `shinzora-ai/shinzora`.
2. On the configuration screen set **exactly**:

   | Field | Value |
   | --- | --- |
   | Framework Preset | **Other** |
   | Root Directory | *(leave blank — the repo root)* |
   | Build Command | `node scripts/generate-config.mjs` |
   | Output Directory | `public` |
   | Install Command | `npm install --omit=dev` |
   | Node.js Version | **20.x** |

3. Open **Environment Variables** and paste the table in step 5.
4. **Deploy**.

Every `git push` to `main` after this redeploys automatically.

---

## Option B — Vercel CLI (no GitHub needed)

```bash
cd /home/user/shinzora
npx vercel login
npx vercel link          # create/attach the project
npx vercel --prod        # build + deploy
```

`vercel link` reads `vercel.json`, so the build command, output directory, headers
and redirects are already correct — accept the detected settings rather than
typing them. Then add the environment variables from step 5 and run
`npx vercel --prod` once more so the build sees them.

---

## Option C — upload the ZIP in the browser

1. Download `/home/user/shinzora-deploy.zip` from this workspace and unzip it.
2. Go to <https://vercel.com/new> → drag the **`shinzora-1.0.0` folder** in.
3. Set the same project settings as in A2 (Other / blank root /
   `node scripts/generate-config.mjs` / `public`).
4. Add the environment variables (step 5), then **Deploy**.

Caveat, stated plainly: drag-and-drop works, but it gives you no git history and
every future change means re-uploading the whole folder. If the deployed page
ever loads with a "not configured" banner, the build step did not run — use
option A or B, which always run it.

---

## 5. Environment variables (Vercel → Project → Settings → Environment Variables)

Add these for **Production** and **Preview**.

### Public — safe to appear in the browser by design

| Name | Value |
| --- | --- |
| `SHINZORA_SUPABASE_URL` | `https://zmkgfmlcpzjfgxdmbtvi.supabase.co` |
| `SHINZORA_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_fXoUaZPWuEceigIlk63htA_WavvP5Al` |
| `SHINZORA_SITE_URL` | `https://shinzora.in` |
| `SHINZORA_SUPPORT_EMAIL` | `official.shinzora@proton.me` |
| `SHINZORA_APP_NAME` | `Shinzora` |
| `SHINZORA_ENVIRONMENT` | `production` |

The build also accepts the Vite-style aliases (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_SITE_URL`) and plain `SUPABASE_URL` /
`SUPABASE_PUBLISHABLE_KEY`. Set one name per value, not both.

### Server-side — read only by `/api/prelaunch/*`, never sent to the browser

| Name | Value | Needed for |
| --- | --- | --- |
| `SUPABASE_URL` | `https://zmkgfmlcpzjfgxdmbtvi.supabase.co` | admin monitoring |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_fXoUaZPWuEceigIlk63htA_WavvP5Al` | admin monitoring |
| `PRELAUNCH_USER_EMAIL` | your pre-launch user email | sandbox sign-in |
| `PRELAUNCH_USER_PASSWORD_HASH` | `scrypt$16384$8$1$…` | sandbox sign-in |
| `PRELAUNCH_ADMIN_EMAIL` | your pre-launch admin email | `/admin/` |
| `PRELAUNCH_ADMIN_PASSWORD_HASH` | `scrypt$16384$8$1$…` | `/admin/` |
| `PRELAUNCH_SESSION_SECRET` | 32+ random characters | signing the session cookie |
| `PRELAUNCH_DATA_DIR` | `/tmp/shinzora-prelaunch` | **required** — Vercel's filesystem is read-only except `/tmp` |
| `SHINZORA_AI_API_KEY` | your Gemini key | sandbox builder + assistant |
| `SHINZORA_AI_MODEL` | `gemini-3.8-flash` | which model is tried first |
| `UPI_ID` / `UPI_PAYEE_NAME` | only if you are really collecting UPI | payments page |

Get the `PRELAUNCH_*` digest lines from the workspace — never retype a password
into a dashboard:

```bash
node scripts/prelaunch-credentials.mjs --show
```

Paste the four `PRELAUNCH_*` lines it prints. Never put `RAZORPAY_KEY_SECRET`,
`GITHUB_CLIENT_SECRET`, `VERCEL_TOKEN` or a service-role key in Vercel: those
belong to Supabase Edge Function secrets (`supabase secrets set …`).

---

## 6. Deploy the Supabase functions (without this, the site is only half live)

```bash
npx supabase login
npx supabase link --project-ref zmkgfmlcpzjfgxdmbtvi
npx supabase functions deploy admin ai site config payments domains integrations
```

Two of these are the fixes from the repair log: `admin` gains the `directory`
action (the Access page), and `ai` gains the `models` action (the model picker).
Then set the function secrets once:

```bash
npx supabase secrets set SHINZORA_AI_API_KEY=… SHINZORA_AI_MODEL=gemini-3.8-flash
```

---

## 7. Finish

1. **Domain** — Vercel → Project → Settings → Domains → add `shinzora.in`, then
   set the DNS records Vercel shows (usually an `A` record for the apex and a
   `CNAME` for `www`).
2. **Google sign-in** — Supabase → Authentication → Providers → Google: add the
   client id/secret, and put these in the redirect allowlist:
   `https://shinzora.in/auth/callback/` and `https://www.shinzora.in/auth/callback/`.
3. **Verify** — from the workspace, against the deployed URL:

   ```bash
   node scripts/verify-deploy.mjs     # 18 checks: routes, redirects, headers, runtime config
   node scripts/smoke-functions.mjs --remote
   ```

   A deployment is not "done" until those pass against `https://shinzora.in`, not
   just locally.

---

## Two honest limits you should know before promising the site is live

**The pre-launch sandbox does not persist on Vercel.** The `/api/prelaunch/*`
function keeps its store in `/tmp`, which is per-instance and resets on every cold
start. The two pre-launch accounts keep working (they are verified from
environment hashes), but any rows created inside the sandbox — projects,
versions, payments — can vanish. Real customers must sign in through Supabase
Auth (email/password or Google), which stores everything in Postgres and is not
affected. If you want sandbox rows to survive, run the Node server
(`node scripts/dev-server.mjs`) on a host with a writable disk, or move the
sandbox onto Supabase Auth.

**The AI allowance is your provider's, not Vercel's.** During the repair the free
tier answered `429` and `gemini-2.5-flash` was retired (`404`, "use
`gemini-3.8-flash`"). Generation will fail with a clear message until the key has
paid quota. Also rotate the current key — it was exposed earlier in this project.

Nothing in this guide has been executed: no deploy, no migration, no production
data change. Tell me which option you want and I will walk it one step at a time.
