# AI provider: where the failure is, and what to switch to

## What is actually broken

The repo's `.env` key is rejected outright:

```
GET https://generativelanguage.googleapis.com/v1beta/models
→ HTTP 401 UNAUTHENTICATED
  ACCESS_TOKEN_TYPE_UNSUPPORTED — "API key not valid"
```

That is a **credential** error, not a quota or capacity problem. It matters
because the two need opposite responses:

| Symptom | Meaning | Fix |
|---|---|---|
| 401 / `ACCESS_TOKEN_TYPE_UNSUPPORTED` | the key itself is not valid | supply a valid key |
| 429 + `exceeded your current quota` | free allowance spent | wait for reset, or pay |
| 503 / 504 | the model is busy | retry, or a different model |

**What cannot be confirmed from here.** The six live secrets
(`SHINZORA_AI_API_KEY`, `_1`…`_5`) are stored in Supabase, and the management API
returns them as SHA-256 digests — the values are unreadable by design. They
therefore have never been probed directly. `geminiConfigured()` only checks that
*a* key exists, so a deployed health check proves nothing either.

To settle it in one minute, signed in as any real user, from the browser console:

```js
const { data: { session } } = await supabase.auth.getSession();
const r = await fetch("/api/fn/ai", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
  body: JSON.stringify({ action: "models", capability: "site" })
});
console.log(await r.json());
```

`verified: true` with a model list means the live keys work and the 401 above is
only the developer copy. `ai_bad_key` in the response means the live keys are
dead too and must be reissued at https://aistudio.google.com/apikey.

## Free alternatives, as of November 2026

Everything below is OpenAI-Chat-Completions compatible, so one adapter covers
all of them. They differ mainly in how much you get before hitting a wall.

| Provider | Free allowance | Card? | Catch |
|---|---|---|---|
| **Groq** | 30 req/min, 1,000 req/day, 200k tokens/day per model | No | 8k tokens/min is small — one long prompt can hit it |
| **NVIDIA NIM** | ~40 req/min, up to 10,000 req/day per model | No | Needs the free NVIDIA Developer Program; sanctioned for prototyping |
| **Cloudflare Workers AI** | 10,000 Neurons/day (≈147k output tokens) | No | Units are opaque; not OpenAI-shaped at `/ai/run` |
| **OpenRouter** | 20 req/min, 50 req/day (1,000/day after a one-off $10) | No | 50/day is not enough for real users; free roster rotates |
| **Google Gemini** (current) | Free tier on 3.x Flash / 2.5 Pro | No | Free-tier prompts may be used to improve Google products |
| **Mistral** | ~$10/month in credits | Phone | Free-mode inputs may train models |
| **Cerebras** | $5, expires in 30 days | Yes | Trial, not a standing tier |
| **Cohere** | 1,000 calls/month | No | Trial key, non-commercial |

For this app — a builder that makes several model calls per site — the honest
ranking is: **Groq** for day-to-day, **NVIDIA NIM** when the daily request count
matters most, **OpenRouter** only as an emergency spare because 50 a day runs
out fast.

## What was built

`supabase/functions/_shared/fallback.ts` — a small OpenAI-compatible client,
wired into `gemini()` so it is used **only after every Gemini attempt has
failed**. Three secrets switch it on:

```
AI_FALLBACK_BASE_URL=https://api.groq.com/openai/v1
AI_FALLBACK_API_KEY=<groq key>
AI_FALLBACK_MODEL=openai/gpt-oss-120b
```

With none set, behaviour is byte-for-byte what it was: `fallbackConfigured()` is
false and the original error is thrown unchanged.

Two deliberate limits:

- **Grounded search never falls back.** `google_search` is the one capability
  with no equivalent elsewhere; answering without sources while claiming a
  search happened would be worse than an error. `noFallback` is set there.
- **The Gemini error is kept when both fail.** A second provider's 429 is less
  useful to the customer than "the provider rejected the configured key".

## What is still open

- The live keys remain unproven until the console snippet above is run.
- Switching Gemini's own free tier is the cheapest fix if the 401 turns out to be
  a single bad key — no new provider, no new secret names.
- A paid tier removes the concurrency ceiling entirely; free tiers are all
  rate-limited at a level that will show under more than a couple of users.
