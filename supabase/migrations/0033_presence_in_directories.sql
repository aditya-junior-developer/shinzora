-- 0033 — presence reaches the directories
--
-- The dot exists on the team list, in the inbox and in the admin console, but
-- the two places where a stranger decides whether to approach somebody — the
-- Find Team directory and the community channel — still showed a face with no
-- status beside it. Both are server-built jsonb payloads, so the field has to be
-- added where the row is assembled; the browser cannot join to `profiles`
-- behind those functions.
--
-- `last_seen_at` is already public to signed-in members (0030 grants the read),
-- so exposing it here discloses nothing new. Nothing else about the functions
-- changes: same rows, same order, same limits.

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
    'isPublished', coalesce(x.is_published,false),
    'lastSeenAt', x.last_seen_at
  ) order by coalesce(x.is_published,false) desc, x.full_name), '[]'::jsonb) into result
  from (
    select pr.id as user_id, pr.full_name, pr.username, pr.avatar_url, pr.last_seen_at,
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

create or replace function public.community_messages_list(p_channel text, p_before timestamptz default null, p_limit integer default 60)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  ch uuid;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to read the community.' using errcode='42501'; end if;
  select id into ch from public.community_channels where slug = lower(btrim(coalesce(p_channel,'')));
  if ch is null then raise exception 'That channel does not exist.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'body', x.body, 'createdAt', x.created_at, 'authorId', x.author_id,
    'authorName', coalesce(x.full_name, 'Member'), 'username', x.username, 'avatarUrl', x.avatar_url,
    'lastSeenAt', x.last_seen_at
  ) order by x.created_at asc), '[]'::jsonb) into result
  from (
    select m.id, m.body, m.created_at, m.author_id, pr.full_name, pr.username, pr.avatar_url, pr.last_seen_at
      from public.community_messages m
      join public.profiles pr on pr.id = m.author_id
     where m.channel_id = ch and m.removed_at is null
       and (p_before is null or m.created_at < p_before)
     order by m.created_at desc
     limit greatest(1, least(coalesce(p_limit, 60), 200))
  ) x;
  return result;
end;
$fn$;

grant execute on function public.community_messages_list(text,timestamptz,integer) to authenticated;
revoke all on function public.community_messages_list(text,timestamptz,integer) from anon;
