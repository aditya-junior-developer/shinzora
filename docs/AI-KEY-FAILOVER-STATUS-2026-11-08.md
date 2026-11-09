# AI credential failover status — 8 November 2026

## Requested configuration

- Four ordered AI credentials were added as Supabase Edge Function secrets named `SHINZORA_AI_API_KEY_1` through `SHINZORA_AI_API_KEY_4`.
- `SHINZORA_AI_MODEL` was set to `gemini-3.8-flash`.
- Credential values are not in repository files, frontend bundles, logs, or this report.

## Code change

`supabase/functions/_shared/gemini.ts` now tries the next configured credential only after a provider quota-exhausted response, preserving the same model. It applies to text/JSON generation and grounded research. The current warm Edge isolate remembers the preferred credential as an optimization; a cold isolate starts from the first and still fails over correctly. Keys and slot numbers are not returned to users. Existing single-key secret names remain supported when no numbered keys are configured.

## Verification

- Edge Function bundle: passed.
- Static repository check: passed.
- Stubbed provider test: key 1 returned quota-exhausted; key 2 received the same `gemini-3.8-flash` request and succeeded.
- Grounded research stub: same quota failover behavior passed.
- All-keys-exhausted stub: tried four credentials, returned only the safe quota error, with no credential detail.

## Release blocker

The four numbered secrets and model setting are present in Supabase, but the updated `ai` Edge Function is **not deployed**. `node scripts/deploy-functions.mjs ai` was rejected with `401 Invalid access token` from the configured Supabase Management API token. Production therefore still runs the previous single-key implementation and does not consume the numbered pool. To recover the screenshot's provider error, the legacy single-key secret was pointed at the next credential after the first hit quota; a live build then completed successfully at 100% and returned `index.html`, `styles.css`, and `app.js` (job `557df9cf-9a13-4d8f-9743-36bc941993ce`). This is a temporary single-key setting, not automatic failover. Refresh the Supabase Management API token in the ignored local `.env` before deploying the pool implementation.
