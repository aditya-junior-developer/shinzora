# Builder Resilience — 8 November 2026

## Scope delivered in this pass

This pass focused on the Website/App Builder's original production failure: a single large AI generation call exceeded Edge Function compute and returned the reported 546. The builder now uses a chunked, persistent server-side job: plan → stylesheet/scripts → one page at a time → finish. Each completed step is stored before the next begins, progress is returned to the browser, and the server schedules the next step independently of the page.

The client now restores the project and submitted form snapshot on revisit, follows an in-flight job, previews files from a job that finished while the tab was closed, preserves a terminal failure and its reason, and exposes a deliberate retry instead of returning the owner to a blank builder. A retry uses the same unfinished project. A completed project is updated rather than duplicated. Structured API error bodies are preserved so the client can route `project_exists` to the existing project.

A retry for malformed/truncated page JSON is attempted with a smaller response contract. Provider-account quota exhaustion and invalid provider configuration now stop immediately rather than spending all three retries on a condition that cannot recover, return the user's generation credit, and preserve the provider's reset/error message.

The preview controls now offer tablet and phone only, with selectable iPhone, Samsung, Pixel, iPad, and Galaxy Tab viewport presets. The preview iframe uses the actual CSS viewport size and scales down proportionally in a narrow column. Expand uses the same real preview document, including on project reopen.

A migration draft (`supabase/migrations/0017_one_builder_project_per_kind.sql`) adds the database-level uniqueness guard for one website, app, and store per account. It is **not applied**. It has a read-only duplicate preflight; review/approval is required before applying it.

## Verification performed

- `node scripts/check.mjs`: all static checks passed (84 modules, 23 pages; migration count now includes the draft).
- `esbuild` bundles for `public/js/modules/dashboard/builder-core.js` and `supabase/functions/ai/index.ts`: passed.
- Real owner-account build completed earlier in this session through the live backend: 202 → plan → styles → page → finish, 100%, approximately 166 seconds, with a valid `index.html`, `styles.css`, and `app.js`. This proved the chunked pipeline itself can complete.
- A subsequent live UI attempt exercised the real builder but provider quota was exhausted; the failure correctly reported the provider reset and did not falsely report success. This pass additionally changed quota failures to stop immediately. **A full successful build could not be repeated while the provider remained quota-limited.**
- Browser test with a controlled failed-job response: reload restored the failed Build stage, displayed the saved quota reason and explicit retry, and restored the saved original brief when navigating to its stage.
- Browser test with temporary seeded preview artifacts: reopening without an `id` routed to the existing project; its generated page rendered in the real preview and Expand modal; a second `build_start` returned `409 project_exists` with the existing project. Temporary test records were removed afterwards.
- Browser tests confirmed Galaxy S24 (360×780), iPhone preset, iPad mini, and Galaxy Tab S9 presets change the rendered viewport; the preview select is styled; a 390px mobile builder viewport had no horizontal overflow.
- `git diff --check`: passed.

## Safety and release status

- The migration was drafted but not applied; no schema change is pending in production.
- The latest frontend and final backend retry/persistence changes have **not** been pushed or deployed. The current request explicitly says not to deploy without appropriate authorization, so this report does not claim they are live.
- The `ai` Edge Function had been deployed earlier with the initial chunked build engine, before the final quota-stop, form-snapshot, and four-key failover changes. A final deploy was attempted but Supabase rejected the saved Management API token with `401 Invalid access token`; the final server/client pair is not live yet.
- The four numbered AI credentials and `gemini-3.8-flash` model setting have now been stored as Supabase Edge Function secrets. The local code silently rotates credentials only on provider quota exhaustion. Because the new `ai` code could not be deployed, production does not yet consume those numbered secrets. See `docs/AI-KEY-FAILOVER-STATUS-2026-11-08.md`.
- `shinzora-check` is the local Git checkout created from the supplied bundle at `f3e3a80`; the changes are committed locally as `Build resumable website and app generation pipeline`. A GitHub push is not performed here because the user's no-deploy instruction makes pushing to the deployment branch unsafe, and this checkout has no configured authenticated remote.

## Remaining work / limitations

1. Run a full successful website build again after the provider quota resets, using the updated backend and current UI; verify notifications with permission granted and denied.
2. Verify the one-project constraint with the unique index after the duplicate preflight is reviewed and the migration is approved; the index is not yet active in production.
3. Stage and deploy the final frontend and `ai` function only after explicit production release approval, then verify the actual Vercel URL and Edge Function.
4. Broader items in the full SHINZORA upgrade brief—teams, inventory/orders, GitHub/Vercel OAuth, AI conversation management, domains, and platform-wide mobile QA—are outside this builder-resilience pass and are not represented as complete.
