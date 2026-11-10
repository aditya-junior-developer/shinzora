-- 0027 — what the portfolio editor writes
--
-- 0024 added the columns (resume_url, experience, social_links, languages,
-- timezone) and the freelancer_portfolio_items table, but nothing could write
-- them: marketplace_save_agent covers the profile proper, not these fields.
--
-- Three functions, each checking that the row belongs to the caller. Nothing
-- here trusts the client: experience entries are trimmed and capped, and the
-- social object is rebuilt from a known key list so an unexpected key is
-- dropped rather than stored.

create or replace function public.agent_save_portfolio_profile(
  p_resume_url text default null,
  p_experience jsonb default '[]'::jsonb,
  p_social_links jsonb default '{}'::jsonb,
  p_languages text[] default '{}'::text[],
  p_timezone text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  saved public.freelancer_profiles%rowtype;
  cleaned_exp jsonb;
  cleaned_social jsonb;
begin
  if actor is null then raise exception 'Sign in to edit your profile.' using errcode='42501'; end if;
  if p_resume_url is not null and btrim(p_resume_url) <> '' and btrim(p_resume_url) !~* '^https?://' then
    raise exception 'The CV link must start with http:// or https://.' using errcode='22023';
  end if;
  if jsonb_typeof(coalesce(p_experience, '[]'::jsonb)) <> 'array' then
    raise exception 'Experience must be a list.' using errcode='22023';
  end if;
  if jsonb_typeof(coalesce(p_social_links, '{}'::jsonb)) <> 'object' then
    raise exception 'Social links must be an object.' using errcode='22023';
  end if;
  if jsonb_array_length(coalesce(p_experience, '[]'::jsonb)) > 25 then
    raise exception 'Keep experience to 25 entries or fewer.' using errcode='22023';
  end if;

  -- Trim and cap each entry so one oversized field cannot bloat the row.
  select coalesce(jsonb_agg(jsonb_build_object(
           'role', left(coalesce(e->>'role',''), 120),
           'company', left(coalesce(e->>'company',''), 120),
           'from', left(coalesce(e->>'from',''), 20),
           'to', left(coalesce(e->>'to',''), 20),
           'summary', left(coalesce(e->>'summary',''), 800)
         )), '[]'::jsonb)
    into cleaned_exp
    from jsonb_array_elements(coalesce(p_experience, '[]'::jsonb)) e
   where coalesce(e->>'role','') <> '' or coalesce(e->>'company','') <> '';

  select coalesce(jsonb_object_agg(key, left(value, 300)), '{}'::jsonb)
    into cleaned_social
    from jsonb_each_text(coalesce(p_social_links, '{}'::jsonb))
   where key in ('linkedin','github','dribbble','behance','x','twitter','website','other')
     and btrim(value) <> '';

  insert into public.freelancer_profiles as f (user_id, resume_url, experience, social_links, languages, timezone, updated_at)
  values (actor, nullif(btrim(coalesce(p_resume_url,'')), ''), cleaned_exp, cleaned_social,
          coalesce(p_languages, '{}'::text[]), nullif(btrim(coalesce(p_timezone,'')), ''), now())
  on conflict (user_id) do update set
    resume_url = excluded.resume_url,
    experience = excluded.experience,
    social_links = excluded.social_links,
    languages = excluded.languages,
    timezone = excluded.timezone,
    updated_at = now()
  returning * into saved;

  update public.profiles set account_type = 'agent', updated_at = now() where id = actor and account_type <> 'agent';

  return jsonb_build_object('ok', true, 'resumeUrl', saved.resume_url,
    'experienceCount', jsonb_array_length(saved.experience),
    'socialLinks', saved.social_links, 'languages', saved.languages, 'timezone', saved.timezone);
end;
$fn$;

create or replace function public.portfolio_item_save(
  p_id uuid default null,
  p_title text default null,
  p_summary text default null,
  p_url text default null,
  p_image_url text default null,
  p_skills text[] default '{}'::text[],
  p_completed_on date default null,
  p_sort_order integer default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  item public.freelancer_portfolio_items%rowtype;
  title_clean text := btrim(coalesce(p_title, ''));
begin
  if actor is null then raise exception 'Sign in to edit your portfolio.' using errcode='42501'; end if;
  if char_length(title_clean) < 1 then raise exception 'Give the item a title.' using errcode='22023'; end if;
  if char_length(title_clean) > 160 then raise exception 'Titles are limited to 160 characters.' using errcode='22023'; end if;
  if p_url is not null and btrim(p_url) <> '' and btrim(p_url) !~* '^https?://' then
    raise exception 'Links must start with http:// or https://.' using errcode='22023';
  end if;
  if p_image_url is not null and btrim(p_image_url) <> '' and btrim(p_image_url) !~* '^https?://' then
    raise exception 'Image links must start with http:// or https://.' using errcode='22023';
  end if;

  if p_id is null then
    insert into public.freelancer_portfolio_items
      (user_id, title, summary, url, image_url, skills, completed_on, sort_order)
    values (actor, title_clean, nullif(btrim(coalesce(p_summary,'')), ''),
            nullif(btrim(coalesce(p_url,'')), ''), nullif(btrim(coalesce(p_image_url,'')), ''),
            coalesce(p_skills, '{}'::text[]), p_completed_on, coalesce(p_sort_order, 0))
    returning * into item;
  else
    update public.freelancer_portfolio_items
       set title = title_clean,
           summary = nullif(btrim(coalesce(p_summary,'')), ''),
           url = nullif(btrim(coalesce(p_url,'')), ''),
           image_url = nullif(btrim(coalesce(p_image_url,'')), ''),
           skills = coalesce(p_skills, '{}'::text[]),
           completed_on = p_completed_on,
           sort_order = coalesce(p_sort_order, 0),
           updated_at = now()
     where id = p_id and user_id = actor
     returning * into item;
    if item.id is null then raise exception 'That portfolio item is not yours.' using errcode='42501'; end if;
  end if;
  return jsonb_build_object('itemId', item.id, 'title', item.title, 'summary', item.summary,
    'url', item.url, 'imageUrl', item.image_url, 'skills', item.skills, 'completedOn', item.completed_on);
end;
$fn$;

create or replace function public.portfolio_item_delete(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to edit your portfolio.' using errcode='42501'; end if;
  delete from public.freelancer_portfolio_items where id = p_id and user_id = actor;
  if not found then raise exception 'That portfolio item is not yours.' using errcode='42501'; end if;
  return jsonb_build_object('ok', true);
end;
$fn$;

grant execute on function public.agent_save_portfolio_profile(text,jsonb,jsonb,text[],text) to authenticated;
grant execute on function public.portfolio_item_save(uuid,text,text,text,text,text[],date,integer) to authenticated;
grant execute on function public.portfolio_item_delete(uuid) to authenticated;
revoke all on function public.agent_save_portfolio_profile(text,jsonb,jsonb,text[],text) from anon;
revoke all on function public.portfolio_item_save(uuid,text,text,text,text,text[],date,integer) from anon;
revoke all on function public.portfolio_item_delete(uuid) from anon;
