# Database

Postgres 15 on Supabase. 28 tables, RLS on every one, and a small set of `SECURITY DEFINER` functions that own the
decisions a client must not make.

Run order: `0001_schema.sql` → `0002_functions_rls.sql` → `0003_storage_realtime.sql` → `0004_admin_bootstrap.sql` → `0005_schema_compat.sql` → `0006_service_request_tracking.sql`.
Every file is idempotent (`create table if not exists`, `add column if not exists`, `drop policy if exists` before
`create policy`).

---

## Money

All monetary columns are `numeric(12,2)` holding **paise** (minor units). ₹2,499 is `249900`. Prices are defined
server-side in `functions/payments/index.ts`; the client's amount is ignored entirely.

---

## Tables

### Identity and profile

| Table | Key columns | Notes |
| --- | --- | --- |
| `profiles` | `id` (= `auth.users.id`), `full_name`, `email`, `phone`, `avatar_url`, `role`, `last_sign_in_at` | Created by the `handle_new_user` trigger. Email and last sign-in are kept in sync by `sync_profile_email`. |
| `businesses` | `owner_id`, `name`, `category`, `description`, `location`, `target_audience`, `stage`, `goals jsonb`, `brand_colors jsonb`, `website_style` | The context the AI reads before generating. |
| `onboarding_progress` | `user_id` (PK), `current_step` 1–6, `data jsonb`, `completed_at` | Makes the wizard resumable across devices. |
| `subscriptions` | `user_id` (unique), `plan` check(free/pro/enterprise), `status`, `ai_credits_used`, `ai_credits_limit`, `ai_period_start`, `current_period_end` | Read-only to owners. Written by the service role when a payment is approved. |

### Projects and AI

| Table | Key columns | Notes |
| --- | --- | --- |
| `projects` | `owner_id`, `name`, `type` (website/app/store), `status` (draft/ready/published), `slug` (unique per case), `framework`, `preview_data jsonb`, `version_count`, `published_version_id`, `published_at` | Slug is what `/site/?p=` and `slug.shinzora.in` resolve. |
| `project_versions` | `project_id`, `version_number` (unique per project), `prompt`, `files jsonb`, `meta jsonb` (entry, seo, design_system, pages, model, notes), `created_by` | Immutable generations. `bump_project_version_count` keeps `version_count` honest. |
| `ai_conversations` | `user_id`, `title`, `kind`, `project_id` | Assistant threads. |
| `ai_messages` | `conversation_id`, `role` (user/assistant/system), `content`, `meta` | Ordered history used as model context. |
| `ai_usage_log` | `user_id`, `mode`, `model`, `input_tokens`, `output_tokens`, `credits`, `ok`, `error` | Written by functions only; powers quota auditing. |

### Commerce

| Table | Key columns |
| --- | --- |
| `store_products` | `owner_id`, `name`, `sku`, `price`, `stock`, `status` (active/draft/archived), `image_url` |
| `store_customers` | `owner_id`, `name`, `email`, `phone`, `city`, `notes`, `source` |
| `store_orders` | `owner_id`, `order_number?`, `customer_name`, `customer_email`, `status`, `total_amount`, `placed_at` |
| `store_order_items` | `order_id`, `product_id`, `product_name`, `quantity`, `unit_price` |

Order statuses: `pending`, `paid`, `processing`, `shipped`, `delivered`, `cancelled`, `refunded`, `fulfilled`.
Transitions are explicit UI actions and each one is written to `customer_activity`.

### Money in

| Table | Key columns | Notes |
| --- | --- | --- |
| `payments` | `owner_id`, `reference` (unique), `purpose`, `label`, `amount`, `method`, `status`, `utr`, `paid_at`, `admin_note`, `verified_by`, `verified_at`, `provider`, `provider_payment_id` | **No client write policy.** `guard_payment_status` refuses `verified` unless the caller is an administrator or the service role. |
| `domain_orders` | `owner_id`, `domain_name`, `price`, `years`, `provider`, `status`, `payment_id`, `registrar_order_id` | Server-side prices only. |

`purpose` is a namespaced string: `subscription:pro`, `service:website_setup`, `domain:<order-id>`. Approval applies the
effect (`subscriptions` upsert, `service_requests` approval, `domain_orders` → paid) inside
`functions/admin/index.ts#applyPaymentEffect`.

### Sites, domains, delivery

| Table | Key columns |
| --- | --- |
| `domains` | `owner_id`, `project_id`, `fqdn` (unique), `provider`, `status`, `dns_records jsonb`, `expires_at`, `verified_at` |
| `integrations` | `owner_id`, `provider` (github/vercel), `account_name`, `scopes`, unique per owner+provider |
| `integration_tokens` | `owner_id`, `provider`, `access_token` (optionally AES-GCM sealed), **RLS on, zero policies** |
| `deployments` | `owner_id`, `project_id`, `version_id`, `provider`, `repo_full_name`, `commit_sha`, `external_id`, `url`, `status` (queued/building/ready/error/cancelled) |

### Communication and operations

| Table | Key columns |
| --- | --- |
| `notifications` | `user_id`, `title`, `body`, `type`, `link`, `meta`, `read_at` |
| `admin_announcements` | `title`, `body`, `audience`, `created_by`, `published_at`, `expires_at` |
| `support_tickets` | `owner_id`, `subject`, `message`, `ticket_type`, `status`, `priority`, `assigned_to` |
| `support_replies` | `ticket_id`, `author_id`, `author_role` (owner/admin/system), `body` |
| `service_requests` | `owner_id`, `service_type`, `title`, `details`, `amount`, `status`, `admin_note`, `payment_id` |
| `customer_activity` | `user_id`, `action`, `entity_type`, `entity_id`, `meta` |
| `campaigns` | `owner_id`, `name`, `channel`, `status`, `goal`, `budget`, `plan jsonb` |
| `contact_messages` | `name`, `email`, `phone`, `company`, `topic`, `message`, `status` |
| `admin_users` | `user_id` (PK), `email`, `role` (admin/support/superadmin) |

---

## Functions

| Function | Security | Purpose |
| --- | --- | --- |
| `is_admin(user uuid default auth.uid())` | definer | Reads `admin_users`. Used by every admin policy. |
| `admin_role()` | definer | Returns the caller's role string, or null. |
| `handle_new_user()` | definer | On `auth.users` insert: profile, free subscription, onboarding row, welcome notification. |
| `sync_profile_email()` | definer | Keeps `profiles.email` / `last_sign_in_at` current. |
| `ai_usage_quota()` | definer, callable | `{plan, used, limit, remaining, period_start}`; resets the counter when the month rolls over. |
| `consume_ai_credit(user, mode, model, credits)` | definer, service-role only | Atomic increment with a hard limit; returns `{ok:false, reason:'quota_exceeded'}` when exhausted. |
| `log_activity(action, entity_type, entity_id, meta)` | definer, callable | Writes an audit row attributed to `auth.uid()`. |
| `guard_payment_status()` | trigger | Blocks client-side `verified`; emits a notification on verification. |
| `bump_project_version_count()` | trigger | Recomputes `projects.version_count`. |
| `set_updated_at()` | trigger | Applied to every mutable table. |

`consume_ai_credit` and `integration_tokens` are the two objects the browser can never touch: one is revoked from
`anon`/`authenticated`, the other has RLS with no policies at all.

---

## RLS summary

| Access | Tables |
| --- | --- |
| Owner full CRUD | `businesses`, `onboarding_progress`, `projects`, `project_versions` (via project ownership), `ai_conversations`, `ai_messages`, `store_products`, `store_customers`, `store_orders`, `store_order_items`, `campaigns`, `support_tickets`, `support_replies` |
| Owner read, owner update of `read_at` | `notifications` |
| Owner read only | `subscriptions`, `payments`, `domains`, `domain_orders`, `service_requests` (insert allowed with `status='requested'`), `integrations`, `deployments`, `ai_usage_log`, `admin_users` (own row) |
| Owner insert + read | `customer_activity` |
| Anonymous read | `projects` where `status='published'`; the matching `project_versions` row only |
| Anonymous insert | `contact_messages` |
| Admin (`is_admin()`) | Read across every table above; writes happen through the `admin` Edge Function using the service role |
| Nobody (service role only) | `integration_tokens` |

---

## Storage

| Bucket | Public | Policies |
| --- | --- | --- |
| `avatars` | yes | public read; write/update/delete restricted to a `{userId}/…` folder |
| `brand-assets` | yes | public read; owner write/delete |
| `payment-proofs` | no | owner insert + read; admin read |

---

## Realtime

`notifications`, `projects` and `payments` are added to the `supabase_realtime` publication with `replica identity full`,
which is what drives the notification badge and drawer without polling.

---

## Migration safety

- No destructive statements. Columns are added, never dropped.
- Existing tables from a partial previous setup are upgraded with `add column if not exists`, so an earlier approximation
  of the schema converges rather than erroring.
- Policies are dropped and recreated, which makes re-running deterministic.
- `0004` refuses to run silently: if the placeholder email is unchanged it raises a notice and exits without granting
  anything.

Verify with `/system-check/`: it queries every table and RPC and reports what is missing.

## `0005_schema_compat.sql` — reconciling an older database

A database that already contained the early Shinzora tables is **not** brought up to date by `0001` alone.
`create table if not exists` skips the entire definition when the table is present — including every constraint
it declares. The `add column if not exists` statements that follow do add missing *columns*, which makes the
result look correct while it is still missing integrity guarantees and still holding live data in legacy columns.

`0005` closes that gap. It is written for exactly one situation: **existing rows that must survive**. It never
drops a column, a table or a row that the application can still reach.

### What it fixes

| Legacy shape | Target shape | How it is migrated |
| --- | --- | --- |
| `onboarding_progress.current_step` **TEXT** | `integer`, 1–6 | non-numeric values → `1`, out-of-range values clamped, then the type is converted |
| `onboarding_progress.answers` **JSONB** | `data` JSONB | copied where `data` is empty; the original column stays as an archive |
| `onboarding_progress.is_completed` **BOOLEAN** | `completed_at` | completed rows get a timestamp from `updated_at`/`created_at` |
| `notifications.message` | `body` | copied where `body` is null; a trigger keeps `is_read` in step with `read_at` |
| `notifications.is_read` | `read_at` | read rows get `read_at` backfilled |
| no subscription row for an old account | one row per account | created from `profiles.plan` when that column exists, otherwise `free` |
| duplicate subscription rows | `UNIQUE (user_id)` | newest row per user kept; a paid tier always wins a timestamp tie |
| missing checks / foreign keys | enforced | `subscriptions` plan + status checks, `business_id` FK, `ai_messages` role check, `ai_conversations.project_id` FK |

### What it deliberately will not do

- **Delete AI message history.** If `ai_messages` contains rows whose conversation no longer exists, the
  foreign key is *not* added and the run says so. Enforcing it would mean discarding customer content.
- **Invent a title.** Notifications without one stay nullable and are counted in the output.
- **Downgrade a paying customer.** When two subscription rows share a timestamp, the paid plan is kept.

Every step is guarded, so the file is safe to re-run, and it ends with a summary notice stating the resulting
`current_step` type and any constraint it could not add — the run certifies itself.

### Verifying it worked

Either run the confirm queries at the bottom of the file, or open `/system-check/` and read the
**Schema compatibility (0005)** line. That check reads the live column shapes back through PostgREST (it asks for
`onboarding_progress.data`, and compares `current_step` against a non-numeric value, which PostgREST rejects only
when the column is an integer) and fails with the exact remediation step when `0005` has not been applied.

### Tested against

`0005` was run against a PostgreSQL 17 replica of the deployed project's *legacy* schema, seeded with hostile rows
(text steps such as `abc` and `9`, duplicate subscriptions with an invalid status, an orphaned AI message, a
notification with no title). After the run:

- every row survived, with `answers` → `data` and `message` → `body` copied intact;
- `current_step` was `integer` and the range check rejected `99` and `NULL`;
- duplicate subscriptions were collapsed and `UNIQUE (user_id)` / plan / status / FK constraints rejected
  re-insertion, invalid plans, invalid statuses and dangling business ids;
- the resulting constraint set was **identical** to a clean `0001`→`0005` install, except the one foreign key that
  the orphaned row makes unsafe.

---

## `migration_archive`

Written by `0005_schema_compat.sql` before it removes or rewrites a row. It has RLS enabled and **no policies**, so it
is readable by the service role only.

| column | meaning |
| --- | --- |
| `migration` | which migration displaced the row |
| `table_name`, `row_id` | where the row came from |
| `reason` | `null user_id`, `duplicate subscription row`, `plan not in (…) — normalised to free`, … |
| `row_data` | the complete original row as JSONB |
| `archived_at` | when |

Restore a row with:

```sql
insert into public.subscriptions
select * from jsonb_populate_record(null::public.subscriptions,
  (select row_data from public.migration_archive where id = <id>));
```

Nothing is deleted from the archive automatically. Drop it only after you have reviewed it.

## Migration 0006 — service request tracking

Additive, safe on existing data. `service_requests` gains `reference`,
`assigned_to`, `due_at`, `accepted_at` and `completed_at`; existing rows are
backfilled with a reference derived from their own id and a completion
timestamp where the status is already terminal. A trigger keeps `reference`
populated on insert.

Internal notes live in `service_request_notes` (visibility `internal` or
`customer`) rather than on the request row, because RLS is row level: a note
on `service_requests` would be readable by the customer the moment they
select their own row. Customers have no insert policy on that table — their
channel is the support thread.
