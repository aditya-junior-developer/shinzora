-- ============================================================================
-- SHINZORA · 0012_app_package_enforcement.sql
-- ----------------------------------------------------------------------------
-- The app builder's rules, enforced by the database rather than by a hidden
-- button. Three of them can be broken by a direct REST call if they live only
-- in the UI:
--
--   1. a package format belongs to exactly one platform — APK and AAB are
--      Android, IPA is iOS, and an iOS AAB is not a thing
--   2. a one-platform plan (Free, Pro) may not request an iOS build; only an
--      Enterprise subscription may target Android and iOS
--   3. a job is only "built" when a file and its checksum are recorded. A row
--      that claims a build with nothing behind it is refused at write time, so
--      the UI can never be handed a fake success to display.
--
-- Nothing here replaces 0011: the tables, the ownership policies and the
-- "no client UPDATE policy" decision all stand. This migration adds the checks.
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Which targets a caller may build for
--   Reads the real subscription row. An unknown or missing plan is treated as
--   the narrowest allowance, never the widest.
-- ---------------------------------------------------------------------------
create or replace function public.app_target_allowed(
  p_platform text,
  p_target text,
  p_user uuid default auth.uid()
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  plan_id text;
  slots int;
begin
  if p_platform is null or p_target is null then
    return false;
  end if;

  /* The pairing is absolute: it does not depend on the plan. */
  if not (
    (p_platform = 'android' and p_target in ('apk', 'aab'))
    or (p_platform = 'ios' and p_target = 'ipa')
  ) then
    return false;
  end if;

  if p_user is null then
    return false;
  end if;

  slots := public.app_platform_slots(p_user);

  if p_platform = 'ios' then
    return slots >= 2;
  end if;

  return slots >= 1;
end;
$$;

revoke all on function public.app_target_allowed(text, text, uuid) from public, anon;
grant execute on function public.app_target_allowed(text, text, uuid) to authenticated;

comment on function public.app_target_allowed(text, text, uuid) is
  'Whether a caller may build a given package target. The platform/format pairing is absolute; iOS additionally requires two platform slots (Enterprise).';

-- ---------------------------------------------------------------------------
-- The guard on conversion jobs
--   Runs before every insert and every update, so it also covers the service
--   role's own writes: the server cannot mark a job built without a file.
-- ---------------------------------------------------------------------------
create or replace function public.conversion_jobs_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    /* Only the queue may be opened from a client; anything further along is a
       claim about work that has not happened. */
    if new.status <> 'queued' and not public.is_admin() then
      raise exception 'A conversion job starts as queued. Only the build service can move it.' using errcode = '42501';
    end if;

    /* The pairing is not a plan question: an iOS AAB is wrong for everybody. */
    if not (
      (new.platform = 'android' and new.target in ('apk', 'aab'))
      or (new.platform = 'ios' and new.target = 'ipa')
    ) then
      raise exception 'That package format does not belong to that platform: APK and AAB are Android, IPA is iOS.'
        using errcode = '42501';
    end if;

    if not public.is_admin() and not public.app_target_allowed(new.platform, new.target) then
      raise exception 'Your plan targets one platform. Building for Android and iOS needs Enterprise.' using errcode = '42501';
    end if;

    /* A reverse-DNS package id, or none yet (the builder suggests one). */
    if new.package_id is not null and new.package_id !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,}$' then
      raise exception 'The package id must look like in.shinzora.yourapp.' using errcode = '22023';
    end if;

    if new.app_name is null or length(btrim(new.app_name)) = 0 then
      raise exception 'An app needs a name.' using errcode = '22023';
    end if;
  end if;

  /* The single most important invariant in this table. */
  if new.status = 'built' and (new.artifact_path is null or new.artifact_sha256 is null or new.artifact_bytes is null) then
    raise exception 'A built package needs an artifact path, a byte count and a checksum.' using errcode = '23514';
  end if;

  if new.status in ('failed', 'expired') and new.artifact_path is not null then
    raise exception 'A failed or expired job cannot reference an artifact.' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists conversion_jobs_guard on public.conversion_jobs;
create trigger conversion_jobs_guard
  before insert or update on public.conversion_jobs
  for each row execute function public.conversion_jobs_guard();

-- ---------------------------------------------------------------------------
-- One open request per platform per project
--   Stops a double click from queueing the same build twice, the way 0007 does
--   for payments.
-- ---------------------------------------------------------------------------
create unique index if not exists conversion_jobs_one_open_per_target
  on public.conversion_jobs (user_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), platform, target)
  where status in ('queued', 'running', 'awaiting_toolchain');

-- ---------------------------------------------------------------------------
-- What a plan may target, for the UI to read instead of guessing
-- ---------------------------------------------------------------------------
create or replace function public.app_package_options(p_user uuid default auth.uid())
returns table (platform text, target text, allowed boolean, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
    select v.platform, v.target, public.app_target_allowed(v.platform, v.target, p_user),
      case
        when v.platform = 'ios' and public.app_platform_slots(p_user) < 2
          then 'iOS builds need Enterprise, an Apple Developer team, a distribution certificate and a provisioning profile.'
        when not public.app_target_allowed(v.platform, v.target, p_user)
          then 'Not available on this plan.'
        else ''
      end
    from (values ('android', 'apk'), ('android', 'aab'), ('ios', 'ipa')) as v(platform, target);
end;
$$;

revoke all on function public.app_package_options(uuid) from public, anon;
grant execute on function public.app_package_options(uuid) to authenticated;
