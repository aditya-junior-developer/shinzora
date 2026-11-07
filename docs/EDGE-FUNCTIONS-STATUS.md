# Edge Functions — deployed and verified

Project: `zmkgfmlcpzjfgxdmbtvi` (`shinzora`, South Asia / Mumbai). Written 2026-11-06
after deploying and probing the live endpoints.

## Deployed: 8 of 8

| Function | JWT | Live check |
| --- | --- | --- |
| `config` | public | `200` — flags + model name, no key |
| `site` | public | `400` on a malformed public call, `404` for an unknown slug — never a trace |
| `payments-webhook` | public | `503 webhook_unconfigured` until a Razorpay secret exists; unsigned bodies refused |
| `ai` | required | `401` anonymous, `401` with the publishable key, **`200` with a real user JWT** |
| `admin` | required | `401` anonymous |
| `payments` | required | `401` anonymous, `200` authenticated (create → submit proof) |
| `domains` | required | `401` anonymous |
| `integrations` | required | `401` anonymous |

`node scripts/smoke-functions.mjs --remote` → **"Deployed functions match the local
contract"** (all contract, leak and stack-trace checks pass).

## AI, proven end to end

```
POST /functions/v1/ai          401  (no token)
POST /functions/v1/ai          401  (publishable key used as a bearer)
POST /functions/v1/ai   Bearer <user JWT>   200
   model: gemini-3.8-flash
   reply: "A UPI transaction ID is a unique 12-digit reference number generated
           for every payment to track, confirm, and reconcile the transfer."
```

Secrets in the project (names only — values are never printed or committed):
`SHINZORA_AI_API_KEY`, `SHINZORA_AI_MODEL=gemini-3.8-flash`,
`SHINZORA_AI_MODEL_FALLBACKS=gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite`.

The fallback chain matters in practice: `gemini-3.8-flash` answered
`503 UNAVAILABLE — high demand` for several minutes during setup and `3.6-flash`
answered `200` in the same window. The function walks the chain on 404/429/503 only,
so a busy model degrades instead of failing.

## Payments, proven end to end

```
POST /payments {action:"create", purpose:"subscription:pro"}   200
   amount 249900 paise (₹2,499), status "pending",
   upi { upi_id: manglampandey@fam, payee_name: "Manglam Pandey", intent: upi://pay?… }

POST /payments {action:"submit_proof", utr:"…", payerUpi:"payer@okhdfc"}   200
   status "awaiting_verification", note "Payer UPI: payer@okhdfc"

POST /payments {action:"submit_proof", payerUpi:"nope"}   400  (bad VPA refused)
```

Nothing in `payments` can set `verified` — only `admin.payment_review` or a signed
webhook can, which is why closing the browser cannot mark a payment paid.

## How this was verified without touching real accounts

Two throwaway identities (`qa-verify-…@shinzora.test`, `qa-pay-…@shinzora.test`) were
created through the Admin API, used for the authenticated calls, then deleted. Their
payments rows were removed by the `on delete cascade` on `owner_id`. Afterwards:

```
users now: 1 -> mext.aditya@gmail.com
test payment rows left: 0
```

No existing account, no schema, no function and no migration was modified.

## Deployment commands, for the record

```bash
export SUPABASE_ACCESS_TOKEN=sbp_…          # never committed

node scripts/deploy-functions.mjs            # 8/8, verify_jwt from config.toml
node scripts/smoke-functions.mjs --remote    # contract checks against the live project

supabase secrets set SHINZORA_AI_API_KEY=… SHINZORA_AI_MODEL=gemini-3.8-flash \
  SHINZORA_AI_MODEL_FALLBACKS=gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite
supabase secrets set UPI_ID=manglampandey@fam UPI_PAYEE_NAME="Manglam Pandey"
```

`scripts/deploy-functions.mjs` now passes `--yes` to the CLI as well as to `npx`;
current CLI versions refuse to deploy from a non-TTY without it.
