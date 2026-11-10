# Edge Function API

All functions are POST except `config` (GET). Requests and responses are JSON. Authenticated functions expect
`Authorization: Bearer <user access token>`; the frontend wrapper `public/js/lib/api.js` adds it and normalises errors.

Error envelope, returned with a non-2xx status:

```json
{ "code": "quota_exceeded", "error": "Human readable message", "hint": "What to do next" }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `not_authenticated` | 401 | Missing or invalid JWT |
| `forbidden` | 403 | Valid session, not an administrator |
| `invalid_input` | 400 | Validation failed; `hint` explains the rule |
| `unknown_action` | 400 | Unrecognised `action` |
| `quota_exceeded` | 429 | AI credits exhausted for the cycle |
| `functions_unavailable` | 503 | Function missing or `GEMINI_API_KEY` unset |
| `ai_rate_limited` | 429 | Provider throttled this project |
| `ai_bad_json` | 502 | Model returned unusable JSON after one repair attempt |
| `ai_timeout` | 504 | Provider call exceeded the function budget |
| `payments_unconfigured` | 503 | No UPI id and no Razorpay keys |
| `razorpay_unconfigured` | 503 | Razorpay keys absent |
| `domains_unconfigured` | 503 | No registrar provider configured |
| `integration_error` | 502 | Provider rejected the request; message is the provider's |
| `not_found` | 404 | Record missing or not owned by the caller |

---

## `config` — GET, public

```json
{
  "available": true,
  "environment": "production",
  "ai": { "configured": true, "model": "gemini-3.8-flash" },
  "payments": {
    "upi_configured": true,
    "upi_payee_name": "Shinzora",
    "razorpay_configured": false,
    "razorpay_key_id": null,
    "mode": "manual_verification"
  },
  "domains": { "provider": "none", "configured": false, "subdomain_root": "shinzora.in" },
  "integrations": { "github_configured": false, "vercel_configured": false },
  "email": { "provider": "supabase" }
}
```

---

## `ai` — authenticated

### `chat`

```json
{ "action": "chat", "message": "How should I price my first product?", "conversationId": "uuid|null", "context": "optional screen context" }
```

```json
{ "reply": "…", "conversationId": "uuid", "model": "gemini-3.8-flash", "usage": { "plan": "pro", "used": 12, "limit": 800 } }
```

Persists the conversation and both messages. Business context is read server-side from `businesses`; `context` is optional
extra text from the current screen.

### `generate`

```json
{
  "action": "generate",
  "type": "website",
  "name": "Aarna Ceramics",
  "brief": "Hand-thrown stoneware for small apartments…",
  "pages": ["Home", "Shop", "About"],
  "style": "Warm editorial, off-white, serif display",
  "projectId": "uuid|null",
  "business": { "…optional override…" }
}
```

```json
{
  "files": { "index.html": "…", "styles.css": "…", "app.js": "…", "shop.html": "…" },
  "entry": "index.html",
  "framework": "html",
  "pages": [{ "name": "Home", "path": "index.html", "title": "…" }],
  "seo": { "title": "…", "description": "…", "keywords": ["…"] },
  "design_system": { "colors": { "…": "…" }, "fonts": { "…": "…" }, "radius": "…", "spacing": "…" },
  "notes": "…",
  "model": "gemini-3.8-flash"
}
```

The function consumes one credit, sanitises the payload and returns it. The **client** writes `projects` and
`project_versions`, under owner RLS.

### `revise`

```json
{ "action": "revise", "instruction": "Make the hero calmer and drop the pricing section", "files": { "index.html": "…" }, "projectId": "uuid" }
```

Returns the same shape as `generate`, with the full updated file set.

### `domain_ideas`

```json
{ "action": "domain_ideas", "count": 10 }
```

```json
{ "ideas": [{ "domain": "aarnaceramics.in", "reason": "Reads as the studio name, easy to say aloud" }] }
```

Ideas only. Availability is never asserted here — that requires `domains.search`.

### `copy`

```json
{ "action": "copy", "kind": "marketing_plan", "objective": "Launch the winter collection", "channel": "instagram", "catalogue": [], "recentOrders": [] }
```

Returns `{ title, summary, plan: { objective, audience, message, channels[], content[], measurement[], first_week[] } }`.

`kind: "product"` with `{ product }` returns `{ description }`.

### `support_reply`

```json
{ "action": "support_reply", "ticket": { "subject": "…", "message": "…", "type": "customer" }, "thread": [{ "role": "owner", "body": "…" }] }
```

```json
{ "reply": "…", "needs_owner": true }
```

---

## `payments` — authenticated

### `create`

```json
{ "action": "create", "purpose": "subscription:pro", "label": "ignored" }
```

Purpose namespaces: `subscription:pro|enterprise`, `service:website_setup|brand_kit|store_setup`, `domain:<order-id>`.
Amounts come from the server catalogue; a client-supplied amount is discarded.

```json
{
  "payment": { "id": "uuid", "reference": "SZ-1A2B3C4D5E", "amount": 249900, "currency": "INR", "status": "pending", "purpose": "subscription:pro" },
  "upi": { "configured": true, "upi_id": "shinzora@bank", "payee_name": "Shinzora", "intent": "upi://pay?pa=…", "amount_rupees": 2499 },
  "razorpay": { "configured": false }
}
```

### `submit_proof`

```json
{ "action": "submit_proof", "paymentId": "uuid", "utr": "412345678901", "paidAt": "2026-11-04T09:12:00Z", "note": "paid from family account" }
```

Moves the payment to `awaiting_verification`, notifies the owner, and returns the exact confirmation sentence. It cannot
verify.

### `status`

`{ "action": "status", "paymentId": "uuid" }` → `{ payment: { status, admin_note, verified_at, … } }`

### `razorpay_order`

`{ "action": "razorpay_order", "paymentId": "uuid" }` → `{ order: { id, amount, currency }, key_id }`, or
`razorpay_unconfigured`.

---

## `payments-webhook` — public, signature-verified

`POST` with header `x-razorpay-signature`. HMAC-SHA256 over the raw body using `RAZORPAY_WEBHOOK_SECRET`.

- `payment.captured` / `order.paid` → `verified`
- `payment.failed` → `rejected`
- unknown events → `{ ok: true, ignored: "<event>" }`

A forged or missing signature returns 401 and nothing changes.

---

## `domains` — authenticated

| Action | Body | Response |
| --- | --- | --- |
| `search` | `{ query }` | `{ provider_configured, provider, results: [{ domain, available, price, renewal, currency }] }` — or `provider_configured: false` with an explanation and no results |
| `availability` | `{ domain }` | same as `search` |
| `create_order` | `{ domain, years? }` | `{ order, next: "pay", payment_purpose }` — the price is re-quoted from the registrar |
| `connect` | `{ fqdn, projectId }` | `{ domain, records[], status_note }` |
| `dns` | `{ domainId }` | `{ domain, records[], managed }` |

---

## `integrations` — authenticated

| Action | Body | Notes |
| --- | --- | --- |
| `status` | — | `{ configured: { github, vercel }, connected: { github, vercel } }` — no tokens |
| `github_connect` | `{ code }` or `{ token }` | Exchanges OAuth, stores the token sealed |
| `github_repos` | — | Repositories the token can push to |
| `github_create_repo` | `{ name, private }` | Creates and returns the repo |
| `github_push` | `{ projectId, versionId, repo, branch?, message? }` | Returns `{ commit, branch, url }` only after GitHub accepts the commit |
| `vercel_connect` | `{ token }` | Verifies with `/v2/user` before storing |
| `vercel_deploy` | `{ projectId, versionId, name? }` | `{ deployment, provider_state, url }` — not "live" until READY |
| `vercel_status` | `{ deploymentId }` | Maps `readyState` → `queued/building/ready/error/cancelled` |

---

## `admin` — authenticated **and** administrator

| Action | Body |
| --- | --- |
| `overview` | — |
| `customers` | `{ search?, limit?, offset? }` |
| `customer` | `{ userId }` |
| `payments` | `{ status? }` |
| `payment_review` | `{ paymentId, decision: "approve"\|"reject", note? }` |
| `service_requests` | `{ status? }` |
| `service_request_update` | `{ id, status, note? }` |
| `subscriptions` | — |
| `subscription_update` | `{ userId, plan, status }` |
| `projects` | `{ type? }` |
| `deployments` | — |
| `tickets` | `{ status? }` |
| `ticket_reply` | `{ ticketId, body }` |
| `ticket_status` | `{ ticketId, status }` |
| `announcements` | — |
| `announcement_create` | `{ title, body, audience }` — `audience`: `all`, `free`, `pro`, `enterprise`, `user:<uuid>` |
| `activity` | `{ limit? }` |
| `contacts` | — |
| `contact_update` | `{ id, status }` |
| `admins` | — (read-only; granting rights requires SQL) |

`payment_review` with `decision: "approve"` sets `verified`, records `verified_by`, applies the paid effect (plan upsert,
service approval, or domain order → `paid`) and notifies the customer.

---

## `site` — public

`POST { "slug": "aarna" }` or `GET ?p=aarna`.

```json
{
  "project": { "name": "Aarna Ceramics", "type": "website", "slug": "aarna", "published_at": "…" },
  "entry": "index.html",
  "files": { "index.html": "…", "styles.css": "…" },
  "seo": { "title": "…", "description": "…" },
  "pages": [{ "name": "Home", "path": "index.html" }],
  "version": 4,
  "updated_at": "…"
}
```

404 with `not_found` when the project is not published or the slug is wrong. Cached 60 s with
`stale-while-revalidate`.
