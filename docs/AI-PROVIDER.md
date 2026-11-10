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

## Credential pooling (9 November 2026)

The five keys come from five different Google accounts, so each is a separate
free-tier allowance. The keyring now treats each numbered slot as its own quota
pool (`slot-1` … `slot-5`); before this change every slot carried
`legacy-unclassified`, and a spent allowance on one account parked the whole
ring while four untouched accounts sat idle.

| Situation | Behaviour |
| --- | --- |
| Key 1 returns 429 (daily quota) | key 2 is tried next; only keys that actually failed are parked |
| Key 1 returns 503 (model overloaded) | no key is parked — 503 is per model, not per account |
| `SHINZORA_AI_SHARED_QUOTA=1` | every key shares one pool (only correct when they come from one project) |
| `SHINZORA_AI_KEY_PROJECT_<n>` | states a slot's real Google project explicitly |

Rotation across accounts helps against **429**. It cannot help against **503**,
which is Google shedding load per model regardless of account.

Model choice is pinned: `SHINZORA_AI_MODEL=gemini-3.8-flash` with
`SHINZORA_AI_MODEL_FALLBACKS` empty, so the chain is exactly one model. No
discovered model is ever added silently — an unrequested fallback changes output
shape, latency and cost.

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

**Release status (9 November 2026):** live and verified as far as this
environment can verify it.

| Step | State |
| --- | --- |
| Code merged to `main` | `0bbf61e` (includes `273f076`: keyring, cooldowns, failover) |
| Migrations `0017`, `0018` | applied to production; `5` team tables, `5` with RLS, `11` RPCs, `team-chat-files` bucket, data intact |
| Secrets | `SHINZORA_AI_API_KEY_1` … `_5` plus `SHINZORA_AI_MODEL=gemini-3.8-flash`; I also verified `GET /v1beta/models` → `200` on each of the five |
| `ai` Edge Function | **deployed**, version `17`, new bundle hash `93df76dd…` (was `15` / `f7e1da2c…`), with `_shared/keyring.ts` included in the upload |
| Boot check after deploy | `POST /functions/v1/ai` with a publishable key returns the application's own `not_authenticated`, not `BOOT_ERROR` — the isolate starts and imports resolve |
| Live authenticated generation | **not exercised**: it needs a signed-in user's JWT, and the provider returned `503` / client timeouts for `generateContent` from the build environment during this work |

The `functions.ai.resources` key in `supabase/config.toml` is ignored by CLI
`3.1.0` (it warns on every deploy) and should be revisited when the CLI
version is pinned.

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
