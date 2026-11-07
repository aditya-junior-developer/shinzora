-- ===========================================================================
-- 0007 — one open payment reference per customer per purpose
-- ---------------------------------------------------------------------------
-- The problem this closes: a customer clicking "Pay" twice, or two tabs racing,
-- used to be able to create two pending payment records for the same purpose,
-- each with its own SZ- reference. Two references for one intent means the
-- administrator cannot tell which UTR belongs to which row, and the customer
-- sees two open payments for one plan.
--
-- The rule: at most ONE open payment per (customer, purpose). A new reference is
-- issued only when the purpose changes. Re-opening the same purpose reuses the
-- existing open row and its reference.
--
-- Safe on existing data: nothing is deleted. Superseded duplicates are marked
-- `cancelled` — a status that already exists — and the reason is written into
-- admin_note so the row still tells its own story. Verified, rejected and
-- refunded rows are never touched.
-- ===========================================================================

-- ------------------------------------------------------------ audit of changes
-- What a migration changed, so an administrator can read it back later instead
-- of having to trust a release note.
create table if not exists public.migration_notes (
  id          uuid primary key default gen_random_uuid(),
  migration   text not null,
  entity      text not null,
  entity_id   text,
  action      text not null,
  detail      jsonb default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists migration_notes_migration_idx
  on public.migration_notes (migration, created_at desc);

alter table public.migration_notes enable row level security;

drop policy if exists migration_notes_admin_read on public.migration_notes;
create policy migration_notes_admin_read on public.migration_notes
  for select using (public.is_admin());

-- ------------------------------------------------------- pre-flight reporting
-- Record, before touching anything, exactly how many duplicate groups exist.
-- An empty database records zero and moves on; a live one gets a number that
-- can be compared against the row count afterwards.
do $$
declare
  dupe_groups bigint;
  dupe_rows   bigint;
begin
  select count(*), coalesce(sum(n - 1), 0) into dupe_groups, dupe_rows
    from (
      select owner_id, purpose, count(*) as n
        from public.payments
       where status in ('pending', 'awaiting_verification')
       group by owner_id, purpose
      having count(*) > 1
    ) d;

  insert into public.migration_notes (migration, entity, action, detail)
  values ('0007_customer_reference_uniqueness', 'payments', 'preflight',
          jsonb_build_object('duplicate_groups', dupe_groups, 'redundant_rows', dupe_rows));

  raise notice '0007 pre-flight: % purpose group(s) with more than one open payment, % redundant row(s)', dupe_groups, dupe_rows;
end;
$$;

-- ------------------------------------------------------- resolve duplicates
-- Keep the row that has travelled furthest: a payment with a submitted proof
-- (awaiting_verification) beats an untouched pending one, because money may
-- already have moved. Tie-break on newest, then id, so the result is
-- deterministic and re-runnable.
do $$
declare
  r record;
  keeper record;
begin
  for r in
    select owner_id, purpose
      from public.payments
     where status in ('pending', 'awaiting_verification')
     group by owner_id, purpose
    having count(*) > 1
  loop
    select id, reference into keeper
      from public.payments
     where owner_id = r.owner_id
       and purpose = r.purpose
       and status in ('pending', 'awaiting_verification')
     order by (status = 'awaiting_verification') desc, created_at desc, id
     limit 1;

    update public.payments p
       set status = 'cancelled',
           admin_note = coalesce(p.admin_note || ' · ', '')
             || 'Superseded by ' || keeper.reference
             || ' on migration 0007: one open payment per purpose. Row kept for audit.',
           updated_at = now()
     where p.owner_id = r.owner_id
       and p.purpose = r.purpose
       and p.id <> keeper.id
       and p.status in ('pending', 'awaiting_verification');

    insert into public.migration_notes (migration, entity, entity_id, action, detail)
    values ('0007_customer_reference_uniqueness', 'payments', keeper.id::text, 'superseded_duplicates',
            jsonb_build_object('purpose', r.purpose, 'kept_reference', keeper.reference));
  end loop;
end;
$$;

-- ------------------------------------------------------------- the constraint
-- Partial, so it constrains only OPEN payments. A customer may hold many
-- historical references for the same purpose: verified, rejected, cancelled and
-- refunded rows are audit history and must stay.
create unique index if not exists payments_one_open_per_purpose
  on public.payments (owner_id, purpose)
  where status in ('pending', 'awaiting_verification');

comment on index public.payments_one_open_per_purpose is
  'One open payment per customer per purpose. A second open row for the same purpose is a duplicate reference; reuse the existing one.';

-- ------------------------------------------------------ reuse helper (server)
-- Returns the reference of the open payment for a customer and purpose, so the
-- API can hand back the existing record instead of minting a new one. Returns
-- null when there is nothing open, which is the signal to create.
create or replace function public.open_payment_reference(p_owner uuid, p_purpose text)
returns table (id uuid, reference text, status text, amount numeric)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.reference, p.status, p.amount
    from public.payments p
   where p.owner_id = p_owner
     and p.purpose = p_purpose
     and p.status in ('pending', 'awaiting_verification')
   order by (p.status = 'awaiting_verification') desc, p.created_at desc
   limit 1
$$;

revoke all on function public.open_payment_reference(uuid, text) from public;
grant execute on function public.open_payment_reference(uuid, text) to authenticated, service_role;

-- --------------------------------------------------------------- verification
-- A mis-scoped partial index is worse than none, so assert the shape. If the
-- index is missing the migration fails loudly instead of finishing quietly.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'payments_one_open_per_purpose'
  ) then
    raise exception '0007 failed: payments_one_open_per_purpose was not created';
  end if;

  insert into public.migration_notes (migration, entity, action, detail)
  values ('0007_customer_reference_uniqueness', 'payments', 'index_created',
          jsonb_build_object('index', 'payments_one_open_per_purpose',
                             'open_rows', (select count(*) from public.payments
                                            where status in ('pending', 'awaiting_verification')),
                             'total_rows', (select count(*) from public.payments)));
end;
$$;
