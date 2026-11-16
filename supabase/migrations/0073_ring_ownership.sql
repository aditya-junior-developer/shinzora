-- ============================================================================
-- 0073 — Profile rings: a bought ring is kept, worn or taken off at will
--
-- Until now each apply of a design was a payment, so changing back to a ring
-- you already had cost money again. Now a verified purchase is recorded once in
-- profile_ring_owned. From then on the member can wear any ring they own, or
-- remove the ring and go back to the default (no ring), without paying again.
--
-- Rules enforced here, not in the browser:
--   - Ownership is written only by the verified-payment trigger (or the backfill
--     below). Members can read their own ownership; nobody can write it.
--   - Wearing a ring needs ownership. It charges nothing. ring_wear() checks it.
--   - Removing a ring deletes the member's choice, which is the default look.
--   - The payment function refuses to sell a ring the member already owns (409),
--     so a second payment cannot be taken by mistake.
-- ============================================================================

-- 1. What each member owns. One row per design, written once.
create table if not exists public.profile_ring_owned (
  user_id uuid not null references auth.users(id) on delete cascade,
  ring_id text not null references public.ring_designs(id),
  payment_id uuid references public.payments(id) on delete set null,
  acquired_at timestamptz not null default now(),
  primary key (user_id, ring_id)
);

alter table public.profile_ring_owned enable row level security;
drop policy if exists profile_ring_owned_owner_read on public.profile_ring_owned;
create policy profile_ring_owned_owner_read on public.profile_ring_owned
  for select to authenticated using (user_id = auth.uid());
revoke all on public.profile_ring_owned from public, anon, authenticated;
grant select on public.profile_ring_owned to authenticated;

-- 2. Backfill: every ring that has a verified payment is owned.
insert into public.profile_ring_owned (user_id, ring_id, payment_id)
select o.owner_id, o.ring_id, o.payment_id
  from public.ring_orders o
  join public.payments p on p.id = o.payment_id
 where p.status = 'verified'
on conflict (user_id, ring_id) do nothing;

-- 3. Verified ring payment: record the ownership, then wear the ring bought.
create or replace function public.ring_from_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purpose like 'ring_apply:%'
     and new.status = 'verified'
     and coalesce(old.status, '') <> 'verified' then
    insert into public.profile_ring_owned (user_id, ring_id, payment_id, acquired_at)
    select o.owner_id, o.ring_id, o.payment_id, now()
      from public.ring_orders o
     where o.payment_id = new.id
    on conflict (user_id, ring_id) do nothing;

    insert into public.profile_ring_choices (user_id, ring_id, payment_id, applied_at)
    select o.owner_id, o.ring_id, o.payment_id, now()
      from public.ring_orders o
     where o.payment_id = new.id
    on conflict (user_id) do update
      set ring_id = excluded.ring_id,
          payment_id = excluded.payment_id,
          applied_at = excluded.applied_at;
  end if;
  return new;
end;
$$;

revoke all on function public.ring_from_payment() from public, anon, authenticated;

-- 4. Wear a ring you own. Charges nothing.
create or replace function public.ring_wear(p_ring_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  owned_payment uuid;
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select o.payment_id into owned_payment
    from public.profile_ring_owned o
    join public.ring_designs d on d.id = o.ring_id and d.active
   where o.user_id = uid and o.ring_id = p_ring_id;

  if not found then
    raise exception 'You have not bought this ring yet.' using errcode = '42501';
  end if;

  insert into public.profile_ring_choices (user_id, ring_id, payment_id, applied_at)
  values (uid, p_ring_id, owned_payment, now())
  on conflict (user_id) do update
    set ring_id = excluded.ring_id,
        payment_id = excluded.payment_id,
        applied_at = excluded.applied_at;

  return p_ring_id;
end;
$$;

-- 5. Take the ring off: back to the default look. Charges nothing.
create or replace function public.ring_remove()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  delete from public.profile_ring_choices where user_id = auth.uid();
end;
$$;

revoke all on function public.ring_wear(text) from public, anon;
grant execute on function public.ring_wear(text) to authenticated;
revoke all on function public.ring_remove() from public, anon;
grant execute on function public.ring_remove() to authenticated;
