-- One website, one app and one store per account. Draft only: do not apply until
-- the read-only duplicate preflight is reviewed and approved. This migration
-- neither deletes nor merges existing projects.
--
-- Preflight:
-- select owner_id, type, count(*) from public.projects
-- where type in ('website','app','store') group by owner_id, type having count(*) > 1;
create unique index if not exists projects_one_builder_project_per_kind
  on public.projects (owner_id, type)
  where type in ('website', 'app', 'store');
