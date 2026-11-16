-- ============================================================================
-- 0075 — A purchase wears its ring, and a PFP ring and the RGB ring never
-- combine.
--
-- Bug fixed: 0073 made a verified PFP purchase wear the design, but it did not
-- clear the RGB choice. A member wearing the RGB ring who bought a design
-- would be shown both. Now every purchase clears the other feature's choice.
--
-- Also: a verified RGB purchase now wears the RGB ring, like a PFP purchase
-- does. The purchase button says "Buy and wear" for both.
--
-- Ownership is unchanged: owning either feature stays forever.
-- ============================================================================

-- 1. A verified PFP purchase: own it, wear it, and turn the RGB ring off.
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

    delete from public.profile_rgb_choices where user_id = new.owner_id;

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

-- 2. A verified RGB purchase: own it, wear it, and turn the PFP design off.
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

    delete from public.profile_ring_choices where user_id = new.owner_id;

    insert into public.profile_rgb_choices (user_id, applied_at)
    values (new.owner_id, now())
    on conflict (user_id) do update set applied_at = excluded.applied_at;
  end if;
  return new;
end;
$$;

revoke all on function public.rgb_from_payment() from public, anon, authenticated;
