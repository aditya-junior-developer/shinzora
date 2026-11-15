-- Shinzora migration 0051: the publish guard also enforces the owner's page limit.
--
-- Found by the 0050 rolled-back test (T20): republishing an older version that
-- had 3 pages passed the publish guard on a Free plan, because the guard checked
-- quality only. The save guard (project_versions_guard) already refused a new
-- 3-page version on Free, so this closes the other route to the same site.
--
-- What does NOT change:
--   * A site that is already published keeps running. Changing its name or other
--     details, while it stays on the same published version, is never blocked
--     (the early return in sz_guard_publish).
--   * Unpublishing is never blocked.
--   * Existing rows are not touched. Only a new publish of a version, or a
--     republish after unpublishing, is checked against the limit.
--
-- The owner's limit is read at the moment of publishing, from subscriptions,
-- through sz_page_limit (0050). Unknown plan names count as Free.

create or replace function public.sz_guard_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_files jsonb;
  v_problems jsonb;
  v_titles text;
  v_plan text;
  v_limit integer;
  v_pages integer;
begin
  /* Only the moment of publishing is checked. Leaving the project as it is, or
     taking it offline, is never blocked. */
  if new.status is distinct from 'published' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'published'
     and old.published_version_id is not distinct from new.published_version_id
     and old.slug is not distinct from new.slug then
    return new;
  end if;

  if new.published_version_id is null then
    raise exception 'Save a version before you publish.' using errcode = '23514',
      hint = jsonb_build_object('code', 'no_version')::text;
  end if;

  select v.files into v_files
    from public.project_versions v
   where v.id = new.published_version_id and v.project_id = new.id;
  if not found then
    raise exception 'The version to publish does not belong to this project.' using errcode = '23514',
      hint = jsonb_build_object('code', 'no_version')::text;
  end if;

  v_problems := public.sz_site_standard_problems(v_files);
  if jsonb_array_length(v_problems) > 0 then
    select string_agg(p ->> 'title', '; ') into v_titles from jsonb_array_elements(v_problems) as p;
    raise exception 'This version cannot be published until it meets the quality standards: %.', v_titles
      using errcode = '23514',
            hint = jsonb_build_object('code', 'quality', 'problems', v_problems)::text;
  end if;

  /* The page limit of the owner's plan, as it is now. */
  select coalesce((select s.plan from public.subscriptions s where s.user_id = new.owner_id), 'free') into v_plan;
  v_limit := public.sz_page_limit(v_plan);
  v_pages := public.sz_site_pages(v_files);
  if v_limit is not null and v_pages > v_limit then
    raise exception 'The % plan allows % page% per site, and this version has %. Remove pages or upgrade your plan.',
      initcap(v_plan), v_limit, case when v_limit = 1 then '' else 's' end, v_pages
      using errcode = '23514',
            hint = jsonb_build_object('code', 'page_limit', 'plan', v_plan, 'limit', v_limit, 'pages', v_pages)::text;
  end if;

  return new;
end;
$$;

-- The trigger itself is unchanged from 0050: before insert or update on projects.
drop trigger if exists projects_publish_guard on public.projects;
create trigger projects_publish_guard
  before insert or update on public.projects
  for each row execute function public.sz_guard_publish();
