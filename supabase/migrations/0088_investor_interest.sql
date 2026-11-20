-- ============================================================================
-- 0088 — Express interest in a listed business (investor portal, phase 2)
-- ----------------------------------------------------------------------------
-- An investor can say "I am interested" in a business that opted in
-- (investor_visible). The record is only the pair (investor, business) and the
-- time. The owner is told that an investor is interested, without the
-- investor's name, and can answer with a pitch in the next phase.
-- An investor sees only their own interests. Owners cannot read the table.
-- ============================================================================

create table if not exists public.investor_interests (
  investor_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (investor_id, business_id)
);

alter table public.investor_interests enable row level security;

drop policy if exists investor_interests_own_select on public.investor_interests;
create policy investor_interests_own_select on public.investor_interests
  for select to authenticated using (investor_id = auth.uid());

revoke all on public.investor_interests from anon, authenticated;
grant select on public.investor_interests to authenticated;

create or replace function public.express_investor_interest(p_business uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_owner uuid;
  v_name text;
  v_rows integer := 0;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.is_account_type('investor') then
    raise exception 'Only investor accounts can express interest.' using errcode = '42501';
  end if;

  select b.owner_id, b.name into v_owner, v_name
    from public.businesses b
   where b.id = p_business and b.investor_visible;
  if not found then
    raise exception 'That business is not available to investors.' using errcode = 'P0002';
  end if;

  insert into public.investor_interests (investor_id, business_id)
  values (uid, p_business)
  on conflict (investor_id, business_id) do nothing;
  get diagnostics v_rows = row_count;

  -- Tell the owner once, the first time this investor expresses interest.
  if v_rows > 0 then
    insert into public.notifications (user_id, title, message, type, link)
    values (v_owner, 'Investor interest',
            'An investor has expressed interest in ' || v_name || '.',
            'investor', '/app/?view=investor-decks');
  end if;

  return v_rows > 0;
end;
$$;

revoke all on function public.express_investor_interest(uuid) from public, anon;
grant execute on function public.express_investor_interest(uuid) to authenticated, service_role;
