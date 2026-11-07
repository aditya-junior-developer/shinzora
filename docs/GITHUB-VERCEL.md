# Pushing this project to GitHub, then to Vercel

The repository is committed and ready. Everything below is about copying it to
`https://github.com/aditya-junior-developer/shinzora`.

## What is committed

387 files, one commit (`Shinzora — production-ready site, database migrations 0006-0016 …`):

```
api/            serverless endpoints the site calls
public/         the whole front end — 23 pages, no build step
scripts/        config generator, deploy helpers, migration tools, checks
server/         pre-launch session handling used by the dev server
supabase/       migrations 0001–0016 and the Edge Functions
tests/          the unit and contract suites
docs/           deployment, migration receipts, the update reports
vercel.json     build command, output directory, headers, redirects
package.json    scripts only; the site itself has no runtime dependencies
```

Excluded on purpose, by `.gitignore`: `.env` (real secrets), `.backups/` (personal data and
provider credentials), `node_modules/`, `.prelaunch/`, `.DS_Store`.

`public/js/config/runtime.js` **is** committed. It contains only the project URL and the
publishable key — public by design, protected by Row Level Security — so connecting this repo to
Vercel produces a working site without setting a single environment variable.

## Push it

The push needs a credential I do not hold. One of these two:

### Option A — you push (three commands)

```bash
cd ~/shinzora
git push https://github.com/aditya-junior-developer/shinzora.git HEAD:main --force
```

Git asks for a username and password: the username is your GitHub handle, the password is a
**personal access token**, not your account password (GitHub removed password pushes in 2021).
Create one at *Settings → Developer settings → Personal access tokens → Fine-grained tokens* with
**Contents: Read and write** on the `shinzora` repository only.

### Option B — I push

Same token, handed to the helper script, which uses it for one push and never writes it to
`.git/config`:

```bash
GH_TOKEN=<token> ./scripts/push-github.sh
```

`--force` is needed because the repository currently holds two commits from the GitHub web uploader
("Add files via upload", "Delete index.html") with an empty tree. This replaces them with the real
project in a single commit. Nothing of value is lost.

## Then connect Vercel

*Add New → Project → Import Git Repository → `aditya-junior-developer/shinzora`*

| Setting | Value |
| --- | --- |
| Framework preset | **Other** |
| Root directory | `./` |
| Install command | `npm install` |
| Build command | `node scripts/generate-config.mjs` |
| Output directory | `public` |
| Node version | 20.x |

Environment variables: none required. If you want a canonical URL and to override the committed
public values, add `SITE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` — each one wins over the
committed value at build time.

## What Vercel will not do

Two operations are outside the frontend host, and no build setting changes that:

1. **Database migrations** — already applied to the live project (0006 → 0016) with
   `node scripts/apply-migrations.mjs`. A new environment needs them run again.
2. **Edge Functions** — already deployed (`admin`, `ai`, `payments`, `payments-webhook`, `site`,
   `domains`, `integrations`). A new Supabase project needs
   `node scripts/deploy-functions.mjs`.

If either is missing, `/system-check/` says exactly which one on the page, and the console shows the
migration file that is absent instead of a blank screen.

## After the first deploy

1. Open `/system-check/` — expect 0 failures; the warnings are the providers you have not
   configured (GitHub, Vercel, domain registrar).
2. Sign in at `/admin-login` and open **Businesses** and **Messages**.
3. Check `https://<your-domain>/site/?p=brew-theory-3icu` — a published generated site.
