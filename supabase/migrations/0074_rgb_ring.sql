-- ============================================================================
-- 0074 — RGB ring: a separate paid feature (₹30), never mixed with PFP rings
--
-- The RGB ring is its own product. It is not one of the eight PFP designs and
-- it is not sold as one. Rules, enforced here and not in the browser:
--   - Owning the RGB ring is recorded once, by a verified 'rgb_ring' payment.
--     Only that trigger writes profile_rgb_owned. Members can read their own row.
--   - Only an owner can wear the RGB ring (rgb_wear() checks ownership). It is
--     free to wear, change or remove after the one purchase.
--   - A member wears EITHER a PFP design OR the RGB ring, never both. Wearing one
--     clears the other, so the two features are never drawn together.
--   - Removing the ring (ring_remove) clears whatever is worn: the default look.
--     Ownership of either feature is kept.
--   - member_rings() returns 'rgb' for a member who is wearing the RGB ring, and
--     the design id otherwise. Nothing about the payment is returned.
-- ============================================================================

-- 1. Who owns the RGB ring. One row per member, written once.
create table if not exists public.profile_rgb_owned (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payment_id uuid references public.payments(id) on delete set null,
  acquired_at timestamptz not null default now()
);

alter table public.profile_rgb_owned enable row level security;
drop policy if exists profile_rgb_owned_owner_read on public.profile_rgb_owned;
create policy profile_rgb_owned_owner_read on public.profile_rgb_owned
  for select to authenticated using (user_id = auth.uid());
revoke all on public.profile_rgb_owned from public, anon, authenticated;
grant select on public.profile_rgb_owned to authenticated;

-- 2. Whether the member is wearing the RGB ring. A row means it is on.
create table if not exists public.profile_rgb_choices (
  user_id uuid primary key references auth.users(id) on delete cascade,
  applied_at timestamptz not null default now()
);

alter table public.profile_rgb_choices enable row level security;
drop policy if exists profile_rgb_choices_owner_read on public.profile_rgb_choices;
create policy profile_rgb_choices_owner_read on public.profile_rgb_choices
  for select to authenticated using (user_id = auth.uid());
revoke all on public.profile_rgb_choices from public, anon, authenticated;
grant select on public.profile_rgb_choices to authenticated;

-- 3. Verified 'rgb_ring' payment: record the ownership. Runs once per payment.
create or replace function public.rgb_from_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purpose = 'rgb_ring'
     and new.status = 'verified'
     and coalesce(old.status, '') <> 'verified' then
    insert into public.profile_rgb_owned (user_id, payment_id, acquired_at)
    values (new.owner_id, new.id, now())
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.rgb_from_payment() from public, anon, authenticated;

drop trigger if exists payments_rgb_owned on public.payments;
create trigger payments_rgb_owned
  after update of status on public.payments
  for each row execute function public.rgb_from_payment();

-- 4. Wear a PFP design. Charges nothing. Clears the RGB ring (one at a time).
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

  delete from public.profile_rgb_choices where user_id = uid;

  insert into public.profile_ring_choices (user_id, ring_id, payment_id, applied_at)
  values (uid, p_ring_id, owned_payment, now())
  on conflict (user_id) do update
    set ring_id = excluded.ring_id,
        payment_id = excluded.payment_id,
        applied_at = excluded.applied_at;

  return p_ring_id;
end;
$$;

-- 5. Wear the RGB ring. Needs the one-time purchase. Clears the PFP design.
create or replace function public.rgb_wear()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profile_rgb_owned where user_id = uid) then
    raise exception 'You have not bought the RGB ring yet.' using errcode = '42501';
  end if;

  delete from public.profile_ring_choices where user_id = uid;

  insert into public.profile_rgb_choices (user_id, applied_at)
  values (uid, now())
  on conflict (user_id) do update set applied_at = excluded.applied_at;

  return 'rgb';
end;
$$;

-- 6. Take the ring off (a PFP design or the RGB ring): back to the default look.
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
  delete from public.profile_rgb_choices where user_id = auth.uid();
end;
$$;

-- 7. The rings for a list of members: the worn design or 'rgb', and its name.
create or replace function public.member_rings(p_user_ids uuid[])
returns table (member_id uuid, ring_id text, ring_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  if p_user_ids is null or cardinality(p_user_ids) = 0 then
    return;
  end if;

  if cardinality(p_user_ids) > 200 then
    raise exception 'member_rings takes at most 200 members per call'
      using errcode = '22023';
  end if;

  return query
    select c.user_id, c.ring_id, d.name
      from public.profile_ring_choices c
      join public.ring_designs d on d.id = c.ring_id and d.active
     where c.user_id = any (p_user_ids)
    union all
    select r.user_id, 'rgb'::text, 'RGB ring'::text
      from public.profile_rgb_choices r
     where r.user_id = any (p_user_ids);
end;
$$;

comment on function public.member_rings(uuid[]) is
  'The profile ring of up to 200 members: a PFP design id or ''rgb'', and its name. Nothing about the payment is returned.';

revoke all on function public.member_rings(uuid[]) from public, anon;
grant execute on function public.member_rings(uuid[]) to authenticated;

revoke all on function public.ring_wear(text) from public, anon;
grant execute on function public.ring_wear(text) to authenticated;
revoke all on function public.ring_remove() from public, anon;
grant execute on function public.ring_remove() to authenticated;

revoke all on function public.rgb_wear() from public, anon;
grant execute on function public.rgb_wear() to authenticated;
