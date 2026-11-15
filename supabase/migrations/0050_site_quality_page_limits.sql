-- ============================================================================
-- SHINZORA · 0050_site_quality_page_limits.sql
-- ----------------------------------------------------------------------------
-- Mandatory quality standards and plan page limits for websites and apps,
-- enforced by the database rather than by the browser or the model.
--
--   * sz_page_limit(plan)            Free 1 page, Pro 3, Enterprise unlimited.
--                                    Unknown or legacy plan names count as Free.
--   * sz_site_pages(files)           distinct data-route sections in index.html
--                                    (plus any extra .html files), minimum 1.
--   * sz_site_standard_problems(f)   the mandatory standards. Each one mirrors a
--                                    check in public/js/lib/site-validate.js.
--   * trigger on project_versions    a new or changed version must meet the
--                                    standards and the owner's page limit.
--   * trigger on projects            publishing requires a saved version that
--                                    meets the standards.
--   * project_plan_limits()          what the signed-in owner is allowed, for the
--                                    builder to show before the owner gets stuck.
--
-- Existing rows are not touched. The guards run only when a version's files
-- change or a project starts to be published, so a plan downgrade never removes
-- or unpublishes anything: the owner keeps every existing version, and only new
-- versions are measured against the current plan.
--
-- JavaScript syntax (the \"js-syntax\" standard) cannot be parsed in SQL. It is
-- enforced in the browser before save and in the builder's finish step; see the
-- notes in site-validate.js.
-- ============================================================================

-- ---------------------------------------------------------------- page limits
create or replace function public.sz_page_limit(p_plan text)
returns integer
language sql
immutable
as $$
  select case lower(coalesce(p_plan, 'free'))
    when 'enterprise' then null      -- unlimited
    when 'pro'        then 3
    else 1                           -- free, and any unknown or legacy plan name
  end;
$$;

-- ----------------------------------------------------------------- page count
create or replace function public.sz_site_pages(p_files jsonb)
returns integer
language plpgsql
immutable
as $$
declare
  doc text := coalesce(p_files ->> 'index.html', '');
  routes integer := 0;
  extra integer := 0;
begin
  select count(distinct m[1]) into routes
    from regexp_matches(doc, 'data-route\s*=\s*["'']([^"'']+)["'']', 'gi') as m;
  if jsonb_typeof(p_files) = 'object' then
    select count(*) into extra
      from jsonb_object_keys(p_files) as k
     where k ~* '\.html?$' and k <> 'index.html';
  end if;
  return greatest(coalesce(routes, 0), 1) + coalesce(extra, 0);
end;
$$;

-- ------------------------------------------------------- mandatory standards
create or replace function public.sz_site_standard_problems(p_files jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  doc text := coalesce(p_files ->> 'index.html', '');
  acc jsonb := '[]'::jsonb;
  routes text[];
  routes_raw text[];
  ids text[];
  raw text;
  tag text;
  title_text text;
begin
  /* Each standard reports at most once, with the first detail found. The result
     is a set of standards that failed, not a list of every occurrence. */
  if doc ~ '^\s*$' then
    return jsonb_build_array(jsonb_build_object(
      'code', 'empty', 'title', 'There is no document to check',
      'detail', 'The version has no index.html file, or it is empty.'));
  end if;

  -- routes exactly as collectRoutes(): data-route values, or "/" when there is none
  select coalesce(array_agg(distinct m[1]), '{}') into routes_raw
    from regexp_matches(doc, 'data-route\s*=\s*["'']([^"'']+)["'']', 'gi') as m;
  routes := routes_raw;
  if coalesce(array_length(routes, 1), 0) = 0 then routes := array['/']; end if;

  -- ids exactly as collectIds(): id attributes, plus each route without its slash
  select coalesce(array_agg(distinct m[1]), '{}') into ids
    from regexp_matches(doc, '\sid\s*=\s*["'']([^"'']+)["'']', 'gi') as m;
  ids := ids || coalesce(array(select regexp_replace(r, '^/', '') from unnest(routes_raw) as r), '{}');

  -- ----- document shell
  if doc !~* '<!doctype\s+html' then
    acc := acc || jsonb_build_array(jsonb_build_object('code', 'doctype', 'title', 'No doctype',
      'detail', 'The page does not start with <!doctype html>.'));
  end if;
  if doc !~* '<html[^>]*\slang\s*=' then
    acc := acc || jsonb_build_array(jsonb_build_object('code', 'lang', 'title', 'No page language',
      'detail', 'Add lang="en" (or the customer''s language) to <html>.'));
  end if;
  if doc !~* '<meta[^>]+name\s*=\s*["'']viewport["'']' then
    acc := acc || jsonb_build_array(jsonb_build_object('code', 'viewport', 'title', 'Not responsive',
      'detail', 'There is no viewport meta tag, so the page will not scale on a phone.'));
  end if;
  title_text := (regexp_match(doc, '<title[^>]*>([^<]*)</title>', 'i'))[1];
  if coalesce(btrim(title_text), '') = '' then
    acc := acc || jsonb_build_array(jsonb_build_object('code', 'title', 'title', 'No page title',
      'detail', 'The document needs a non-empty <title>.'));
  end if;
  if doc !~* '<h1[\s>]' then
    acc := acc || jsonb_build_array(jsonb_build_object('code', 'h1', 'title', 'No main heading',
      'detail', 'The page has no <h1>.'));
  end if;

  -- ----- internal links
  for raw in select btrim(m[1]) from regexp_matches(doc, 'href\s*=\s*["'']#([^"'']*)["'']', 'gi') as m loop
    continue when raw = '';
    if left(raw, 1) = '/' then
      if not (raw = any(routes) or regexp_replace(raw, '^/', '') = any(ids)) then
        if not exists (select 1 from jsonb_array_elements(acc) e where e ->> 'code' = 'broken-route') then
          acc := acc || jsonb_build_array(jsonb_build_object('code', 'broken-route', 'title', 'Broken link',
            'detail', format('A link points to “#%s”, but no page answers that address.', raw)));
        end if;
      end if;
    elsif not (raw = any(ids) or ('/' || raw) = any(routes)) then
      if not exists (select 1 from jsonb_array_elements(acc) e where e ->> 'code' = 'broken-anchor') then
        acc := acc || jsonb_build_array(jsonb_build_object('code', 'broken-anchor', 'title', 'Link jumps nowhere',
          'detail', format('A link points to “#%s”, but no element on the page has that id.', raw)));
      end if;
    end if;
  end loop;

  -- ----- links to files that are not in the document
  for raw in select btrim(m[1]) from regexp_matches(doc, '<a\s[^>]*href\s*=\s*["'']([^"'']*)["'']', 'gi') as m loop
    continue when raw = '' or raw ~* '^(#|https?:|mailto:|tel:|data:|javascript:|//)';
    if not exists (select 1 from jsonb_array_elements(acc) e where e ->> 'code' = 'broken-link') then
      acc := acc || jsonb_build_array(jsonb_build_object('code', 'broken-link',
        'title', 'Link to a file that is not in this document',
        'detail', format('A link points to “%s”. A one-file site can only link to pages inside it.', raw)));
    end if;
  end loop;

  -- ----- local assets (images, scripts, stylesheets, CSS url())
  for raw in
    select btrim(m[1]) from regexp_matches(doc, '<img[^>]*src\s*=\s*["'']([^"'']*)["'']', 'gi') as m
    union all
    select btrim(m[1]) from regexp_matches(doc, '<script\s[^>]*src\s*=\s*["'']([^"'']*)["'']', 'gi') as m
    union all
    select btrim(m[1]) from regexp_matches(doc, '<source\s[^>]*srcset\s*=\s*["'']([^"'']*)["'']', 'gi') as m
    union all
    select btrim(m[1]) from regexp_matches(doc, 'url\(\s*["'']?([^"'')]+)["'']?\s*\)', 'gi') as m
  loop
    continue when raw = '' or raw ~* '^(data:|https?:|//|#|mailto:|tel:|javascript:|about:)';
    if not exists (select 1 from jsonb_array_elements(acc) e where e ->> 'code' = 'missing-asset') then
      acc := acc || jsonb_build_array(jsonb_build_object('code', 'missing-asset',
        'title', 'Missing asset in a single-file site',
        'detail', format('“%s” is referenced, but a one-file site can only load embedded (data:) or remote images.', raw)));
    end if;
  end loop;
  for raw in select btrim(m[1]) from regexp_matches(doc, '<link\s[^>]*href\s*=\s*["'']([^"'']*)["'']', 'gi') as m loop
    continue when raw = '' or position('#' in raw) > 0;
    if raw ~* '\.(css|js|woff2?|ttf|ico)$' and not exists (select 1 from jsonb_array_elements(acc) e where e ->> 'code' = 'missing-asset') then
      acc := acc || jsonb_build_array(jsonb_build_object('code', 'missing-asset',
        'title', 'Missing asset in a single-file site',
        'detail', format('“%s” is referenced, but a one-file site cannot load it.', raw)));
    end if;
  end loop;

  -- ----- images need alt text (the attribute must be present; empty is allowed for decoration)
  for tag in select m[1] from regexp_matches(doc, '(<img[\s/>][^>]*>)', 'gi') as m loop
    if tag !~* '\salt\s*=' then
      acc := acc || jsonb_build_array(jsonb_build_object('code', 'img-alt', 'title', 'Image without alt text',
        'detail', 'An <img> has no alt attribute, so screen readers cannot describe it.'));
      exit;
    end if;
  end loop;

  -- ----- placeholder text must not ship
  if doc ~* 'lorem ipsum' then
    acc := acc || jsonb_build_array(jsonb_build_object('code', 'placeholder-text',
      'title', 'Placeholder text left in the page',
      'detail', 'The page still contains “lorem ipsum” filler text.'));
  end if;

  return acc;
end;
$$;

-- ------------------------------------------------- version guard (the save path)
create or replace function public.sz_guard_project_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_type text;
  v_plan text;
  v_limit integer;
  v_pages integer;
  v_problems jsonb;
  v_titles text;
begin
  /* An update that leaves the files alone (for example the version_number or
     the metadata) is not a new document and is not measured again. */
  if tg_op = 'UPDATE' and new.files is not distinct from old.files then
    return new;
  end if;

  select p.owner_id, p.type into v_owner, v_type from public.projects p where p.id = new.project_id;
  if v_owner is null then
    raise exception 'The project for this version does not exist.' using errcode = '23503';
  end if;

  v_problems := public.sz_site_standard_problems(new.files);
  if jsonb_array_length(v_problems) > 0 then
    select string_agg(p ->> 'title', '; ') into v_titles from jsonb_array_elements(v_problems) as p;
    raise exception 'This version does not meet the quality standards: %.', v_titles
      using errcode = '23514',
            hint = jsonb_build_object('code', 'quality', 'problems', v_problems)::text;
  end if;

  select coalesce((select s.plan from public.subscriptions s where s.user_id = v_owner), 'free') into v_plan;
  v_limit := public.sz_page_limit(v_plan);
  v_pages := public.sz_site_pages(new.files);
  if v_limit is not null and v_pages > v_limit then
    raise exception 'The % plan allows % page% per site, and this version has %. Remove pages or upgrade your plan.',
      initcap(v_plan), v_limit, case when v_limit = 1 then '' else 's' end, v_pages
      using errcode = '23514',
            hint = jsonb_build_object('code', 'page_limit', 'plan', v_plan, 'limit', v_limit, 'pages', v_pages)::text;
  end if;

  return new;
end;
$$;

drop trigger if exists project_versions_guard on public.project_versions;
create trigger project_versions_guard
  before insert or update on public.project_versions
  for each row execute function public.sz_guard_project_version();

-- ---------------------------------------------------- publish guard
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

  return new;
end;
$$;

drop trigger if exists projects_publish_guard on public.projects;
create trigger projects_publish_guard
  before insert or update on public.projects
  for each row execute function public.sz_guard_publish();

-- ---------------------------------------------- what the owner is allowed
create or replace function public.project_plan_limits()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'plan', p.plan,
    'page_limit', public.sz_page_limit(p.plan),
    'unlimited_pages', public.sz_page_limit(p.plan) is null
  )
  from (
    select coalesce((select s.plan from public.subscriptions s where s.user_id = auth.uid()), 'free') as plan
  ) p;
$$;

revoke all on function public.project_plan_limits() from public, anon;
grant execute on function public.project_plan_limits() to authenticated, service_role;
