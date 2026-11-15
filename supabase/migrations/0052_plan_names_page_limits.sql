-- Shinzora migration 0052: the plan names the database allows map to page limits.
--
-- subscriptions.plan allows free, pro, enterprise, starter, growth and scale.
-- The app sells free, pro and enterprise. The owner decided the other three map
-- like this, so an account on a legacy name keeps a sensible limit:
--   starter    -> Free    1 page
--   growth     -> Pro     3 pages
--   scale      -> Enterprise  unlimited
--
-- Only sz_page_limit changes. Its three callers (the version guard, the publish
-- guard and project_plan_limits) pick the new values up automatically. Existing
-- rows are not touched, and no site is unpublished.

create or replace function public.sz_page_limit(p_plan text)
returns integer
language sql
immutable
as $$
  select case lower(coalesce(p_plan, 'free'))
    when 'enterprise' then null      -- unlimited
    when 'scale'      then null      -- unlimited (legacy name for Enterprise)
    when 'pro'        then 3
    when 'growth'     then 3         -- legacy name for Pro
    else 1                           -- free, starter, and any unknown name
  end;
$$;
