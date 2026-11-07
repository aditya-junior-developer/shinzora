# Two things to do — the token, then Vercel

Everything on my side is finished. The repository is committed and waiting. This page is the only
thing left: **one token to push**, then **Vercel to deploy**.

---

## Step 1 — Create the token (2 minutes)

Open this link while signed in as `aditya-junior-developer`:

**https://github.com/settings/personal-access-tokens/new**

If that link sends you to a list instead, use: **https://github.com/settings/tokens?type=beta**
then press **Generate new token** (the *Fine-grained* tab, not *Tokens (classic)*).

Fill the form exactly like this:

| Field | What to choose |
| --- | --- |
| **Token name** | `shinzora-push` |
| **Expiration** | `7 days` (enough — you can revoke sooner) |
| **Resource owner** | `aditya-junior-developer` |
| **Repository access** | **Only select repositories** → tick **`shinzora`** |
| **Permissions → Repository permissions → Contents** | **Read and write** |
| Everything else (Issues, Actions, Metadata…) | leave as is — Metadata: Read is added automatically |

Press **Generate token** at the bottom, then **copy** the value. It starts with `github_pat_…` and
GitHub shows it only once.

Paste it in your next message here, exactly as copied. I run one push and nothing is stored.

### If the fine-grained page confuses you

The classic token works just as well: **https://github.com/settings/tokens/new** → note
`shinzora-push`, expiration `7 days`, tick the single scope **`repo`** → **Generate token** → copy.
It starts with `ghp_…`.

### Safe handling

- Use one token, for this one repository, expiring in days — never a token with access to all your
  repositories.
- I use it once (`git push`), then rewrite the remote URL without the token so it is not left in
  `.git/config`.
- Revoke it the moment the push succeeds: **https://github.com/settings/tokens** → the token →
  **Delete** / **Revoke**. The push is already done by then; losing the token costs nothing.
- If you would rather not paste a token anywhere, say so and push it yourself instead — one command,
  given in Step 1b of `docs/GITHUB-VERCEL.md`.

---

## Step 2 — What I do the moment the token arrives

1. `GH_TOKEN=… ./scripts/push-github.sh` — force-push `main`, replacing the two empty web-upload
   commits with the real project (387 files).
2. Check the result: read the commit back from the GitHub API and confirm the file count.
3. Tell you it is done, and hand you the Vercel settings.

Nothing else is needed from you for the push.

---

## Step 3 — Connect Vercel (3 minutes)

Open: **https://vercel.com/new**

1. Sign in with GitHub if you are not already, and allow Vercel to see your repositories.
2. Find **`aditya-junior-developer/shinzora`** in the list → **Import**.
3. Leave every default and set only these three:

| Field | Value |
| --- | --- |
| **Framework Preset** | `Other` |
| **Build Command** | `node scripts/generate-config.mjs` |
| **Output Directory** | `public` |

4. **Environment Variables: none.** The repository already carries the project URL and the
   publishable key, which are public by design. If you later want a canonical domain, add
   `SITE_URL = https://your-domain` and redeploy.
5. Press **Deploy**. First build takes about a minute; you get
   `shinzora-<something>.vercel.app`.

Then, in Vercel: **Settings → Domains** to attach your own domain, and **Settings → Git** if you want
automatic deploys on every push (on by default for the production branch `main`).

---

## Step 4 — What Vercel cannot do (already done, so nothing to do now)

Your live Supabase project already has migrations `0006 → 0016` applied and the Edge Functions
`admin`, `ai`, `payments`, `payments-webhook`, `site`, `domains`, `integrations` deployed. A
frontend host never performs those two steps, which is why they are recorded here.

If you ever create a **new** Supabase project, these two commands repeat the work:

```bash
node scripts/apply-migrations.mjs      # needs SUPABASE_ACCESS_TOKEN
node scripts/deploy-functions.mjs      # needs the Supabase CLI and the project ref
```

---

## Step 5 — First check after the deploy (1 minute)

1. Open `https://<your-domain>/system-check/`
   Expect **0 failures**. The warnings are providers you have not configured (GitHub, Vercel API,
   domain registrar) — the page names them instead of pretending they work.
2. Sign in at `https://<your-domain>/admin-login` and open **Businesses**, then **Messages**.
3. Open `https://<your-domain>/site/?p=brew-theory-3icu` — a real generated site, served from your
   database.

---

### Short version

| # | Where | What |
| --- | --- | --- |
| 1 | https://github.com/settings/personal-access-tokens/new | token named `shinzora-push`, repo `shinzora` only, **Contents: Read and write**, 7 days → copy → paste here |
| 2 | me | one force-push, verified, confirmed back to you |
| 3 | https://vercel.com/new | import `shinzora`, build `node scripts/generate-config.mjs`, output `public`, deploy |
| 4 | any | revoke the token: https://github.com/settings/tokens |

---

## Troubleshooting: `403 Permission denied` on push

Seen on the first attempt with this token. GitHub's API answered
`Resource not accessible by personal access token` when asked to write a blob, which means the token
itself carries **no write permission** — the identity and the repository are correct.

Two settings cause it, and both are on the token page:

1. **Repository access** was left on *Public repositories (read-only)*. It must be
   **Only select repositories** with `shinzora` ticked.
2. **Contents** was set to *Read-only*, or set under **Account permissions** instead of
   **Repository permissions**. It must be **Repository permissions → Contents → Read and write**.

Edit them at `https://github.com/settings/personal-access-tokens/22553970` → change both → **Save**.
The token value does not change when permissions are saved, so the same string starts working
immediately; no new token is needed.
