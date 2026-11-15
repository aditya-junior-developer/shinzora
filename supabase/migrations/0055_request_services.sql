-- ============================================================================
-- 0055 — Request Services (P7)
--
-- A request is not a purchase. A customer asks for one of the ten categories,
-- gives a budget in INR, and a specialist contacts them within 24 hours.
--
-- Rules enforced here, not in the browser:
--   - Statuses are exactly: submitted, under_review, in_progress, completed,
--     rejected.
--   - A customer can only insert a request at 'submitted', with no amount, no
--     assignee, no payment and no admin note. Customers cannot update or delete
--     a request at all. Only an administrator changes a request after it exists.
--   - The ten new categories need a positive budget. 'others' needs a written
--     description of at least 10 characters.
--   - Every status change, every new admin note and the initial submission
--     notify the owner. One trigger does this, so no code path can skip it.
--
-- The permissive policies sz_service_requests_owner_insert and
-- sz_service_requests_owner_update existed only in the live database, not in
-- any migration. They let a customer write any status. They are dropped here.
-- ============================================================================

-- ---------------------------------------------------------------- statuses
alter table public.service_requests drop constraint if exists service_requests_status_check;

update public.service_requests
   set status = case status
     when 'requested' then 'submitted'
     when 'approved' then 'under_review'
     when 'cancelled' then 'rejected'
     else status
   end
 where status in ('requested', 'approved', 'cancelled');

alter table public.service_requests
  add constraint service_requests_status_check
  check (status in ('submitted', 'under_review', 'in_progress', 'completed', 'rejected'));

alter table public.service_requests alter column status set default 'submitted';

-- --------------------------------------------------------- new intake fields
alter table public.service_requests add column if not exists budget_inr numeric(12, 2);
alter table public.service_requests add column if not exists custom_description text;
alter table public.service_requests add column if not exists contact_name text;
alter table public.service_requests add column if not exists contact_email text;
alter table public.service_requests add column if not exists contact_phone text;
alter table public.service_requests add column if not exists respond_by timestamptz default (now() + interval '24 hours');

comment on column public.service_requests.budget_inr is
  'The customer''s expected budget in Indian rupees, as typed. Required for the ten Request Services categories.';
comment on column public.service_requests.respond_by is
  'When a specialist should have contacted the customer: 24 hours after submission. Shown to the customer and to admins as overdue when it passes.';

-- Keep the database rules and the browser's rules identical for the new fields.
do $$
begin
  if exists (
    select 1 from public.service_requests
     where service_type not in (
       'business_cards', 'meta_ads', 'video_maker', 'post_maker', 'nfc_cards',
       'custom_packaging', 'export_international', 'business_audits', 'ai_calling', 'others',
       'plan_upgrade', 'account_deletion', 'domain_registration',
       'website_setup', 'brand_kit', 'store_setup'
     )
  ) then
    raise exception '0055: existing service requests use a service type that is not in the allowed list. Resolve them before applying this migration.';
  end if;
end $$;

alter table public.service_requests drop constraint if exists service_requests_service_type_check;
alter table public.service_requests
  add constraint service_requests_service_type_check
  check (service_type in (
    'business_cards', 'meta_ads', 'video_maker', 'post_maker', 'nfc_cards',
    'custom_packaging', 'export_international', 'business_audits', 'ai_calling', 'others',
    'plan_upgrade', 'account_deletion', 'domain_registration',
    'website_setup', 'brand_kit', 'store_setup'
  ));

alter table public.service_requests drop constraint if exists service_requests_budget_required;
alter table public.service_requests
  add constraint service_requests_budget_required
  check (
    service_type not in (
      'business_cards', 'meta_ads', 'video_maker', 'post_maker', 'nfc_cards',
      'custom_packaging', 'export_international', 'business_audits', 'ai_calling', 'others'
    )
    or (budget_inr is not null and budget_inr > 0 and budget_inr <= 100000000)
  );

alter table public.service_requests drop constraint if exists service_requests_others_described;
alter table public.service_requests
  add constraint service_requests_others_described
  check (
    service_type <> 'others'
    or length(btrim(coalesce(custom_description, ''))) >= 10
  );

alter table public.service_requests drop constraint if exists service_requests_custom_description_length;
alter table public.service_requests
  add constraint service_requests_custom_description_length
  check (custom_description is null or char_length(custom_description) <= 2000);

-- Open requests past their 24-hour contact time, for the admin overdue badge.
drop index if exists public.service_requests_due_idx;
create index if not exists service_requests_open_idx
  on public.service_requests (status, respond_by)
  where status in ('submitted', 'under_review', 'in_progress');

-- ----------------------------------------------------------- row level security
drop policy if exists service_requests_owner_insert on public.service_requests;
drop policy if exists sz_service_requests_owner_insert on public.service_requests;
drop policy if exists sz_service_requests_owner_update on public.service_requests;
drop policy if exists sz_service_requests_admin_update on public.service_requests;
drop policy if exists service_requests_admin_update on public.service_requests;

create policy service_requests_customer_insert on public.service_requests
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and status = 'submitted'
    and amount is null
    and payment_id is null
    and assigned_to is null
    and admin_note is null
  );

create policy service_requests_admin_update on public.service_requests
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- The owner's read policy (service_requests_owner_all) is kept as it was.

-- ------------------------------------------------------------- notifications
create or replace function public.service_request_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
  v_name text;
  v_label text;
  v_link text;
begin
  v_ref := coalesce(new.reference, 'SR-' || upper(substr(replace(new.id::text, '-', ''), 1, 8)));
  v_name := coalesce(nullif(new.title, ''), new.service_type);
  v_link := '/app/?view=requests&id=' || new.id::text;

  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, title, body, type, link)
    values (
      new.owner_id,
      'Request received',
      v_name || ' (' || v_ref || '). A specialist will connect with you within 24 hours.',
      'account',
      v_link
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    v_label := case new.status
      when 'submitted' then 'Submitted'
      when 'under_review' then 'Under Review'
      when 'in_progress' then 'In Progress'
      when 'completed' then 'Completed'
      when 'rejected' then 'Rejected'
      else new.status
    end;
    insert into public.notifications (user_id, title, body, type, link)
    values (
      new.owner_id,
      'Request update: ' || v_label,
      v_name || ' (' || v_ref || ') is now ' || v_label || '.' || coalesce(' ' || new.admin_note, ''),
      'account',
      v_link
    );
  elsif new.admin_note is distinct from old.admin_note and new.admin_note is not null then
    insert into public.notifications (user_id, title, body, type, link)
    values (
      new.owner_id,
      'New note on your request',
      v_name || ' (' || v_ref || '): ' || new.admin_note,
      'account',
      v_link
    );
  end if;
  return new;
end;
$$;

revoke all on function public.service_request_notify() from public, anon, authenticated;

drop trigger if exists service_requests_notify on public.service_requests;
create trigger service_requests_notify
  after insert or update of status, admin_note on public.service_requests
  for each row execute function public.service_request_notify();
