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

What is actually running on `zmkgfmlcpzjfgxdmbtvi` right now, as opposed to what
is in this repository:

| Layer | State |
|-------|-------|
| Migrations 0035 (store operations) | **Applied and verified** — 14 functions, 2 triggers, 4 tables, 4 order columns, 5 ticket columns |
| Migration 0036 (support roles) | **Applied and verified** — the check constraint now accepts `owner`, `admin`, `system`, `assistant`, `customer` |
| Client (inventory, orders, analytics, support, assistant, `/track/`) | **Shipped in this commit** — every screen reads and writes through the RPCs above |
| Edge Function `ai` | **Not redeployed** — the new `data_analysis`, `command` and `support_autoreply` actions exist in `supabase/functions/ai/index.ts` but the deployment is still version 23, which only knows `chat`, `generate`, `build_*`, `revise`, `domain_ideas`, `copy`, `support_reply`, `research` and `models` |
| Edge Function `admin` | **Not redeployed** — the `escalated` filter exists in source only |

The deploy is blocked, not forgotten: `SUPABASE_ACCESS_TOKEN` in `.env` returns
`401 Invalid access token`, and both `supabase functions deploy` and the
Management API need a valid one. There is no workaround that does not either
duplicate the AI gateway or serve function source from a third party, and both
are worse than waiting for a real token.

    # once a valid token is in .env
    node scripts/deploy-functions.mjs ai admin

Until then the three affected screens degrade honestly rather than breaking:

- **Analytics → "Analyse with AI"** says the updated function is not deployed.
  Every number on the page is still real; they come from `store_analytics()`.
- **Assistant → command bar** says the same, and changes nothing in the store.
  The chat half keeps working — `chat` is deployed.
- **Support → automatic replies** saves the per-ticket switch (that is a
  database write, and it works), then reports that nothing was sent.
