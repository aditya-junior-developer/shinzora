-- ---------------------------------------------------------------------------
-- Deleting a saved website or app version
--
--   * A version can be deleted by its owner (the existing owner policy already
--     allows the delete; this migration makes the consequences correct).
--   * The live version cannot be deleted. projects.published_version_id has no
--     foreign key, so nothing else would stop the published site from pointing
--     at a row that no longer exists.
--   * version_count is recounted on delete too. It was only refreshed on insert,
--     so every delete left the count one too high.
-- ---------------------------------------------------------------------------

create or replace function public.sz_guard_version_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.projects p
     where p.id = old.project_id and p.published_version_id = old.id
  ) then
    raise exception 'This version is live. Publish another version before deleting it.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

revoke all on function public.sz_guard_version_delete() from public, anon, authenticated;

drop trigger if exists project_versions_delete_guard on public.project_versions;
create trigger project_versions_delete_guard
  before delete on public.project_versions
  for each row execute function public.sz_guard_version_delete();

create or replace function public.recount_project_versions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.projects
     set version_count = (select count(*) from public.project_versions v where v.project_id = old.project_id),
         updated_at = now()
   where id = old.project_id;
  return old;
end;
$$;

revoke all on function public.recount_project_versions() from public, anon, authenticated;

drop trigger if exists project_versions_recount on public.project_versions;
create trigger project_versions_recount
  after delete on public.project_versions
  for each row execute function public.recount_project_versions();
