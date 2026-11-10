-- 0026 — Find Team directory
--
-- `marketplace_list_freelancers` returns a card-sized record but no photo and
-- nothing for the profile modal. These two functions split the job:
--   find_team_search      one call for the directory grid
--   agent_public_profile  one call for the modal, on demand

create or replace function public.find_team_search(p_query text default null, p_limit integer default 40)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  q text := lower(btrim(coalesce(p_query,'')));
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to browse people.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', x.user_id, 'name', coalesce(x.full_name, x.username, 'Member'), 'username', x.username,
    'avatarUrl', x.avatar_url, 'headline', x.headline, 'skills', coalesce(x.skills, '{}'::text[]),
    'availability', x.availability, 'yearsExperience', x.years_experience,
    'expectedRate', x.expected_rate, 'currency', coalesce(x.expected_currency, x.currency, 'INR'),
    'accountType', x.account_type, 'equityOk', coalesce(x.equity_ok,false), 'esopOk', coalesce(x.esop_ok,false)
  ) order by x.full_name), '[]'::jsonb) into result
  from (
    select pr.id as user_id, pr.full_name, pr.username, pr.avatar_url, pr.account_type,
           fp.headline, fp.skills, fp.availability, fp.years_experience, fp.expected_rate,
           fp.expected_currency, fp.currency, fp.equity_ok, fp.esop_ok
      from public.profiles pr
      left join public.freelancer_profiles fp on fp.user_id = pr.id
     where pr.id <> actor
       and (q = ''
         or lower(coalesce(pr.username,'')) like '%' || q || '%'
         or lower(coalesce(pr.full_name,'')) like '%' || q || '%'
         or exists (select 1 from unnest(coalesce(fp.skills,'{}'::text[])) s where lower(s) like '%' || q || '%'))
     order by pr.full_name
     limit greatest(1, least(coalesce(p_limit,40), 100))
  ) x;
  return result;
end;
$fn$;

create or replace function public.agent_public_profile(p_username text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  handle text := lower(btrim(coalesce(p_username,'')));
  person public.profiles%rowtype;
  fp public.freelancer_profiles%rowtype;
  completed integer := 0;
  ongoing integer := 0;
  portfolio jsonb := '[]'::jsonb;
begin
  if actor is null then raise exception 'Sign in to view a profile.' using errcode='42501'; end if;
  select * into person from public.profiles where lower(username) = handle limit 1;
  if person.id is null then raise exception 'No one uses that username.' using errcode='22023'; end if;
  select * into fp from public.freelancer_profiles where user_id = person.id;
  select count(*) filter (where status = 'completed'), count(*) filter (where status = 'active')
    into completed, ongoing
    from public.marketplace_contracts where freelancer_id = person.id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'title', i.title, 'summary', i.summary, 'url', i.url,
    'imageUrl', i.image_url, 'skills', i.skills, 'completedOn', i.completed_on
  ) order by i.sort_order, i.created_at desc), '[]'::jsonb) into portfolio
  from public.freelancer_portfolio_items i where i.user_id = person.id;
  return jsonb_build_object(
    'userId', person.id, 'name', coalesce(person.full_name, person.username, 'Member'),
    'username', person.username, 'avatarUrl', person.avatar_url, 'accountType', person.account_type,
    'isSelf', person.id = actor,
    'headline', fp.headline, 'bio', fp.bio, 'skills', coalesce(fp.skills,'{}'::text[]),
    'yearsExperience', fp.years_experience, 'availability', fp.availability,
    'hoursPerWeek', fp.hours_per_week, 'seeking', fp.seeking,
    'expectedRate', fp.expected_rate, 'currency', coalesce(fp.expected_currency, fp.currency, 'INR'),
    'location', fp.location, 'remoteOk', fp.remote_ok, 'timezone', fp.timezone,
    'equityOk', coalesce(fp.equity_ok,false), 'esopOk', coalesce(fp.esop_ok,false),
    'equityMinPct', fp.equity_min_pct, 'equityMaxPct', fp.equity_max_pct,
    'resumeUrl', fp.resume_url, 'portfolioUrl', fp.portfolio_url,
    'socialLinks', coalesce(fp.social_links,'{}'::jsonb), 'experience', coalesce(fp.experience,'[]'::jsonb),
    'languages', coalesce(fp.languages,'{}'::text[]),
    'ratingAvg', fp.rating_avg, 'ratingCount', fp.rating_count,
    'completedContracts', completed, 'ongoingContracts', ongoing,
    'portfolio', portfolio
  );
end;
$fn$;

grant execute on function public.find_team_search(text,integer) to authenticated;
grant execute on function public.agent_public_profile(text) to authenticated;
revoke all on function public.find_team_search(text,integer) from anon;
revoke all on function public.agent_public_profile(text) from anon;
