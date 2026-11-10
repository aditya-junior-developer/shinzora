# Shinzora Edge Functions

Seven functions, all Deno. Nothing in these directories is ever shipped to the
browser; the service-role key and every provider secret live only here.

| Function | JWT | Purpose |
| --- | --- | --- |
| `config` | no | Public booleans: which providers are connected |
| `ai` | yes | Every Gemini call: chat, generation, revision, copy, support drafts |
| `domains` | yes | Registrar search, orders, DNS instructions |
| `payments` | yes | UPI QR payment requests and proof submission |
| `payments-webhook` | no (signature) | Razorpay callback → only path to automatic verification |
| `integrations` | yes | GitHub OAuth + pushes, Vercel deploys and status |
| `admin` | yes (admin role) | Administrator API, payment approval, broadcasts |
| `site` | no | Public read of a published project for `/site/?p=slug` |

Shared code lives in `_shared/`: `http.ts` (envelopes and CORS), `auth.ts`
(JWT verification, service client, admin check), `gemini.ts` (provider client
with stable error codes), `config.ts` (provider flags) and `prompts.ts` (the
product voice and output contracts).

## Deploy

```bash
supabase link --project-ref <your-project-ref>
supabase functions deploy config            --no-verify-jwt
supabase functions deploy site              --no-verify-jwt
supabase functions deploy payments-webhook  --no-verify-jwt
supabase functions deploy ai
supabase functions deploy domains
supabase functions deploy payments
supabase functions deploy integrations
supabase functions deploy admin
```

`--no-verify-jwt` is only correct for the three functions marked "no" above.
For `admin`, the function additionally re-checks `public.admin_users` on every
request: a valid JWT is not enough.

## Secrets

```bash
supabase secrets set GEMINI_API_KEY=...            GEMINI_MODEL=gemini-3.8-flash
supabase secrets set UPI_ID=yourupi@bank           UPI_PAYEE_NAME="Your Business"
supabase secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=...
supabase secrets set GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... GITHUB_SCOPES=repo
supabase secrets set VERCEL_TOKEN=...
supabase secrets set DOMAIN_PROVIDER=namecheap DOMAIN_API_URL=https://... DOMAIN_API_KEY=...
supabase secrets set SUBDOMAIN_ROOT=shinzora.in INTEGRATION_ENCRYPTION_KEY=<32+ random chars>
```

Never put any of these in `public/js/config/env.js` or a `.env` file that is
committed. The browser only ever holds the Supabase publishable key.

## Error codes the frontend handles

| Code | Meaning | UI behaviour |
| --- | --- | --- |
| `functions_unavailable` | Function missing or `GEMINI_API_KEY` unset | Shows the exact setup step, never a fake result |
| `quota_exceeded` | Plan AI credits spent | Offers upgrade in Billing |
| `not_authenticated` | JWT missing or expired | Sends the user to sign in |
| `payments_unconfigured` | No UPI id and no Razorpay keys | "Contact support" instead of a broken QR |
| `domains_unconfigured` | No registrar provider | Explains that availability cannot be checked |
| `razorpay_unconfigured` | Keys absent | Only manual QR is offered |
| `admin_error` / `integration_error` | Server-side failure | Toast with the provider message, no fake success |

## Verifying locally

```bash
supabase start
supabase functions serve ai --env-file ./supabase/.env.local
curl -i http://localhost:54321/functions/v1/config
```

A `config` response with `"ai": { "configured": false }` is the expected state
before secrets are set — and the reason the dashboard shows a setup notice
instead of inventing an AI result.
