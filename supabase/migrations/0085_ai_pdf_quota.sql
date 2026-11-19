-- ============================================================================
-- 0085 — AI PDF generation quota (applied to the live project, version 20261119053544)
-- ----------------------------------------------------------------------------
-- Counts successful AI-deck PDF exports per owner, per plan.
--   • Only SUCCESSFUL exports count. The edge function reserves a slot first,
--     then commits it after the PDF renders, or releases it if rendering fails.
--   • Limits live in a table, so a plan can be changed or added without a
--     code deploy. A plan with no row falls back to the free limit (2).
--   • Manual decks are excluded: their export is already a paid, one-off
--     entitlement (deck_exports).
--   • Re-downloading an existing PDF does not call these functions at all.
--     That requires storing the rendered PDF (see the note at the end).
-- ============================================================================

-- 1. Limits per plan. NULL means unlimited. Only the free plan is set here.
create table if not exists public.plan_ai_pdf_limits (
  plan text primary key,
  max_successful_pdfs integer check (max_successful_pdfs is null or max_successful_pdfs >= 0),
  updated_at timestamptz not null default now()
);

insert into public.plan_ai_pdf_limits (plan, max_successful_pdfs)
values ('free', 2)
on conflict (plan) do nothing;

alter table public.plan_ai_pdf_limits enable row level security;
revoke all on public.plan_ai_pdf_limits from public, anon, authenticated;
-- Read-only through the functions below. Writes happen by hand or in a later migration.

-- 2. One row per attempt.
create table if not exists public.ai_pdf_exports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  deck_id uuid not null references public.investor_decks(id) on delete cascade,
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'released')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists ai_pdf_exports_owner_idx on public.ai_pdf_exports (owner_id, status);

alter table public.ai_pdf_exports enable row level security;

drop policy if exists ai_pdf_exports_owner_read on public.ai_pdf_exports;
create policy ai_pdf_exports_owner_read on public.ai_pdf_exports
  for select to authenticated
  using (owner_id = auth.uid());

revoke all on public.ai_pdf_exports from public, anon;
grant select on public.ai_pdf_exports to authenticated;

-- 3. The owner's plan limit and how much is left.
create or replace function public.ai_pdf_allowance()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_plan text;
  v_limit integer;
  v_used integer;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  select coalesce(s.plan, 'free') into v_plan from public.subscriptions s where s.user_id = actor;
  v_plan := coalesce(v_plan, 'free');

  select l.max_successful_pdfs into v_limit from public.plan_ai_pdf_limits l where l.plan = v_plan;
  if not found then
    select l.max_successful_pdfs into v_limit from public.plan_ai_pdf_limits l where l.plan = 'free';
  end if;

  select count(*) into v_used
    from public.ai_pdf_exports e
   where e.owner_id = actor and e.status = 'succeeded';

  return jsonb_build_object(
    'plan', v_plan,
    'limit', v_limit,
    'used', v_used,
    'remaining', case when v_limit is null then null else greatest(v_limit - v_used, 0) end
  );
end;
$$;

-- 4. Reserve a slot before rendering. Refuses when the owner is at the limit.
create or replace function public.ai_pdf_reserve(p_deck uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_plan text;
  v_limit integer;
  v_taken integer;
  v_mode text;
  v_id uuid;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not public.is_account_type('owner') then
    raise exception 'Only business owners can export a deck.' using errcode = '42501';
  end if;

  select d.mode into v_mode from public.investor_decks d where d.id = p_deck and d.owner_id = actor;
  if not found then raise exception 'That deck was not found.' using errcode = 'P0002'; end if;
  if v_mode <> 'ai' then return null; end if;   -- manual decks are not metered here

  -- Serialise attempts for this owner so two parallel exports cannot both pass the check.
  perform pg_advisory_xact_lock(hashtext('ai_pdf:' || actor::text));

  select coalesce(s.plan, 'free') into v_plan from public.subscriptions s where s.user_id = actor;
  v_plan := coalesce(v_plan, 'free');

  select l.max_successful_pdfs into v_limit from public.plan_ai_pdf_limits l where l.plan = v_plan;
  if not found then
    select l.max_successful_pdfs into v_limit from public.plan_ai_pdf_limits l where l.plan = 'free';
  end if;

  -- Reserved attempts count too, so a second export in flight is not free.
  select count(*) into v_taken
    from public.ai_pdf_exports e
   where e.owner_id = actor and e.status in ('succeeded', 'reserved');

  if v_limit is not null and v_taken >= v_limit then
    raise exception 'You have used your % free AI PDF exports. Upgrade to make more.', v_limit
      using errcode = 'P0001', hint = 'ai_pdf_limit_reached';
  end if;

  insert into public.ai_pdf_exports (owner_id, deck_id, status)
  values (actor, p_deck, 'reserved')
  returning id into v_id;

  return v_id;
end;
$$;

-- 5. Commit after a successful render. Only a reservation the caller owns can be committed.
create or replace function public.ai_pdf_commit(p_export uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  update public.ai_pdf_exports
     set status = 'succeeded', finished_at = now()
   where id = p_export and owner_id = actor and status = 'reserved';
end;
$$;

-- 6. Release after a failed render, so the failure does not use up an allowance.
create or replace function public.ai_pdf_release(p_export uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  update public.ai_pdf_exports
     set status = 'released', finished_at = now()
   where id = p_export and owner_id = actor and status = 'reserved';
end;
$$;

revoke all on function public.ai_pdf_allowance() from public, anon;
revoke all on function public.ai_pdf_reserve(uuid) from public, anon;
revoke all on function public.ai_pdf_commit(uuid) from public, anon;
revoke all on function public.ai_pdf_release(uuid) from public, anon;
grant execute on function public.ai_pdf_allowance() to authenticated, service_role;
grant execute on function public.ai_pdf_reserve(uuid) to authenticated, service_role;
grant execute on function public.ai_pdf_commit(uuid) to authenticated, service_role;
grant execute on function public.ai_pdf_release(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Open decisions (not in this file):
--   a) Re-downloads of an existing AI PDF are free only if the rendered PDF is
--      stored (a private storage bucket keyed by export id). Without storage,
--      every download re-renders, so a re-download would have to be counted.
--   b) Paid plans need rows in plan_ai_pdf_limits. A plan with no row is limited
--      to the free allowance, so nothing is unlimited by accident.
-- ----------------------------------------------------------------------------
