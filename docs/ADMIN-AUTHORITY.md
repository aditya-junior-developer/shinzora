# Administrator authority — what migration 0009 installs

Phase 3, 7 November 2026. Written after the migration was proven on staging;
nothing here describes behaviour that has not been exercised.

Applied to production? **No.** See §6.

---

## 1. The defect this fixes

The console could only ever show the signed-in administrator. That was not a
rendering bug: `admin_users` in `0002_functions_rls.sql` has exactly one policy,
`admin_users_self`, which allows a user to read **their own row**. With no write
path anywhere, the page said so in as many words — "administrator rights can only
be granted by running the bootstrap migration".

Two consequences followed. Nobody could see the platform's real administrators,
and there was no way to see the platform's real users in one place with their
roles.

## 2. What now exists

| Object | Kind | What it does |
| --- | --- | --- |
| `admin_users_admin_read` | policy | lets an administrator read the whole table (writes stay function-only) |
| `admin_users.protected` | column | marks the recovery account — exactly one row, set by the migration, changeable by nothing |
| `admin_users.granted_by / granted_at / updated_at` | columns | provenance for every role |
| `admin_directory()` | function | every account with role, plan, credits, project count, joined date. Refuses non-administrators. |
| `set_admin_role(user, role, reason)` | function | the **only** write path to `admin_users` |
| `admin_reset_ai_credits(user, reason)` | function | zeroes `ai_credits_used`, super administrators only |
| `admin_update_subscription(user, plan, status, reason)` | function | validates the plan, records a `subscription_events` row |
| `admin_delete_payment(payment, reason, hard)` | function | void / archive / delete, by the rules in §4 |
| `admin_archive_record(table, id, reason)` | function | tickets, contact messages, announcements, activity |
| `admin_audit` + `admin_audit_log(limit)` | table + function | the trail: actor, role, action, target, reason, before, after |
| `subscription_events`, `inventory_movements` | tables | plan/credit history and stock history |
| `support_tickets.archived_at`, `contact_messages.archived_at`, `admin_announcements.deleted_at`, `customer_activity.deleted_at` | columns | archiving instead of destruction |

## 3. The two roles, and the guards between them

**Administrator** — customers, subscriptions, payments, service requests,
support, contact messages, announcements, monitoring. Cannot create or remove
administrators. Cannot promote themselves.

**Super administrator** — everything above, plus `set_admin_role()` and
`admin_reset_ai_credits()`.

Four guards, each enforced in SQL rather than in a view:

1. **Escalation.** `set_admin_role()` raises `42501` unless `is_superadmin()`
   answers true for the caller. An administrator calling it is refused by the
   database, not by a hidden button.
2. **Protected owner.** The founding super administrator is flagged
   `protected = true`. Any attempt to demote or revoke them — including by
   themselves, including by another super administrator — is refused with
   "The protected owner account cannot be demoted or revoked".
3. **Last super administrator.** A demotion that would leave zero rows with
   `role = 'superadmin'` is refused with "This is the last super administrator.
   Promote another account first."
4. **The trail.** Every privileged call writes `admin_audit`. There is **no**
   policy granting any client role select/insert/update/delete on that table; it
   is readable only through `admin_audit_log()`. An administrator cannot edit or
   erase what they did.

Prompting for a reason is a UI convention; `admin_delete_payment()` refuses a
reason shorter than three characters at the database level.

## 4. Deletion rules, in the database

Agreed with the owner on 7 November 2026, and implemented in
`admin_delete_payment()` — not in a view, so every path obeys it:

| Payment state | What happens | Why |
| --- | --- | --- |
| `verified` | **voided**: `deleted_at`, `voided_at`, `void_reason` set; row kept | money moved; the books must stay answerable |
| `awaiting_verification` | voided, never hard-deleted | the customer says they paid; that claim must remain inspectable |
| `refunded` | voided | same as verified |
| `pending` / `rejected` / `cancelled` | archived by default; hard delete only when explicitly requested | no money ever moved |
| hard delete | full row copied into `admin_audit.before` first | even a delete is explainable afterwards |

Voided rows disappear from the customer's own billing list because the *policy*
excludes `deleted_at is not null` — not because a view remembered to filter.

## 5. Tests

**Real PostgreSQL 18 (PGlite staging), 25 checks under `[0009]`** — part of
`node scripts/staging-db.mjs`, which now runs **84 checks, 0 failed**, including
idempotency of all nine migrations. The authority checks include:

- a customer is refused `admin_directory()`, `set_admin_role()`, credit resets,
  subscription changes, payment removal and archiving
- an **administrator** is refused role changes and credit resets
- the protected owner cannot be demoted or revoked, and is unchanged afterwards
- the last super administrator cannot be removed (isolated from the protected
  rule by temporarily clearing the flag, then restored)
- a second super administrator can be created and demoted
- the audit trail records role changes, revokes, voids, hard deletes and
  archives, each with actor and reason, and cannot be read or deleted directly
  by a client
- a verified payment is voided and survives; an `awaiting_verification` payment
  is never hard-deleted; a `pending` payment can be deleted and its snapshot is
  in the audit trail; a reasonless removal is refused
- a stock change is recorded by a trigger with before/after/delta
- an archived ticket leaves the customer's list and keeps its row

**Sandbox backend, 58 checks** — `node tests/admin-authority.test.mjs`: the same
rules against the file-store mirror the local preview uses.

**Browser, 17 checks** — `node tests/browser/admin-access.mjs`: the real console
against the real backend, with a pre-launch administrator session. It promotes
the customer, checks the audit row appears with its reason, revokes it again, and
confirms the protected owner has no revoke control and no page errors occur.

## 6. Deployment — not done, and what it needs

Nothing in §2 exists in the live project yet. The migration is authored and
staging-proven only. **The step-by-step procedure — backup, order, secrets,
deployment, protected-owner verification, rollback and post-deployment tests —
is `docs/PRODUCTION-DEPLOYMENT-CHECKLIST.md`.** In short:

1. **Back up first** — `node scripts/db-backup.mjs` (needs the same credential
   that applying needs).
2. Apply `0006`, `0007`, `0008`, then `0009`, in order: either set
   `SUPABASE_ACCESS_TOKEN` in `.env` and run `node scripts/apply-migrations.mjs`,
   or paste each file into the SQL editor (0009 is safe to re-run).
3. Deploy the updated `admin` Edge Function — the console needs the new actions
   (`directory`, `set_role`, `reset_credits`, `subscription_change`,
   `payment_delete`, `archive_record`, `audit`, `monitor`). Until it is deployed,
   the Access page will report that the directory function does not exist.
   `npx supabase functions deploy admin --project-ref zmkgfmlcpzjfgxdmbtvi`

The earlier migrations have the same requirement, so one access token covers all
of it.

**What 0009 does to existing rows:** adds columns with defaults, sets exactly one
`protected` flag on the earliest super administrator, and creates tables. It
deletes nothing and rewrites no payment. The staging run proves it against a
database that already contains duplicate payments and pre-tracking service
requests.
