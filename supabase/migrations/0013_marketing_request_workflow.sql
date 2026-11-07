-- ============================================================================
-- SHINZORA · 0013_marketing_request_workflow.sql
-- ----------------------------------------------------------------------------
-- The request lifecycle behind "Request for Extra Service". 0011 created the
-- tables and the ownership policies; this migration adds what the finished
-- workflow needs and nothing else:
--
--   • a place to keep the request's own detail — age range, interests, ad copy,
--     landing page, Instagram profile, asset list — without inventing a column
--     per field and without a second table to keep in step
--   • a 'draft' status, so a half-finished request can be saved without being
--     announced to administrators
--   • one transition the customer themselves may make: draft → submitted.
--     Every other transition stays an administrator decision, enforced by the
--     trigger, not by the screen
--   • a notification for the customer when an administrator decides, written by
--     a SECURITY DEFINER function that only an administrator can call
--   • a private storage bucket for the creative assets a request carries
--
-- Nothing here launches an advert, charges a card or spends money.
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Request detail
-- ---------------------------------------------------------------------------
alter table public.marketing_requests
  add column if not exists details jsonb not null default '{}'::jsonb;

comment on column public.marketing_requests.details is
  'Request-specific answers: business description, Instagram profile, age range, interests, ad copy, landing page, asset paths.';

-- ---------------------------------------------------------------------------
-- Drafts
--   A draft is the customer's own working copy. 0011 created the status check
--   inline, so it is replaced by name with the draft state added.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'marketing_requests_status_check'
       and conrelid = 'public.marketing_requests'::regclass
  ) then
    alter table public.marketing_requests drop constraint marketing_requests_status_check;
  end if;

  alter table public.marketing_requests
    add constraint marketing_requests_status_check
    check (status in ('draft', 'submitted', 'under_review', 'more_information_required',
                      'approved', 'in_progress', 'completed', 'rejected'));
end;
$$;

/* A draft is not a request yet: it has no reference, so nothing can quote it
   before it has been submitted. */
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'marketing_requests_reference_check'
       and conrelid = 'public.marketing_requests'::regclass
  ) then
    alter table public.marketing_requests drop constraint marketing_requests_reference_check;
  end if;
end;
$$;

create unique index if not exists marketing_requests_reference_unique
  on public.marketing_requests (reference)
  where reference is not null;

-- ---------------------------------------------------------------------------
-- The guard, with the one customer transition spelled out
-- ---------------------------------------------------------------------------
create or replace function public.marketing_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  customer_may_submit boolean;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'submitted') and not public.is_admin() then
      raise exception 'A new request starts as a draft or as submitted.' using errcode = '42501';
    end if;

    /* A reference is issued at submission, never for a draft. */
    if new.status <> 'draft' and new.reference is null then
      new.reference := 'MR-' || to_char(now(), 'YYMMDD') || '-' ||
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    end if;
    if new.status = 'draft' then
      new.reference := null;
    end if;
  end if;

  if tg_op = 'UPDATE' and not public.is_admin() then
    if new.status is distinct from old.status then
      /* Submitting your own draft is the one thing a customer may do to the
         status; it is also the moment the reference is issued. */
      customer_may_submit := old.status = 'draft' and new.status = 'submitted';
      if not customer_may_submit then
        raise exception 'Only an administrator can change the status of a marketing request.' using errcode = '42501';
      end if;
      if new.reference is null then
        new.reference := 'MR-' || to_char(now(), 'YYMMDD') || '-' ||
          upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
      end if;
    end if;

    if new.admin_notes   is distinct from old.admin_notes
    or new.assigned_to   is distinct from old.assigned_to
    or new.decided_by    is distinct from old.decided_by
    or new.decided_at    is distinct from old.decided_at
    or new.user_id       is distinct from old.user_id then
      raise exception 'Only an administrator can change the review details of a marketing request.' using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists marketing_requests_guard on public.marketing_requests;
create trigger marketing_requests_guard
  before insert or update on public.marketing_requests
  for each row execute function public.marketing_requests_guard();

-- A draft must be insertable by its owner, and a submitted request too.
drop policy if exists marketing_requests_owner_insert on public.marketing_requests;
create policy marketing_requests_owner_insert on public.marketing_requests
  for insert with check (user_id = auth.uid() and status in ('draft', 'submitted'));

-- ---------------------------------------------------------------------------
-- The customer's own timeline entry
--   The "Submitted" event is the customer's action, so they may write a
--   customer-visible event on their own request — never an internal one.
-- ---------------------------------------------------------------------------
drop policy if exists marketing_request_events_owner_insert on public.marketing_request_events;
create policy marketing_request_events_owner_insert on public.marketing_request_events
  for insert with check (
    internal = false
    and actor_id = auth.uid()
    and exists (
      select 1 from public.marketing_requests r
       where r.id = request_id and r.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- notify_customer — an administrator telling a customer something
--   A customer cannot insert a notification for themselves through the normal
--   policies, and an administrator must not be able to write into anybody's
--   inbox without limit: this function is admin-only, writes exactly one row
--   and nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.notify_customer(
  p_user uuid,
  p_title text,
  p_body text default null,
  p_link text default null,
  p_type text default 'marketing'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  made uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can notify a customer.' using errcode = '42501';
  end if;
  if p_user is null then
    raise exception 'A recipient is required.' using errcode = '22023';
  end if;

  insert into public.notifications (user_id, title, body, type, link)
  values (p_user, left(coalesce(p_title, 'Update'), 160), left(coalesce(p_body, ''), 600),
          coalesce(p_type, 'marketing'), p_link)
  returning id into made;

  return made;
end;
$$;

revoke all on function public.notify_customer(uuid, text, text, text, text) from public, anon;
grant execute on function public.notify_customer(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Creative assets
--   A private bucket, one folder per user, images and PDFs only. The customer
--   uploads; the administrator reads through a short-lived signed URL. Nothing
--   is public.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('marketing-assets', 'marketing-assets', false, 10485760,
            array['image/png','image/jpeg','image/webp','image/svg+xml','application/pdf'])
    on conflict (id) do nothing;
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'objects') then
    execute $p$
      drop policy if exists marketing_assets_owner_rw on storage.objects;
    $p$;
    execute $p$
      create policy marketing_assets_owner_rw on storage.objects
        for all
        using (
          bucket_id = 'marketing-assets'
          and (split_part(name, '/', 1) = auth.uid()::text or public.is_admin())
        )
        with check (
          bucket_id = 'marketing-assets'
          and split_part(name, '/', 1) = auth.uid()::text
        );
    $p$;
  end if;
end;
$$;

comment on table public.marketing_requests is
  'A request for marketing work. Submitting one never launches an advert; only an administrator can approve, start or complete it.';
