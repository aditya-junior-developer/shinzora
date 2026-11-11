# Feature audit — the 30 functions, checked against this repository

Checked by reading the code, not by asking the app. Every line below names the
file that implements the feature, or says plainly that nothing implements it.
Where a feature was missing it was built in this round; the "Where" column then
points at the new code.

Two rules were applied throughout: a feature counts only if a real user can
reach it and the server actually does the work, and a stub that draws a
convincing screen out of invented numbers counts as missing.

Migration numbering continues from 0034. This round adds **0035** (store
operations) and **0036** (support conversation roles).

| # | Function | Status before this round | Where |
|---|----------|--------------------------|-------|
| 1 | AI Website Builder | **Working** — five-stage builder against the `ai` Edge Function | `public/js/modules/dashboard/builder-core.js` |
| 2 | AI Website Layout Generation | **Working** — planned pages and routes are generated, then built | `builder-core.js` (`plannedPages`), `ai/index.ts` (`build_start`, `build_step`) |
| 3 | AI Content Generation | **Working** — copy, chat, revise, research, domain ideas | `supabase/functions/ai/index.ts` (`copy`, `revise`, `domain_ideas`) |
| 4 | Website Preview | **Working** — sandboxed iframe, per-page routing, five device widths | `builder-core.js` (`buildPreviewDocument`, `previewAt`) |
| 5 | Website Publishing | **Working** — publishes a version to `<slug>.shinzora.in`, ownership checked by RLS | `builder-core.js` (`publish`), `public/site/` |
| 6 | Product Management | **Working** — create, edit, archive, delete, search | `views/inventory.js` |
| 7 | AI Business Assistant | **Working** — persisted conversations, server-side Gemini | `views/assistant.js`, `ai/index.ts` (`chat`) |
| 8 | Natural-Language Command Execution | **Was missing** — the assistant talked, it never did anything | **New:** `views/assistant.js` + `ai` action `command` + `assistant_command_apply()` |
| 9 | Inventory Management | **Working** — stock, variants, CSV export | `views/inventory.js` |
| 10 | Stock-Level Monitoring | **Working** — live stock per product, low-stock count | `views/inventory.js` |
| 11 | Low-Stock Alerts | **Partial** — a filter and a badge, but nothing told you when it happened | **New:** `product_alerts` + trigger on restock/self-clear, alerts panel in `views/inventory.js` |
| 12 | Order Management | **Working** — record, filter, line items, status | `views/orders.js` |
| 13 | Customer Order Tracking | **Was missing** — no customer-facing view of an order | **New:** `public/track/` + `order_tracking(p_token)` |
| 14 | Sales Analytics | **Working** — revenue, AOV, 14-day series, status mix | `views/analytics.js` |
| 15 | Revenue Tracking | **Working** — paid orders only, payments cross-checked | `views/analytics.js` |
| 16 | Customer Analytics | **Partial** — customer count only, no value or frequency | **New:** top customers, repeat rate in `store_analytics()` |
| 17 | Conversion Rate Tracking | **Was missing** — nothing recorded a visit at all | **New:** `store_visits` + `store_track_visit()` + `store_analytics()` |
| 18 | Sales Charts and Reports | **Working** charts; **missing** downloadable report | **New:** CSV report from the analytics screen |
| 19 | CSV File Upload | **Was missing** — export only, never import | **New:** `store_import_products(p_rows jsonb)` + importer in `views/inventory.js` |
| 20 | AI Data Analysis | **Was missing** | **New:** `ai` action `data_analysis` + `views/analytics.js` |
| 21 | Category-Wise Sales Analysis | **Was missing** — products had a category, nothing aggregated it | **New:** `store_analytics()` returns it, chart in `views/analytics.js` |
| 22 | AI Customer Support | **Working** — AI drafts against the ticket thread | `views/support.js`, `ai/index.ts` (`support_reply`) |
| 23 | Centralised Customer Inbox | **Working** — one queue for tickets and messages | `views/support.js` |
| 24 | Customer Conversation Management | **Working** — threaded replies, status, priority | `views/support.js` |
| 25 | AI Reply Generation | **Working** — draft is generated, never auto-sent | `views/support.js` (`ai-draft`) |
| 26 | Automated Customer Replies | **Was missing** — every reply needed a human click | **New:** per-ticket auto-reply, opt-in, `ai` action `support_autoreply` + `support_set_auto_reply()` |
| 27 | Order-Status Notifications | **Was missing** — status changed silently | **New:** `order_set_status()` writes an event and notifies the customer |
| 28 | Live Order Tracking Links | **Was missing** | **New:** `order_tracking_link()`, `/track/?t=…`, timeline |
| 29 | Human Support Escalation | **Was missing** — no way to hand a ticket to a person | **New:** `support_escalate()` + an *Escalated* filter in the admin support queue |
| 30 | Customer Message History | **Partial** — one ticket's thread only | **New:** full history per customer in `views/support.js` |

## What "Working" means in this table

- The screen is reachable from the drawer and renders from real rows.
- The write goes through an RPC or RLS-scoped table; the browser never holds a
  service key.
- An empty database shows an honest empty state, not sample data.

## Still not built, stated plainly

- **Conversion rate needs traffic.** `store_visits` records visits that the
  published site sends in (`store_track_visit`). If a storefront never calls it,
  conversion shows "no visits recorded" rather than a made-up percentage.
- **Automated replies are opt-in per ticket**, run only when the helpdesk screen
  asks for them, and only when the customer spoke last. The reply is stored as
  `author_role = 'assistant'` so it is visibly machine-written. If the model says
  the answer needs a decision, auto-reply switches itself off on that ticket and
  the priority goes to high.
- **Natural-language commands execute a closed set**: `create_product`,
  `update_stock`, `set_order_status`, `add_customer`. The model chooses from
  that set; `assistant_command_apply()` rejects anything else, re-checks that the
  row belongs to the caller, and the browser shows the exact payload for
  confirmation before any write.
- **Order tracking links are unguessable but not expiring** — the token is a
  random 24-character value, and the owner can revoke it.

## Live status on 4 November 2026

What is running on `zmkgfmlcpzjfgxdmbtvi` right now, as opposed to what is in
this repository. All of it was verified against the live project, not inferred
from the source.

| Layer | State |
|-------|-------|
| Migration 0035 (store operations) | **Applied and verified** — 14 functions, 2 triggers, 4 tables, 4 order columns, 5 ticket columns |
| Migration 0036 (support roles) | **Applied and verified** — the check constraint accepts `owner`, `admin`, `system`, `assistant`, `customer` |
| Edge Function `ai` | **Deployed, version 24** — the downloaded bundle contains `data_analysis`, `command`, `COMMAND_ACTIONS`, `assistant_command_apply` and `support_autoreply` |
| Edge Function `admin` | **Deployed, version 14** — the bundle contains the `escalated` filter |
| Client (inventory, orders, analytics, support, assistant, `/track/`) | **Pushed to `main`** (`67d6994`) and live on the next Vercel build |
| Function contract | `node scripts/smoke-functions.mjs --remote` → every function refuses unauthenticated calls, leaks no secret, hides stack traces |

### What is still unproven, and why

Deploying a function proves it bundled and answers. It does not prove the three
new AI actions return a useful answer, because that needs a signed-in account and
a real generation — and creating a test account in the live project is a data
mutation nobody asked for. The checks that were run instead:

- `node --check` and the repo's static checks on every edited file,
- the deployed bundle grepped for each new action (above),
- 187 staging checks against a real Postgres (PGlite), covering the SQL behind
  every new screen,
- 19 new client assertions in `tests/store-operations.test.mjs`.

**Command** has since run signed in, against the deployed function:

| request | answer |
| --- | --- |
| `add a product in my inventory named KYLO and i have 64 only` | `understood: true`, `create_product`, `{name: "KYLO", price: 0, stock: 64}` — offered for confirmation, nothing written until Confirm |
| `mark my last order as shipped` (empty order list) | `understood: false`, `missing: ["orderId"]` — asks instead of inventing an order |

Both were made with a real session token against production; `handleCommand`
only logs usage, so the probe changed no store data. What is still unproven is
the **Confirm** button writing through `assistant_command_apply`, and the first
signed-in use of **Analyse with AI** and **automatic reply**. If any of them
misbehaves, the failure will be visible in the UI and in `ai_usage_log`, not
silent.

### Why the command path first failed with "malformed JSON"

`handleCommand` capped the answer at 500 output tokens, and on a thinking model
those tokens are shared with reasoning: the JSON arrived cut off mid-property.
`geminiJson` then sliced from the first `{` to the last `}`, found nothing
balanced, and reported a syntax problem that no retry could fix. The answer now
gets a 1600-token budget with `thinkingBudget: 0` and a `responseSchema`, and
`_shared/json-repair.ts` reads fences, prose, curly quotes and trailing commas
while refusing a truncated object instead of half-parsing it. `tests/json-repair.test.mjs`
holds 37 assertions for that, including truncate-then-succeed.

### One repository fix made during the deploy

`supabase/config.toml` declared `enabled = true` twice inside `[auth]`. Older
CLIs tolerated it; the current one refuses to parse the file, which blocked every
deploy. The duplicate line was removed and the file now parses as TOML.
