-- 0028 — Find Team lists freelancers, not every account
--
-- The directory was returning every profile row, so business owners with no
-- agent profile appeared with "Experience: not stated / Rate: open". Eight of
-- nine rows were the wrong population.
--
-- A person belongs here when their account is an agent, or when they have an
-- agent profile at all (which covers anyone who built one before account_type
-- existed). Published profiles sort first, because those are the people who
-- have opted in to being found.

create or replace function public.find_team_search(p_query text default null, p_limit integer default 40)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  q text := lower(btrim(coalesce(p_query,'')));
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to browse people.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', x.user_id,
    'name', coalesce(nullif(x.full_name,''), x.username, 'Member'),
    'username', x.username,
    'avatarUrl', x.avatar_url,
    'headline', x.headline,
    'skills', coalesce(x.skills, '{}'::text[]),
    'availability', x.availability,
    'yearsExperience', x.years_experience,
    'expectedRate', x.expected_rate,
    'currency', coalesce(x.expected_currency, x.currency, 'INR'),
    'equityOk', coalesce(x.equity_ok,false),
    'esopOk', coalesce(x.esop_ok,false),
    'isPublished', coalesce(x.is_published,false)
  ) order by coalesce(x.is_published,false) desc, x.full_name), '[]'::jsonb) into result
  from (
    select pr.id as user_id, pr.full_name, pr.username, pr.avatar_url,
           fp.headline, fp.skills, fp.availability, fp.years_experience, fp.expected_rate,
           fp.expected_currency, fp.currency, fp.equity_ok, fp.esop_ok, fp.is_published
      from public.profiles pr
      left join public.freelancer_profiles fp on fp.user_id = pr.id
     where pr.id <> actor
       and (pr.account_type = 'agent' or fp.user_id is not null)
       and (q = ''
         or lower(coalesce(pr.username,'')) like '%' || q || '%'
         or lower(coalesce(pr.full_name,'')) like '%' || q || '%'
         or exists (select 1 from unnest(coalesce(fp.skills,'{}'::text[])) s where lower(s) like '%' || q || '%'))
     order by coalesce(fp.is_published,false) desc, pr.full_name
     limit greatest(1, least(coalesce(p_limit,40), 100))
  ) x;
  return result;
end;
$fn$;

grant execute on function public.find_team_search(text,integer) to authenticated;
revoke all on function public.find_team_search(text,integer) from anon;
