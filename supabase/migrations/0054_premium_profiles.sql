-- ============================================================================
-- 0054 — Premium profiles (P6)
--
-- Flow, end to end:
--   1. The member pays through the existing payments gateway. The payment has
--      purpose 'premium:glow' or 'premium:elite' and is created 'pending'.
--   2. A verified payment (admin approval, or a signed provider webhook) moves
--      to status 'verified'. The trigger below then opens a premium order that
--      is due within 24 hours.
--   3. An administrator activates the order from the admin panel. The admin
--      Edge Function (service role) writes profile_entitlements and marks the
--      order activated. Nothing else can grant a tier.
--
-- Rules enforced here, not in the browser:
--   - Entitlements are readable by their owner and admins, never writable by
--     the browser. The only browser write is set_premium_accent(), which checks
--     the caller's tier and a fixed palette on the server.
--   - An order exists only for a verified payment. Its payment is unique, so a
--     replayed trigger or webhook cannot create a second order.
--   - Prices live in supabase/functions/payments/index.ts. They are not stored
--     here, so a price change cannot be made from the client.
-- ============================================================================

create table if not exists public.premium_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  payment_id uuid not null unique references public.payments(id) on delete restrict,
  tier text not null check (tier in ('glow', 'elite')),
  status text not null default 'awaiting_activation'
    check (status in ('awaiting_activation', 'activated', 'cancelled')),
  due_by timestamptz not null,
  activated_at timestamptz,
  activated_by uuid,
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.premium_orders is
  'One row per verified premium payment. Activation is due within 24 hours (due_by). Written by the payment trigger and the admin function only.';

create index if not exists premium_orders_status_idx on public.premium_orders (status, due_by);
create index if not exists premium_orders_owner_idx on public.premium_orders (owner_id, created_at desc);

create table if not exists public.profile_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null check (tier in ('glow', 'elite')),
  accent text check (accent is null or accent in ('violet', 'rose', 'amber', 'teal', 'sky')),
  granted_order_id uuid references public.premium_orders(id) on delete set null,
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profile_entitlements is
  'The premium tier a member has been activated for. Only the admin Edge Function writes tier; the owner may change accent through set_premium_accent().';

-- ---------------------------------------------------------------------------
-- A verified premium payment opens exactly one order, due in 24 hours.
-- ---------------------------------------------------------------------------
create or replace function public.premium_order_from_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
begin
  if new.purpose like 'premium:%'
     and new.status = 'verified'
     and coalesce(old.status, '') <> 'verified' then
    v_tier := split_part(new.purpose, ':', 2);
    if v_tier not in ('glow', 'elite') then
      return new;
    end if;

    insert into public.premium_orders (owner_id, payment_id, tier, due_by)
    values (new.owner_id, new.id, v_tier, now() + interval '24 hours')
    on conflict (payment_id) do nothing;

    insert into public.notifications (user_id, title, body, type, link)
    values (
      new.owner_id,
      'Premium payment received',
      'Your ' || initcap(v_tier) || ' profile payment is confirmed. We activate it within 24 hours and let you know when it is live.',
      'payment',
      '/app/?view=billing'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.premium_order_from_payment() from public, anon, authenticated;

drop trigger if exists payments_premium_order on public.payments;
create trigger payments_premium_order
  after update on public.payments
  for each row execute function public.premium_order_from_payment();

-- ---------------------------------------------------------------------------
-- Row level security. Owners read their own rows; nobody writes them directly.
-- ---------------------------------------------------------------------------
alter table public.premium_orders enable row level security;
alter table public.profile_entitlements enable row level security;

revoke all on public.premium_orders from anon, authenticated;
revoke all on public.profile_entitlements from anon, authenticated;
grant select on public.premium_orders to authenticated;
grant select on public.profile_entitlements to authenticated;

drop policy if exists premium_orders_owner_read on public.premium_orders;
create policy premium_orders_owner_read on public.premium_orders
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

drop policy if exists profile_entitlements_owner_read on public.profile_entitlements;
create policy profile_entitlements_owner_read on public.profile_entitlements
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- The only browser write: an Elite member picks an accent from a fixed palette.
-- ---------------------------------------------------------------------------
create or replace function public.set_premium_accent(p_accent text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select tier into v_tier from public.profile_entitlements where user_id = auth.uid();
  if v_tier is null then
    raise exception 'Premium profiles are not active on this account.' using errcode = '42501';
  end if;
  if v_tier <> 'elite' then
    raise exception 'Accent colours are part of the Elite profile.' using errcode = '42501';
  end if;
  if p_accent is not null and p_accent not in ('violet', 'rose', 'amber', 'teal', 'sky') then
    raise exception 'Unknown accent colour.' using errcode = '22023';
  end if;

  update public.profile_entitlements
     set accent = p_accent, updated_at = now()
   where user_id = auth.uid();
end;
$$;

revoke all on function public.set_premium_accent(text) from public, anon;
grant execute on function public.set_premium_accent(text) to authenticated;
