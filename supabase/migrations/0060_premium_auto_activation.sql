-- ============================================================================
-- 0060 — Premium profiles activate when the payment is verified
--
-- Before this migration a verified premium payment only opened an order that an
-- administrator still had to activate (0054), so an approved Elite payment showed
-- as "Verified" while the member's profile stayed Free.
--
-- Now the same database transaction that verifies the payment grants the tier.
-- Every route to "verified" goes through this trigger: the admin approval, the
-- payment gateway callback and any future path. So the admin panel, the payment
-- record and the member's dashboard all read one status.
--
-- Rules kept:
--   - Nothing is granted before status = 'verified'.
--   - A member is never moved to a lower tier; the order is still recorded.
--   - Accent colours survive an Elite-to-Elite change, as in the admin function.
--   - The member is told when the profile is live.
--
-- Also: the entitlement row is published to Realtime, so an open dashboard can
-- update without a refresh. Owners already read only their own row (0054).
-- ============================================================================

create or replace function public.premium_rank(p_tier text)
returns integer
language sql
immutable
as $$
  select case p_tier when 'elite' then 2 when 'glow' then 1 else 0 end
$$;

revoke all on function public.premium_rank(text) from public, anon, authenticated;

-- Grant one order's tier now. Idempotent: an activated order is left alone.
create or replace function public.premium_activate_order(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  cur record;
  v_now timestamptz := now();
  v_label text;
begin
  select * into o from public.premium_orders where id = p_order_id for update;
  if not found or o.status <> 'awaiting_activation' then
    return 'skipped';
  end if;

  /* Only a verified payment may grant anything. */
  if not exists (
    select 1 from public.payments p
     where p.id = o.payment_id and p.status = 'verified' and p.owner_id = o.owner_id
  ) then
    return 'not_verified';
  end if;

  select * into cur from public.profile_entitlements where user_id = o.owner_id for update;
  v_label := initcap(o.tier);

  if found and public.premium_rank(cur.tier) > public.premium_rank(o.tier) then
    /* Already on a higher tier: record the order, keep the higher tier. */
    update public.premium_orders
       set status = 'activated',
           activated_at = v_now,
           admin_note = 'Verified. The member already holds a higher profile, so the tier is unchanged.',
           updated_at = v_now
     where id = o.id;

    insert into public.notifications (user_id, title, body, type, link)
    values (o.owner_id, 'Premium payment confirmed',
            'Your ' || v_label || ' payment is confirmed. You already hold a higher profile, so it stays in place.',
            'payment', '/app/?view=settings');
    return 'kept_higher';
  end if;

  insert into public.profile_entitlements (user_id, tier, accent, granted_order_id, granted_at, updated_at)
  values (o.owner_id, o.tier, null, o.id, v_now, v_now)
  on conflict (user_id) do update
    set tier = excluded.tier,
        accent = case when excluded.tier = 'elite' and public.profile_entitlements.tier = 'elite'
                      then public.profile_entitlements.accent else null end,
        granted_order_id = excluded.granted_order_id,
        granted_at = excluded.granted_at,
        updated_at = excluded.updated_at;

  update public.premium_orders
     set status = 'activated', activated_at = v_now, updated_at = v_now
   where id = o.id;

  insert into public.notifications (user_id, title, body, type, link)
  values (o.owner_id, v_label || ' profile is live',
          'Your ' || v_label || ' profile is active now. Thank you for supporting Shinzora.',
          'payment', '/app/?view=settings');

  insert into public.customer_activity (user_id, action, entity_type, entity_id, meta)
  values (o.owner_id, 'premium_activated', 'premium_order', o.id,
          jsonb_build_object('tier', o.tier, 'automatic', true));

  return 'activated';
end;
$$;

revoke all on function public.premium_activate_order(uuid) from public, anon, authenticated;

-- Trigger: a verified premium payment opens its order and activates it at once.
create or replace function public.premium_order_from_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
  v_order uuid;
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
    on conflict (payment_id) do nothing
    returning id into v_order;

    if v_order is not null then
      perform public.premium_activate_order(v_order);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.premium_order_from_payment() from public, anon, authenticated;

-- Backfill: any verified premium payment still waiting gets its profile now.
do $$
declare
  r record;
begin
  for r in select id from public.premium_orders where status = 'awaiting_activation' loop
    perform public.premium_activate_order(r.id);
  end loop;
end
$$;

-- Realtime: the member's dashboard listens for changes to its own entitlement.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profile_entitlements'
  ) then
    alter publication supabase_realtime add table public.profile_entitlements;
  end if;
end
$$;
