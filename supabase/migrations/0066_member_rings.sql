-- ---------------------------------------------------------------------------
-- Platform-wide profile rings (brief item 6).
--
-- profile_entitlements is owner-read only, so one member cannot see another
-- member's tier today. This function lets a signed-in member ask for the tier
-- and accent of a short list of members, so their avatars can wear the ring.
--
-- It returns the ring and nothing else: no order, payment, price, due date or
-- contact detail. It reads the table as its owner, so the table's policies are
-- unchanged. Anonymous callers get no rows. The list is capped so the function
-- cannot be used to walk the whole table in one call.
-- ---------------------------------------------------------------------------

create or replace function public.member_rings(p_user_ids uuid[])
returns table (member_id uuid, ring_tier text, ring_accent text)
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
           case when e.tier = 'elite' then e.accent else null end
      from public.profile_entitlements e
     where e.user_id = any (p_user_ids);
end;
$$;

comment on function public.member_rings(uuid[]) is
  'The profile ring (tier and accent) of up to 200 members, for signed-in members only. Nothing else about a purchase is returned.';

revoke all on function public.member_rings(uuid[]) from public, anon;
grant execute on function public.member_rings(uuid[]) to authenticated;
