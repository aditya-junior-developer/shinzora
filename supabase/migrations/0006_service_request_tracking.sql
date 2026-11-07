-- ===========================================================================
-- 0006 — service request tracking
-- ---------------------------------------------------------------------------
-- Additive only. Nothing is dropped, renamed or recreated, and every existing
-- row stays exactly as it is: the new columns are nullable, the backfill fills
-- them from data that is already there.
--
-- Why: a request a customer can see is only useful if it carries a stable
-- reference, a person who owns it and a target date. Internal notes need a
-- home that a customer can never read — RLS is row level, so putting an
-- internal note on service_requests would expose it the moment the customer
-- selects the row. Hence the small companion table.
-- ===========================================================================

-- ---------------------------------------------------------------- new columns
alter table public.service_requests add column if not exists reference      text;
alter table public.service_requests add column if not exists assigned_to    uuid references auth.users(id) on delete set null;
alter table public.service_requests add column if not exists due_at         timestamptz;
alter table public.service_requests add column if not exists accepted_at    timestamptz;
alter table public.service_requests add column if not exists completed_at   timestamptz;

comment on column public.service_requests.reference   is 'Customer-facing reference, e.g. SR-4F2A9C10. Unique.';
comment on column public.service_requests.assigned_to is 'Shinzora representative handling the request.';
comment on column public.service_requests.due_at      is 'Target completion date set by Shinzora. Never a promise made on Google''s behalf.';

-- backfill: existing rows get a stable reference derived from their own id, so
-- a customer who quoted an old request still quotes something that resolves.
update public.service_requests
   set reference = 'SR-' || upper(substr(replace(id::text, '-', ''), 1, 8))
 where reference is null;

-- timestamps for rows that are already finished
update public.service_requests
   set completed_at = coalesce(completed_at, updated_at)
 where status in ('completed', 'rejected', 'cancelled')
   and completed_at is null;

-- new rows get a reference at insert time; a null reference is never handed out
create or replace function public.set_service_request_reference()
returns trigger
language plpgsql
as $$
begin
  if new.reference is null or length(trim(new.reference)) = 0 then
    new.reference := 'SR-' || upper(substr(replace(coalesce(new.id, gen_random_uuid())::text, '-', ''), 1, 8));
  end if;
  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists service_requests_reference on public.service_requests;
create trigger service_requests_reference
  before insert or update of status on public.service_requests
  for each row execute function public.set_service_request_reference();

create unique index if not exists service_requests_reference_key
  on public.service_requests (reference)
  where reference is not null;

create index if not exists service_requests_assigned_idx
  on public.service_requests (assigned_to, status);

-- requests that are open and past their target date, for the overdue badge
create index if not exists service_requests_due_idx
  on public.service_requests (due_at)
  where status in ('requested', 'approved', 'in_progress');

-- ------------------------------------------------------------- internal notes
create table if not exists public.service_request_notes (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.service_requests(id) on delete cascade,
  author_id   uuid references auth.users(id) on delete set null,
  body        text not null,
  visibility  text not null default 'internal' check (visibility in ('internal', 'customer')),
  created_at  timestamptz not null default now()
);

create index if not exists service_request_notes_request_idx
  on public.service_request_notes (request_id, created_at);

alter table public.service_request_notes enable row level security;

-- a customer sees only the notes written for them, on their own requests
drop policy if exists service_request_notes_customer_read on public.service_request_notes;
create policy service_request_notes_customer_read on public.service_request_notes
  for select using (
    visibility = 'customer'
    and exists (
      select 1 from public.service_requests r
       where r.id = service_request_notes.request_id
         and r.owner_id = auth.uid()
    )
  );

-- an administrator reads every note, internal included
drop policy if exists service_request_notes_admin_read on public.service_request_notes;
create policy service_request_notes_admin_read on public.service_request_notes
  for select using (public.is_admin());

drop policy if exists service_request_notes_admin_write on public.service_request_notes;
create policy service_request_notes_admin_write on public.service_request_notes
  for insert with check (public.is_admin());

drop policy if exists service_request_notes_admin_update on public.service_request_notes;
create policy service_request_notes_admin_update on public.service_request_notes
  for update using (public.is_admin()) with check (public.is_admin());

-- Customers never write here. There is deliberately no insert policy for them:
-- their channel is the support ticket thread, which is timestamped and audited.

-- ---------------------------------------------------------- access summary
-- RLS stays row level: a customer reads only their own request, an admin reads
-- all of them. `assigned_to` is safe for a customer to see — knowing who owns
-- the request is useful — and everything an administrator must keep private
-- lives in service_request_notes above, which has no customer insert path and
-- filters internal notes out of the customer's read.
--
-- Column level grants are deliberately not used here: an administrator is also
-- role `authenticated`, so a column grant would hide assigned_to/due_at from
-- the admin panel as well.
