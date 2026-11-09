# AI provider — what is configured, what it can do, what it cannot

Measured on 7 November 2026 against the live provider with the project's own key.
Nothing here is copied from documentation; every number comes from a response
this project actually received.

## Configured

| Setting | Value |
| --- | --- |
| Key | `SHINZORA_AI_API_KEY_1`–`SHINZORA_AI_API_KEY_5` or `SHINZORA_AI_KEYRING` (server-side only; legacy single-key names remain supported) |
| Model | `gemini-3.8-flash` |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta` |
| Reads the key | `supabase/functions/_shared/gemini.ts` (Edge Function) and `server/prelaunch/functions.mjs` (local sandbox) |
| Never reads the key | anything under `public/` — verified: `grep -r` finds it in 0 public files, 0 served bundles, 0 packaged archives |

The browser is told only *whether* AI is configured. `GET /api/prelaunch/fn/config`
returns `{"ai":{"configured":true,"model":"gemini-3.8-flash","key_env":null}}` —
no key, no key fragment.

## What the key can do today

| Capability | Status | Evidence |
| --- | --- | --- |
| Text generation (`generateContent`) | **works** | `POST models/gemini-3.8-flash:generateContent` → `200` |
| JSON-mode generation | works, same endpoint | `responseMimeType: application/json` accepted |
| Listing models | works | `GET /v1beta/models` → `200`, 30+ models |
| Image generation | **not available** | `gemini-2.5-flash-image` → `429`, free-tier limit **0** for image models |

## The binding constraint: free-tier quota

| Metric | Limit observed | Meaning |
| --- | --- | --- |
| `generate_content_free_tier_requests` for `gemini-3.8-flash` | Provider-specific; key/project quotas may differ | A chunked website build makes several small model calls (plan, styles, and each page). The provider remains the source of truth for resets. |
| Image model requests | **0** on the free tier | Image generation needs billing enabled on the provider project. |

The provider answers a spent allowance with a 429 and a retry delay. The updated server code tries the next configured server-side credential, in order, using the same model. This failover is internal; no credential, key slot, or provider response is sent to the browser when a later key succeeds. If every key is exhausted, the build is saved and the user gets a safe unavailable message.

**Release status (9 November 2026):** five numbered secrets
(`SHINZORA_AI_API_KEY_1` … `_5`) and `SHINZORA_AI_MODEL=gemini-3.8-flash` are
stored in the Supabase project `zmkgfmlcpzjfgxdmbtvi`. Each key was checked
directly against the provider: `GET /v1beta/models` returned `200` for all five,
and all five list `models/gemini-3.8-flash`.

What is live now:

| Step | State |
| --- | --- |
| Code merged to `main` | `273f076` — keyring, cooldowns, and failover |
| Migrations `0017`, `0018` | applied to production, verified (`5` team tables, `5` with RLS, `11` RPCs, `team-chat-files` bucket) |
| `SHINZORA_AI_API_KEY` (legacy name the deployed function reads) | rotated to verified key `_1`, so production AI runs on a fresh credential |
| `ai` Edge Function redeployed with keyring code | **not yet** — the deployment tooling available in this build can publish a single-file function, but `ai` imports seven modules under `_shared/`. A single-file shim importing the repository over a CDN was tested on a canary and returned `BOOT_ERROR`, so it was removed. Deploy needs `supabase functions deploy ai` (CLI, access token) or the dashboard. |

Consequence, stated plainly: production rotates credentials only after that
redeploy. Until then it uses exactly one working key, not five.

1. The client said **"rate limiting — try again in a minute"**, which was false
   for a quota that resets in 84 minutes.
2. The message reached customers as provider prose mentioning
   `generativelanguage.googleapis.com` and a rate-limits URL.

When every configured credential is exhausted, the user-facing response is
provider-neutral and does not reveal that credential failover exists:

```
code:    ai_quota_exhausted
status:  429
message: The AI service is temporarily unavailable. It may be available again in about 1h 23m.
         No AI credit was charged. Try again later.
```

If a later credential succeeds, the user sees only the normal completed response.

Quota rule: when a credential returns a quota-exhausted response, the current
model chain stops and the next configured credential is tried. The user's
selected/default model is preserved across credential rotation. If all configured
credentials are quota-exhausted, the server stops rather than burning more calls.

`ai_max_tokens` is also distinct now: a thinking model that spends its whole
output budget returns an empty candidate, which used to be reported as "the AI
returned an empty response". It now says the output budget ran out, and the next
model in the chain is tried.

## What to do to make the product usable

**Owner action (cannot be done from inside this workspace):**

1. Review the provider's own usage page for each credential; separate keys may
   still share a project-level quota.
2. `SHINZORA_AI_MODEL` selects the default. This deployment is configured for
   `gemini-3.8-flash`; explicit user model choices remain supported where enabled.
3. Image generation has its own capability and quota; credential failover does
   not create an image model entitlement or pretend an image was generated.

## How spend is controlled in code

- `consume_ai_credit` (SQL, service-role only) charges one credit per AI action
  against `subscriptions.ai_credits_limit`; a spent balance refuses the request
  before the provider is called.
- `ai_usage_log` records every call: user, mode, ok/failure and the error code.
  A quota failure is visible in the admin activity stream rather than silently
  swallowed.
- Generation is one request per project, not one per page, precisely because the
  quota is small.

## Tests

`node tests/ai-errors.test.mjs` — 56 assertions, no key, no network:
wait parsing, quota classification, all six error mappings, fail-fast behaviour,
`MAX_TOKENS` fallthrough, key-never-in-message, and a drift guard that runs the
Edge Function copy and the sandbox copy over the same provider payloads and
requires identical codes, statuses and retry windows.
