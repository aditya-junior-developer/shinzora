-- ============================================================================
-- 0068 — Ring management and the admin ring ledger (R8)
--
-- A Glow or Elite member can choose:
--   - animated or still ring (both tiers animate by default; Elite is faster)
--   - whether other members see their ring at all
-- Accent colour stays where it was (set_premium_accent, Elite only).
--
-- Rules enforced here, not in the browser:
--   - Only a member who holds Glow or Elite can change ring settings.
--   - Hiding a ring stops it reaching other members through member_rings(). It
--     never changes the tier, and the owner still sees their own ring.
--   - admin_ring_ledger() works only for administrators (is_admin()). It shows
--     each ring order with its payment amount, status and paid time, so an admin
--     can check a ring payment without opening Billing or the payment record.
--   - No new table is readable by the browser directly.
-- ============================================================================

create table if not exists public.profile_ring_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  animated boolean not null default true,
  shown boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.profile_ring_prefs enable row level security;
revoke all on public.profile_ring_prefs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The member's own settings. Defaults apply when no row exists yet.
-- ---------------------------------------------------------------------------
create or replace function public.ring_prefs_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_tier text;
  v_animated boolean := true;
  v_shown boolean := true;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select e.tier into v_tier from public.profile_entitlements e where e.user_id = actor;

  select p.animated, p.shown into v_animated, v_shown
    from public.profile_ring_prefs p
   where p.user_id = actor;

  return jsonb_build_object(
    'tier', v_tier,
    'tierOk', coalesce(v_tier in ('glow', 'elite'), false),
    'animated', coalesce(v_animated, true),
    'shown', coalesce(v_shown, true)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Save the member's settings. Only Glow or Elite may set them.
-- ---------------------------------------------------------------------------
create or replace function public.ring_prefs_set(p_animated boolean, p_shown boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_animated is null or p_shown is null then
    raise exception 'Choose animated or still, and whether to show your ring.' using errcode = '22023';
  end if;
  if public.theme_caller_rank() < 1 then
    raise exception 'Ring settings come with a Glow or Elite profile. Unlock it from Billing.'
      using errcode = '42501';
  end if;

  insert into public.profile_ring_prefs (user_id, animated, shown, updated_at)
  values (actor, p_animated, p_shown, now())
  on conflict (user_id) do update
    set animated = excluded.animated, shown = excluded.shown, updated_at = now();

  return jsonb_build_object('ok', true, 'animated', p_animated, 'shown', p_shown);
end;
$$;

-- ---------------------------------------------------------------------------
-- The rings for a list of members. Replaces the 0066 version, so the return
-- shape gains ring_animated. A hidden ring is returned only to its owner.
-- ---------------------------------------------------------------------------
drop function if exists public.member_rings(uuid[]);

create or replace function public.member_rings(p_user_ids uuid[])
returns table (member_id uuid, ring_tier text, ring_accent text, ring_animated boolean)
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
    select e.user_id,
           e.tier,
           case when e.tier = 'elite' then e.accent else null end,
           coalesce(p.animated, true)
      from public.profile_entitlements e
      left join public.profile_ring_prefs p on p.user_id = e.user_id
     where e.user_id = any (p_user_ids)
       and (e.user_id = auth.uid() or coalesce(p.shown, true));
end;
$$;

comment on function public.member_rings(uuid[]) is
  'The profile ring (tier, accent, animated) of up to 200 members. A member who hid their ring is returned only to themselves. Nothing else about a purchase is returned.';

revoke all on function public.member_rings(uuid[]) from public, anon;
grant execute on function public.member_rings(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin ledger: ring orders with their payment, for administrators only.
-- ---------------------------------------------------------------------------
create or replace function public.admin_ring_ledger(p_limit integer default 100)
returns table (
  order_id uuid,
  owner_id uuid,
  member_name text,
  member_email text,
  tier text,
  order_status text,
  payment_amount numeric,
  payment_status text,
  payment_reference text,
  paid_at timestamptz,
  due_by timestamptz,
  activated_at timestamptz,
  ring_shown boolean,
  created_at timestamptz
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
    select o.id,
           o.owner_id,
           pr.full_name,
           au.email::text,
           o.tier,
           o.status,
           pay.amount,
           pay.status,
           pay.reference,
           pay.paid_at,
           o.due_by,
           o.activated_at,
           coalesce(rp.shown, true),
           o.created_at
      from public.premium_orders o
      join public.payments pay on pay.id = o.payment_id
      left join public.profiles pr on pr.id = o.owner_id
      left join auth.users au on au.id = o.owner_id
      left join public.profile_ring_prefs rp on rp.user_id = o.owner_id
     order by o.created_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

revoke all on function public.ring_prefs_get() from public, anon;
revoke all on function public.ring_prefs_set(boolean, boolean) from public, anon;
revoke all on function public.admin_ring_ledger(integer) from public, anon;
grant execute on function public.ring_prefs_get() to authenticated;
grant execute on function public.ring_prefs_set(boolean, boolean) to authenticated;
grant execute on function public.admin_ring_ledger(integer) to authenticated;
