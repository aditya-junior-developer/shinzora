-- ===========================================================================
-- 0008 — payment webhook idempotency
-- ---------------------------------------------------------------------------
-- A payment gateway retries. The same event can arrive twice, three times, or
-- twice at the same moment. Every retry used to be indistinguishable from a new
-- payment, which is how one payment becomes two records, two "payment received"
-- notifications and a subscription extended twice.
--
-- The fix is an inbox: every event is stored under its gateway event id before
-- it is acted on, and the unique key makes the second copy impossible. The
-- payment record itself is additionally pinned to the gateway's payment id, so
-- even an event with a fresh id cannot create a second payment row.
--
-- Nothing is deleted and no existing row is rewritten: the two unique indexes
-- are created only after proving there is no duplicate data to break them.
-- ===========================================================================

-- ------------------------------------------------------------- event inbox
create table if not exists public.payment_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null default 'razorpay',
  event_id      text not null,
  event_type    text,
  payment_id    text,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'failed')),
  attempts      integer not null default 1,
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_id)
);

create index if not exists payment_webhook_events_received_idx
  on public.payment_webhook_events (received_at desc);
create index if not exists payment_webhook_events_payment_idx
  on public.payment_webhook_events (provider, payment_id);

comment on table public.payment_webhook_events is
  'Gateway event inbox. (provider, event_id) is unique, so a retried delivery is recognised and ignored instead of applied twice.';

alter table public.payment_webhook_events enable row level security;

-- Only administrators may read the inbox; it holds raw gateway payloads.
drop policy if exists payment_webhook_events_admin_read on public.payment_webhook_events;
create policy payment_webhook_events_admin_read on public.payment_webhook_events
  for select using (public.is_admin());
-- Edge functions run as service_role, which bypasses RLS. No customer policy is
-- defined on purpose: a customer has no business reading gateway payloads.

-- ------------------------------------------------- payment record uniqueness
-- Pre-flight: report duplicates instead of failing on create index.
do $$
declare
  dupe_pairs bigint;
begin
  select count(*) into dupe_pairs
    from (
      select provider, provider_payment_id
        from public.payments
       where provider_payment_id is not null
       group by provider, provider_payment_id
      having count(*) > 1
    ) d;

  insert into public.migration_notes (migration, entity, action, detail)
  values ('0008_payment_webhook_idempotency', 'payments', 'preflight',
          jsonb_build_object('duplicate_provider_payment_ids', dupe_pairs));

  if dupe_pairs > 0 then
    raise notice '0008 pre-flight: % duplicated provider payment id(s) already exist; the unique index will not be created until they are reconciled', dupe_pairs;
  end if;
end;
$$;

-- Created only when the data allows it. A partial unique index is the guarantee
-- that one gateway payment maps to exactly one local payment row.
do $$
declare
  dupe_pairs bigint;
begin
  select count(*) into dupe_pairs
    from (
      select provider, provider_payment_id
        from public.payments
       where provider_payment_id is not null
       group by provider, provider_payment_id
      having count(*) > 1
    ) d;

  if dupe_pairs = 0 then
    execute 'create unique index if not exists payments_provider_payment_unique
               on public.payments (provider, provider_payment_id)
               where provider_payment_id is not null';
  end if;
end;
$$;

-- ------------------------------------------------------- dedupe notifications
-- The same event must not notify twice. A notification raised by a webhook
-- carries the event id in its meta, and this index makes a second insert for
-- the same event impossible.
create unique index if not exists notifications_one_per_webhook_event
  on public.notifications ((meta ->> 'webhook_event_id'))
  where (meta ? 'webhook_event_id');

-- --------------------------------------------------------------- verification
do $$
begin
  if not exists (select 1 from pg_class where relname = 'payment_webhook_events' and relkind = 'r') then
    raise exception '0008 failed: payment_webhook_events was not created';
  end if;

  insert into public.migration_notes (migration, entity, action, detail)
  values ('0008_payment_webhook_idempotency', 'payments', 'index_created',
          jsonb_build_object('provider_payment_unique',
                             exists (select 1 from pg_indexes
                                      where schemaname = 'public'
                                        and indexname = 'payments_provider_payment_unique'),
                             'existing_payment_rows', (select count(*) from public.payments)));
end;
$$;
