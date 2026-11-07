# AI provider — what is configured, what it can do, what it cannot

Measured on 7 November 2026 against the live provider with the project's own key.
Nothing here is copied from documentation; every number comes from a response
this project actually received.

## Configured

| Setting | Value |
| --- | --- |
| Key | `SHINZORA_AI_API_KEY` (server-side only: `.env` locally, `supabase secrets set` live) |
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
| `generate_content_free_tier_requests` for `gemini-3.8-flash` | **20 requests / day** | One website generation = one request. A day of iteration exhausts this in minutes. |
| Image model requests | **0** on the free tier | Image generation needs billing enabled on the provider project. |

The provider answers a spent allowance with a 429 whose message ends
`Please retry in 1h24m15.473309721s`. Two defects followed from that and are now
fixed:

1. The client said **"rate limiting — try again in a minute"**, which was false
   for a quota that resets in 84 minutes.
2. The message reached customers as provider prose mentioning
   `generativelanguage.googleapis.com` and a rate-limits URL.

Now (both code paths, verified live against a real 429):

```
code:    ai_quota_exhausted
status:  429
message: The AI provider's allowance for this project is used up. It resets in about 1h 23m.
hint:    Wait for the allowance to reset, or raise the limit in the AI provider's plan.
extra:   { "retry_after_seconds": 4977 }
```

A zero allowance is reported differently — it is a plan matter, not a wait:

```
code:    ai_quota_exhausted
message: This AI feature is not included in the provider plan this project is on.
         The owner can enable it in the AI provider's billing settings.
```

Fail-fast rule: when the allowance itself is spent, the model fallback chain is
**not** walked — every model in the chain answers 429 for the same project, and
walking it only replaces the true reason with a generic one.

`ai_max_tokens` is also distinct now: a thinking model that spends its whole
output budget returns an empty candidate, which used to be reported as "the AI
returned an empty response". It now says the output budget ran out, and the next
model in the chain is tried.

## What to do to make the product usable

**Owner action (cannot be done from inside this workspace):**

1. Open the provider project that owns this key → **Billing** → enable it. This
   raises the text quota and unlocks the image models.
2. If you want a different text model, set `SHINZORA_AI_MODEL` (local `.env` or
   `supabase secrets set`). Model names are checked against `GET /v1beta/models`
   before use — the app never assumes one exists.
3. Image generation is required by Parts 4.1, 4.2 (site imagery), 4.3/9 (logos,
   thumbnails). Until billing is on, those surfaces must stay honestly disabled
   with the reason shown — they will not fall back to stock photos pretending to
   be generated.

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
