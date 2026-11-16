-- ============================================================================
-- 0072 — Available investors (brief 1)
--
-- An investor is available to pitch when they hold an investor account and have
-- a handle (username), which is how a deck is shared with them (deck_share).
-- Owners see the count and the handles, and nothing else about an investor.
-- Only business owners may call this; investors and members get nothing.
-- ============================================================================

create or replace function public.investor_directory()
returns jsonb
language plpgsql
stable
security definer
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
               'name', coalesce(nullif(btrim(p.full_name), ''), p.username)
             ) order by p.username),
             '[]'::jsonb)
         )
    into result
    from public.profiles p
   where p.account_type = 'investor'
     and p.username is not null
     and btrim(p.username) <> '';

  return result;
end;
$$;

revoke all on function public.investor_directory() from public, anon;
grant execute on function public.investor_directory() to authenticated, service_role;
