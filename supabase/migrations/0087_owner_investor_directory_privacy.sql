-- ============================================================================
-- 0087 — Owners see only investors who chose a public investor profile
-- ----------------------------------------------------------------------------
-- The owner-side investor list (investor_directory) used to return every
-- investor account's handle and name, whatever their privacy setting. Now it
-- lists only investors whose investor profile is 'public'. Same return shape,
-- so the owner deck screen keeps working.
-- Effect: owners see no investors until investors create a public profile.
-- ============================================================================

create or replace function public.investor_directory()
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.is_account_type('owner') then
    raise exception 'Only business owners can see available investors.' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'count', count(*),
           'investors', coalesce(
             jsonb_agg(jsonb_build_object(
               'userId', p.id,
               'username', p.username,
               'name', ip.display_name
             ) order by p.username),
             '[]'::jsonb)
         )
    into result
    from public.investor_profiles ip
    join public.profiles p on p.id = ip.user_id
   where ip.visibility = 'public'
     and p.account_type = 'investor'
     and p.username is not null
     and btrim(p.username) <> '';

  return result;
end;
$$;

revoke all on function public.investor_directory() from public, anon;
grant execute on function public.investor_directory() to authenticated, service_role;
