-- ============================================================================
-- 0069 — Profile rings: eight designs, ₹10 each time one is applied
--
-- Replaces the tier rings (0066) and the ring settings (0068). A member chooses
-- one of eight ring designs. Each time they apply a design they pay ₹10 through
-- the `payments` Edge Function (purpose `ring_apply:<id>`). The design is applied
-- only when the payment is verified, through a trigger on the payments table,
-- the same way business profile fields are granted (0065).
--
-- Rules enforced here, not in the browser:
--   - Nothing is applied before the payment is verified.
--   - The price is fixed at 1000 paise per order; the browser never sets it.
--   - Members can read only their own orders and choice; other members' rings
--     are returned by member_rings(), which carries the design and nothing else.
--   - Only the verified-payment trigger writes the current choice.
--   - admin_ring_ledger() works only for administrators (is_admin()).
-- ============================================================================

-- Remove what 0066 and 0068 added.
drop function if exists public.admin_ring_ledger(integer);
drop function if exists public.member_rings(uuid[]);
drop function if exists public.ring_prefs_get();
drop function if exists public.ring_prefs_set(boolean, boolean);
drop table if exists public.profile_ring_prefs;

-- 1. The eight designs. The ids are the artwork file names in public/assets/rings.
create table if not exists public.ring_designs (
  id text primary key check (id ~ '^[a-z][a-z0-9-]{2,40}$'),
  name text not null check (char_length(btrim(name)) between 2 and 40),
  sort_order integer not null default 0,
  active boolean not null default true
);

insert into public.ring_designs (id, name, sort_order) values
  ('neon-crescent', 'Neon crescent', 1),
  ('neon-blossom', 'Neon blossom', 2),
  ('sakura', 'Sakura', 3),
  ('thorn-rose', 'Thorn and rose', 4),
  ('gothic-skull', 'Gothic skull', 5),
  ('tiger-gold', 'Tiger gold', 6),
  ('diamond-wings', 'Diamond wings', 7),
  ('pink-gold', 'Pink gold', 8)
on conflict (id) do update set name = excluded.name, sort_order = excluded.sort_order;

alter table public.ring_designs enable row level security;
drop policy if exists ring_designs_read on public.ring_designs;
create policy ring_designs_read on public.ring_designs
  for select to anon, authenticated using (active);
revoke all on public.ring_designs from public, anon, authenticated;
grant select on public.ring_designs to anon, authenticated;

-- 2. One row per ring order. Written by the Edge Function (service role).
create table if not exists public.ring_orders (
  payment_id uuid primary key references public.payments(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  ring_id text not null references public.ring_designs(id),
  amount_paise integer not null check (amount_paise = 1000),
  created_at timestamptz not null default now()
);

create index if not exists ring_orders_owner_idx on public.ring_orders (owner_id, created_at desc);

alter table public.ring_orders enable row level security;
drop policy if exists ring_orders_owner_read on public.ring_orders;
create policy ring_orders_owner_read on public.ring_orders
  for select to authenticated using (owner_id = auth.uid());
revoke all on public.ring_orders from public, anon, authenticated;
grant select on public.ring_orders to authenticated;

-- 3. The design each member currently wears. Only the trigger writes it.
create table if not exists public.profile_ring_choices (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ring_id text not null references public.ring_designs(id),
  payment_id uuid references public.payments(id) on delete set null,
  applied_at timestamptz not null default now()
);

alter table public.profile_ring_choices enable row level security;
drop policy if exists profile_ring_choices_owner_read on public.profile_ring_choices;
create policy profile_ring_choices_owner_read on public.profile_ring_choices
  for select to authenticated using (user_id = auth.uid());
revoke all on public.profile_ring_choices from public, anon, authenticated;
grant select on public.profile_ring_choices to authenticated;

-- 4. Verified ring payment -> apply the design. Runs once per payment.
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

drop trigger if exists payments_ring_choice on public.payments;
create trigger payments_ring_choice
  after update of status on public.payments
  for each row execute function public.ring_from_payment();

-- 5. The rings for a list of members: the design and its name, nothing else.
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
     where c.user_id = any (p_user_ids);
end;
$$;

comment on function public.member_rings(uuid[]) is
  'The profile ring (design id and name) of up to 200 members. Nothing about the payment is returned.';

revoke all on function public.member_rings(uuid[]) from public, anon;
grant execute on function public.member_rings(uuid[]) to authenticated;

-- 6. Admin ledger: ring orders with their payment. Administrators only.
create or replace function public.admin_ring_ledger(p_limit integer default 100)
returns table (
  order_id uuid,
  owner_id uuid,
  member_name text,
  member_email text,
  ring_id text,
  ring_name text,
  payment_amount numeric,
  payment_status text,
  payment_reference text,
  paid_at timestamptz,
  created_at timestamptz,
  applied boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;

  return query
    select o.payment_id,
           o.owner_id,
           pr.full_name,
           au.email::text,
           o.ring_id,
           d.name,
           pay.amount,
           pay.status,
           pay.reference,
           pay.paid_at,
           o.created_at,
           coalesce(c.payment_id = o.payment_id, false)
      from public.ring_orders o
      join public.payments pay on pay.id = o.payment_id
      left join public.ring_designs d on d.id = o.ring_id
      left join public.profiles pr on pr.id = o.owner_id
      left join auth.users au on au.id = o.owner_id
      left join public.profile_ring_choices c on c.user_id = o.owner_id
     order by o.created_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

revoke all on function public.admin_ring_ledger(integer) from public, anon;
grant execute on function public.admin_ring_ledger(integer) to authenticated;
