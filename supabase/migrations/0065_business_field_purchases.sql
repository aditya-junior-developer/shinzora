-- Business profile fields for the AI (brief item 8).
--
-- An owner ticks business-profile fields in Settings. Each ticked field costs
-- ₹10 (1000 paise). The payment is created by the `payments` Edge Function,
-- which recomputes the amount from the ticked list and ignores any amount the
-- browser sends. When the payment is verified, the ticked fields are added to
-- `businesses.ai_fields`, and the `ai` function includes them in the context it
-- builds for that business.
--
-- Nothing activates before verification. Owners cannot write `ai_fields`
-- directly; only the verified-payment trigger below can, through a local
-- setting that a plain client update cannot set.

-- 1. The fields a business may tick. Kept in one place so the check constraint,
--    the Settings checklist and the Edge Function all agree.
create table if not exists public.business_field_catalog (
  key text primary key,
  label text not null,
  sort_order int not null
);

insert into public.business_field_catalog (key, label, sort_order) values
  ('name', 'Business name', 1),
  ('category', 'Category', 2),
  ('location', 'Location', 3),
  ('description', 'What the business does', 4),
  ('target_audience', 'Target audience', 5),
  ('website_url', 'Website', 6),
  ('phone', 'Business phone', 7),
  ('email', 'Business email', 8)
on conflict (key) do update set label = excluded.label, sort_order = excluded.sort_order;

alter table public.business_field_catalog enable row level security;
drop policy if exists business_field_catalog_read on public.business_field_catalog;
create policy business_field_catalog_read on public.business_field_catalog
  for select to anon, authenticated using (true);
revoke all on public.business_field_catalog from public, anon, authenticated;
grant select on public.business_field_catalog to anon, authenticated;

-- 2. One row per paid purchase. Written by the Edge Function (service role)
--    before payment; read by the owner for their own history.
create table if not exists public.business_field_orders (
  payment_id uuid primary key references public.payments(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  fields text[] not null check (
    cardinality(fields) between 1 and 8
    and fields <@ array['name','category','location','description','target_audience','website_url','phone','email']::text[]
  ),
  amount_paise integer not null check (amount_paise >= 1000),
  created_at timestamptz not null default now()
);

create index if not exists business_field_orders_business_idx
  on public.business_field_orders (business_id);

alter table public.business_field_orders enable row level security;
drop policy if exists business_field_orders_owner_read on public.business_field_orders;
create policy business_field_orders_owner_read on public.business_field_orders
  for select to authenticated using (owner_id = auth.uid());
revoke all on public.business_field_orders from public, anon, authenticated;
grant select on public.business_field_orders to authenticated;

-- 3. The AI-visible fields on the business. Only keys from the catalogue.
alter table public.businesses
  add column if not exists ai_fields text[] not null default '{}';

-- A check constraint cannot read another table, so the keys are listed here.
-- They must match business_field_catalog above; a new field needs a migration
-- that changes both.
alter table public.businesses drop constraint if exists businesses_ai_fields_known;
alter table public.businesses add constraint businesses_ai_fields_known check (
  ai_fields <@ array['name','category','location','description','target_audience','website_url','phone','email']::text[]
);

-- 4. Owners cannot grant themselves AI fields. Only the verified-payment trigger
--    may change the column, and it sets a transaction-local flag to say so.
create or replace function public.guard_business_ai_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.ai_fields is distinct from old.ai_fields
     and coalesce(current_setting('shinzora.grant_ai_fields', true), '') <> 'on'
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AI fields are granted by a verified payment only' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_business_ai_fields() from public, anon, authenticated;

drop trigger if exists businesses_guard_ai_fields on public.businesses;
create trigger businesses_guard_ai_fields
  before update of ai_fields on public.businesses
  for each row execute function public.guard_business_ai_fields();

-- 5. Verified payment → grant the ticked fields. Runs once per payment.
create or replace function public.business_fields_from_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fields text[];
  v_business uuid;
begin
  if new.purpose = 'business_fields'
     and new.status = 'verified'
     and coalesce(old.status, '') <> 'verified' then
    select o.fields, o.business_id into v_fields, v_business
      from public.business_field_orders o
     where o.payment_id = new.id;

    if v_fields is not null then
      perform set_config('shinzora.grant_ai_fields', 'on', true);
      update public.businesses b
         set ai_fields = (
           select coalesce(array_agg(distinct f order by f), '{}')
             from unnest(b.ai_fields || v_fields) as f
         )
       where b.id = v_business;
      perform set_config('shinzora.grant_ai_fields', 'off', true);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.business_fields_from_payment() from public, anon, authenticated;

drop trigger if exists payments_business_fields on public.payments;
create trigger payments_business_fields
  after update of status on public.payments
  for each row execute function public.business_fields_from_payment();
