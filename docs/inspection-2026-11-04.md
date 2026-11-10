# Database inspection — 2026-11-04

Project: `zmkgfmlcpzjfgxdmbtvi` (production). Read-only inspection before phase-3 work.

## What already exists and is reusable

| Area | Object | State |
|---|---|---|
| Identity | `profiles.username` (unique), `account_type`, `avatar_url`, `full_name`, `email` | Present, 10 rows, 9 distinct handles |
| Business (team record) | `businesses.name`, `logo_url`, `socials`, `discoverable` | Single source of truth — changing it propagates everywhere, no copies to sync |
| Agent profile | `freelancer_profiles` (26 cols): skills, years_experience, expected_rate, hours_per_week, seeking, equity_ok/esop_ok, notice_period, remote_ok, portfolio_url, rating | Covers every onboarding question from the brief; only 1 row so far |
| Projects | `marketplace_jobs`: title, theme, website_url, requirements, skills, budget, status | Matches the "post a project" form |
| Pitches | `marketplace_proposals`: cover_note, bid_amount, delivery_days, status, `answers jsonb` | Screening answers already keyed by question |
| Screening | `marketplace_job_questions` (job_id, position, prompt) | Present |
| Contracts | `marketplace_contracts` (job, proposal, client, freelancer, status) | Present, 0 rows |
| Team | `business_team_members`, `business_team_invites`, 11 `team_*` RPCs | Schema + logic sound |
| Notifications | `notifications`: title, message, body, type, link, meta, read_at | 51 rows, 3 policies |

## Gaps found

1. **Invitations are a black hole (the reported bug).** `team_invite_user` writes a row; the
   client never calls `team_my_invitations` or `team_accept_invite` — grep returns zero hits in
   `public/js/`. Evidence: 1 open invite, **0** `business_team_members`, 0 conversations. The
   invited person has no screen listing invitations and no accept button.
   Also missing: a **decline** path, and search by *handle* (only exact email works today).
2. **No community.** No `community_*` tables at all. Internal team chat exists but is
   per-conversation and attachment-enabled; the brief asks for a public text-only room.
3. **Portfolio is one URL.** `freelancer_profiles.portfolio_url` is a single link. No portfolio
   items table, no résumé/CV field, no experience history, no social links.
4. **No pitch decision.** `marketplace_proposals.status` exists but no RPC moves it, and nothing
   creates the `marketplace_contracts` row on approval.
5. **No marketplace notifications.** Jobs/proposals/contracts have no triggers emitting into
   `notifications`; the 51 existing rows are account/admin events.
6. **`business_team_invites` has 0 RLS policies** — safe only because every access is via
   `SECURITY DEFINER` RPCs. Any future direct select silently returns nothing. Documented, not
   changed.

## Decision

Reuse everything in the first table. Migration `0024` adds only: community tables + RPCs,
portfolio items / résumé / experience / socials, richer invitation listing + decline + handle
search, pitch approve/reject, and a notification fan-out helper wired to the triggering events.
