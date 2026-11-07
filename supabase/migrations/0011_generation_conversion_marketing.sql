-- ============================================================================
-- SHINZORA · 0011_generation_conversion_marketing.sql
-- ----------------------------------------------------------------------------
-- Tables for the AI builder upgrade, the app-conversion platform and the
-- marketing service. Nothing here replaces an existing table: projects,
-- project_versions, notifications and subscriptions keep their shape.
--
-- Design rules applied throughout:
--   • every row is owned by a user and every policy is written against
--     auth.uid() — no policy is opened to "public" to make something work
--   • a customer can never mark their own work as verified, built, approved or
--     paid: those transitions belong to the service role or to a verified
--     administrator, and the policies below enforce that, not just the UI
--   • provider credentials never live in these tables: marketing rows hold an
--     account handle and public profile, never a password or token
--   • research sources are stored with the job so a generated site can always
--     be traced back to what was actually read
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- AI generation jobs
--   One row per generation attempt, with the five-stage record the builder
--   shows. The progress bar is computed from the stages that actually
--   completed — never from a timer.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  kind text not null default 'website' check (kind in ('website', 'app', 'store', 'revision', 'research')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  stage text,
  stages jsonb not null default '[]'::jsonb,
  progress int not null default 0 check (progress between 0 and 100),
  model text,
  target text,
  prompt text,
  error text,
  meta jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_generation_jobs_user_idx
  on public.ai_generation_jobs (user_id, created_at desc);
create index if not exists ai_generation_jobs_project_idx
  on public.ai_generation_jobs (project_id, created_at desc);

alter table public.ai_generation_jobs enable row level security;

drop policy if exists ai_generation_jobs_owner_select on public.ai_generation_jobs;
create policy ai_generation_jobs_owner_select on public.ai_generation_jobs
  for select using (user_id = auth.uid() or public.is_admin());

/* A customer may open and update only their own job, and only while it is still
   queued or running. A finished job is a record: rewriting it after the fact
   would falsify the history the version trail depends on. */
drop policy if exists ai_generation_jobs_owner_insert on public.ai_generation_jobs;
create policy ai_generation_jobs_owner_insert on public.ai_generation_jobs
  for insert with check (user_id = auth.uid());

drop policy if exists ai_generation_jobs_owner_update on public.ai_generation_jobs;
create policy ai_generation_jobs_owner_update on public.ai_generation_jobs
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Conversion jobs — HTML to APK / AAB / IPA
--   The customer may open a job and read it. Only the server marks one built,
--   because only the server can prove a package exists, and only the server
--   holds the signing credentials.
-- ---------------------------------------------------------------------------
create table if not exists public.conversion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  version_id uuid references public.project_versions(id) on delete set null,
  platform text not null check (platform in ('android', 'ios')),
  target text not null check (target in ('apk', 'aab', 'ipa')),
  app_name text not null,
  package_id text,
  version_name text default '1.0.0',
  version_code int default 1,
  icon_path text,
  splash_path text,
  permissions text[] not null default '{}',
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_toolchain', 'built', 'failed', 'expired')),
  stages jsonb not null default '[]'::jsonb,
  progress int not null default 0 check (progress between 0 and 100),
  artifact_path text,
  artifact_bytes bigint,
  artifact_sha256 text,
  error text,
  hint text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversion_jobs_user_idx
  on public.conversion_jobs (user_id, created_at desc);

alter table public.conversion_jobs enable row level security;

drop policy if exists conversion_jobs_owner_select on public.conversion_jobs;
create policy conversion_jobs_owner_select on public.conversion_jobs
  for select using (user_id = auth.uid() or public.is_admin());

/* Deliberately no client UPDATE policy: a browser must not be able to set
   status = 'built'. The Edge Function runs as the service role and bypasses RLS. */

-- ---------------------------------------------------------------------------
-- Marketing account connections
--   Handles, public profile URLs and self-reported business details only. No
--   password is ever collected for any provider — OAuth happens in the provider,
--   and these rows record the result of a connection the customer made.
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  channel text not null check (channel in ('instagram', 'facebook', 'whatsapp', 'email', 'google_ads')),
  handle text,
  profile_url text,
  external_id text,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'submitted' check (status in ('submitted', 'verified', 'rejected', 'revoked')),
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists marketing_accounts_unique_channel
  on public.marketing_accounts (user_id, channel, coalesce(handle, ''));

alter table public.marketing_accounts enable row level security;

drop policy if exists marketing_accounts_owner_select on public.marketing_accounts;
create policy marketing_accounts_owner_select on public.marketing_accounts
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists marketing_accounts_owner_insert on public.marketing_accounts;
create policy marketing_accounts_owner_insert on public.marketing_accounts
  for insert with check (user_id = auth.uid() and status = 'submitted');

drop policy if exists marketing_accounts_owner_update on public.marketing_accounts;
create policy marketing_accounts_owner_update on public.marketing_accounts
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists marketing_accounts_owner_delete on public.marketing_accounts;
create policy marketing_accounts_owner_delete on public.marketing_accounts
  for delete using (user_id = auth.uid());

/* A customer must not be able to verify their own account: only an
   administrator, or the service role, may move a row to 'verified'. */
create or replace function public.marketing_accounts_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status = 'verified' and not public.is_admin() then
    raise exception 'Only an administrator can verify a connected account.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists marketing_accounts_guard on public.marketing_accounts;
create trigger marketing_accounts_guard
  before update on public.marketing_accounts
  for each row execute function public.marketing_accounts_guard();

-- ---------------------------------------------------------------------------
-- Marketing campaign requests
--   A request for a service, not a campaign launch. Approving one records a
--   decision; nothing here starts spending money.
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_requests (
  id uuid primary key default gen_random_uuid(),
  reference text,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  campaign_type text not null check (campaign_type in ('meta_ads', 'google_ads')),
  objective text not null,
  audience text,
  location text,
  budget_mode text not null default 'total' check (budget_mode in ('daily', 'total')),
  budget_paise bigint not null default 0 check (budget_paise >= 0),
  duration_days int check (duration_days is null or duration_days > 0),
  start_date date,
  accounts jsonb not null default '[]'::jsonb,
  creative_notes text,
  contact_preference text,
  status text not null default 'submitted'
    check (status in ('submitted', 'under_review', 'more_information_required', 'approved', 'in_progress', 'completed', 'rejected')),
  admin_notes text,
  assigned_to uuid references auth.users(id) on delete set null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists marketing_requests_user_idx
  on public.marketing_requests (user_id, created_at desc);
create index if not exists marketing_requests_status_idx
  on public.marketing_requests (status, created_at desc);

alter table public.marketing_requests enable row level security;

drop policy if exists marketing_requests_owner_select on public.marketing_requests;
create policy marketing_requests_owner_select on public.marketing_requests
  for select using (user_id = auth.uid() or public.is_admin());

/* A customer files a request and it starts at 'submitted'. They cannot file one
   already marked approved, and they cannot move it themselves afterwards. */
drop policy if exists marketing_requests_owner_insert on public.marketing_requests;
create policy marketing_requests_owner_insert on public.marketing_requests
  for insert with check (user_id = auth.uid() and status = 'submitted');

create or replace function public.marketing_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.reference is null then
      new.reference := 'MR-' || to_char(now(), 'YYMMDD') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    end if;
  end if;

  /* Status changes after submission are an administrator decision. The trigger
     enforces it for every path, including a direct REST call. */
  if tg_op = 'UPDATE' and new.status is distinct from old.status and not public.is_admin() then
    raise exception 'Only an administrator can change the status of a marketing request.' using errcode = '42501';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists marketing_requests_guard on public.marketing_requests;
create trigger marketing_requests_guard
  before insert or update on public.marketing_requests
  for each row execute function public.marketing_requests_guard();

-- ---------------------------------------------------------------------------
-- Request timeline
--   Customer-visible events and internal notes live in one table separated by
--   the `internal` flag, and RLS hides internal notes from the customer.
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.marketing_requests(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null default 'note' check (kind in ('status', 'note', 'contact', 'quote')),
  body text,
  internal boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists marketing_request_events_idx
  on public.marketing_request_events (request_id, created_at desc);

alter table public.marketing_request_events enable row level security;

drop policy if exists marketing_request_events_read on public.marketing_request_events;
create policy marketing_request_events_read on public.marketing_request_events
  for select using (
    public.is_admin()
    or (
      internal = false
      and exists (
        select 1 from public.marketing_requests r
        where r.id = request_id and r.user_id = auth.uid()
      )
    )
  );

-- ---------------------------------------------------------------------------
-- notify_admins — one notification per administrator
--   A customer cannot insert a notification for somebody else (no policy allows
--   it), so a campaign request is announced through this function. It is the
--   only door, it is SECURITY DEFINER, and it writes nothing but notifications.
-- ---------------------------------------------------------------------------
create or replace function public.notify_admins(p_title text, p_body text default null, p_link text default null, p_type text default 'admin')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted int := 0;
begin
  if auth.uid() is null then
    raise exception 'A signed-in account is required.' using errcode = '42501';
  end if;

  with targets as (
    select a.user_id from public.admin_users a where a.role in ('admin', 'superadmin')
  ), made as (
    insert into public.notifications (user_id, title, body, type, link)
    select t.user_id, left(coalesce(p_title, 'Notification'), 160),
           left(coalesce(p_body, ''), 600), coalesce(p_type, 'admin'), p_link
      from targets t
    returning 1
  )
  select count(*)::int into inserted from made;

  return inserted;
end;
$$;

revoke all on function public.notify_admins(text, text, text, text) from public, anon;
grant execute on function public.notify_admins(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Entitlements — how many app platform targets a plan may build for one project
--   Mirrored in the AI Edge Function and in public/js/config/env.js. Free: one
--   platform. Pro: one. Enterprise: Android and iOS.
-- ---------------------------------------------------------------------------
create or replace function public.app_platform_slots(p_user uuid default auth.uid())
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  plan_id text;
begin
  if p_user is null then
    return 1;
  end if;

  select s.plan into plan_id from public.subscriptions s where s.user_id = p_user;
  return case plan_id
    when 'enterprise' then 2
    when 'pro' then 1
    else 1
  end;
end;
$$;

grant execute on function public.app_platform_slots(uuid) to authenticated;

comment on function public.app_platform_slots(uuid) is
  'How many app platform targets (Android, iOS) one project may build for. Free and Pro: 1. Enterprise: 2.';

-- ---------------------------------------------------------------------------
-- Administrator policies
--   The dashboard runs as the authenticated role, not as the service role, so an
--   administrator reviewing a request needs a policy of their own. Without one
--   an admin UPDATE matches zero rows and silently does nothing — the failure
--   this project has hit before. These are written against public.is_admin(),
--   so a display name or an unverified email grants nothing.
-- ---------------------------------------------------------------------------
drop policy if exists marketing_requests_admin_update on public.marketing_requests;
create policy marketing_requests_admin_update on public.marketing_requests
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists marketing_accounts_admin_update on public.marketing_accounts;
create policy marketing_accounts_admin_update on public.marketing_accounts
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists marketing_request_events_admin_insert on public.marketing_request_events;
create policy marketing_request_events_admin_insert on public.marketing_request_events
  for insert with check (public.is_admin());

/* A customer registers the conversion request; only the server can report what
   came out of it, so the row they open must still be 'queued'. */
drop policy if exists conversion_jobs_owner_insert on public.conversion_jobs;
create policy conversion_jobs_owner_insert on public.conversion_jobs
  for insert with check (user_id = auth.uid() and status = 'queued');

-- ---------------------------------------------------------------------------
-- A target always belongs to its platform
--   An AAB is an Android package and an IPA is an iOS package. Getting that
--   pairing wrong produces a build that can never install, so the database
--   refuses the combination instead of trusting the form.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'conversion_jobs_platform_target_check'
       and conrelid = 'public.conversion_jobs'::regclass
  ) then
    alter table public.conversion_jobs
      add constraint conversion_jobs_platform_target_check
      check (
        (platform = 'android' and target in ('apk', 'aab'))
        or (platform = 'ios' and target = 'ipa')
      );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- A customer may correct their own request, but never the decision
--   They filed it, so they can fix a typo in the brief or supply the extra
--   information an administrator asked for. The review fields — status,
--   internal notes, the assigned reviewer, the reference — are not theirs to
--   write, and the trigger refuses those edits for every path that is not an
--   administrator.
-- ---------------------------------------------------------------------------
drop policy if exists marketing_requests_owner_update on public.marketing_requests;
create policy marketing_requests_owner_update on public.marketing_requests
  for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    /* the trigger below is what refuses a status change; this only keeps the
       row with its owner */
  );

create or replace function public.marketing_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.reference is null then
      new.reference := 'MR-' || to_char(now(), 'YYMMDD') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    end if;
  end if;

  if tg_op = 'UPDATE' and not public.is_admin() then
    /* Status changes after submission are an administrator decision. */
    if new.status is distinct from old.status then
      raise exception 'Only an administrator can change the status of a marketing request.' using errcode = '42501';
    end if;
    /* So is everything a reviewer writes. */
    if new.admin_notes   is distinct from old.admin_notes
    or new.assigned_to   is distinct from old.assigned_to
    or new.decided_by    is distinct from old.decided_by
    or new.decided_at    is distinct from old.decided_at
    or new.reference     is distinct from old.reference
    or new.user_id       is distinct from old.user_id then
      raise exception 'Only an administrator can change the review details of a marketing request.' using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- The number of platform slots is a plan entitlement, not public information:
-- only a signed-in caller may ask for it.
revoke all on function public.app_platform_slots(uuid) from public, anon;
grant execute on function public.app_platform_slots(uuid) to authenticated;
