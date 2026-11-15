-- ============================================================================
-- 0058 — Investor role and investor decks (P9)
--
-- Four login roles now exist: business owner, agent, admin (a staff flag, not an
-- account type) and investor. An investor can read only what a founder has
-- shared with them. An investor cannot write business data, cannot build decks,
-- and cannot be an owner or an agent.
--
-- Deck building is owner-only and enforced here, not in the browser:
--   - an AI deck is free; it draws only on the data sections the owner ticked,
--     and those sections are read by deck_data_snapshot, which checks the owner;
--   - a manual deck's PDF export costs Rs 20. The verified payment (purpose
--     'deck_pdf') writes one row to deck_exports, and an export consumes one row.
--
-- Investors read decks only through investor_shared_decks(). There is no
-- table-level read of investor_decks for anyone but the owner.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The fourth account type.
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_account_type_check;
alter table public.profiles
  add constraint profiles_account_type_check
  check (account_type in ('owner', 'agent', 'investor'));

-- The investor role is entered once, through investor_join(), and cannot be
-- switched on or off by any other path. The guard reads a transaction-local
-- flag that only investor_join() sets.
create or replace function public.profiles_investor_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.account_type is distinct from old.account_type
     and (old.account_type = 'investor' or new.account_type = 'investor')
     and coalesce(current_setting('shinzora.investor_join', true), '') <> 'on' then
    raise exception 'The investor role is chosen when you join and cannot be switched here.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.profiles_investor_guard() from public, anon, authenticated;

drop trigger if exists profiles_investor_guard on public.profiles;
create trigger profiles_investor_guard
  before update of account_type on public.profiles
  for each row execute function public.profiles_investor_guard();

-- set_account_type (0023) let anyone pick owner or agent. Now an investor cannot
-- move to either, and nobody can move to investor here.
create or replace function public.set_account_type(p_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  wanted text := lower(btrim(coalesce(p_type, '')));
  current_type text;
begin
  if actor is null then raise exception 'Sign in to change your account type.' using errcode = '42501'; end if;
  if wanted not in ('owner', 'agent') then
    raise exception 'Choose whether you run a business or work as an agent.' using errcode = '22023';
  end if;
  select account_type into current_type from public.profiles where id = actor;
  if current_type = 'investor' then
    raise exception 'An investor account cannot change its type. Contact support if you need a different account.'
      using errcode = '42501';
  end if;
  update public.profiles set account_type = wanted, updated_at = now() where id = actor;
  return jsonb_build_object('accountType', wanted);
end;
$$;

-- The one way into the investor role. A new account with no business can join;
-- an agent or a business owner cannot.
create or replace function public.investor_join(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  current_type text;
begin
  if actor is null then raise exception 'Sign in to join as an investor.' using errcode = '42501'; end if;

  select account_type into current_type from public.profiles where id = actor for update;
  if current_type = 'investor' then
    return jsonb_build_object('accountType', 'investor');
  end if;
  if current_type is distinct from 'owner' then
    raise exception 'Only a new account can join as an investor.' using errcode = '22023';
  end if;
  if exists (select 1 from public.businesses where owner_id = actor) then
    raise exception 'This account already runs a business. An investor account starts empty.' using errcode = '22023';
  end if;

  perform public.set_username(p_username);
  perform set_config('shinzora.investor_join', 'on', true);
  update public.profiles set account_type = 'investor', updated_at = now() where id = actor;
  perform set_config('shinzora.investor_join', 'off', true);

  return jsonb_build_object('accountType', 'investor');
end;
$$;

revoke all on function public.investor_join(text) from public, anon;
grant execute on function public.investor_join(text) to authenticated, service_role;

-- Role check used by row-level policies. Security definer so a policy never
-- depends on the caller's own profile read.
create or replace function public.is_account_type(p_type text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and account_type = p_type);
$$;

revoke all on function public.is_account_type(text) from public, anon;
grant execute on function public.is_account_type(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Decks, shares and export entitlements.
-- ---------------------------------------------------------------------------
create table if not exists public.investor_decks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 2 and 120),
  mode text not null default 'manual' check (mode in ('ai', 'manual')),
  status text not null default 'draft' check (status in ('draft', 'ready')),
  data_sections text[] not null default '{}'
    check (data_sections <@ array['business', 'inventory', 'sales']::text[]),
  slides jsonb not null default '[]'::jsonb
    check (jsonb_typeof(slides) = 'array' and jsonb_array_length(slides) <= 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A deck can be shared only once it has a real shape.
  check (status = 'draft' or jsonb_array_length(slides) >= 3)
);

create index if not exists investor_decks_owner_idx on public.investor_decks (owner_id, updated_at desc);

create table if not exists public.investor_deck_shares (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references public.investor_decks(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  investor_id uuid not null references public.profiles(id) on delete cascade,
  shared_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (deck_id, investor_id),
  check (owner_id <> investor_id)
);

create index if not exists investor_deck_shares_investor_idx
  on public.investor_deck_shares (investor_id) where revoked_at is null;

create table if not exists public.deck_exports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  payment_id uuid not null unique references public.payments(id) on delete cascade,
  deck_id uuid references public.investor_decks(id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index if not exists deck_exports_owner_idx on public.deck_exports (owner_id) where used_at is null;

-- A verified Rs 20 payment becomes one unused export.
create or replace function public.deck_export_from_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purpose = 'deck_pdf'
     and new.status = 'verified'
     and coalesce(old.status, '') <> 'verified' then
    insert into public.deck_exports (owner_id, payment_id)
    values (new.owner_id, new.id)
    on conflict (payment_id) do nothing;

    insert into public.notifications (user_id, title, body, type, link)
    values (
      new.owner_id,
      'Deck PDF payment received',
      'Your investor deck export is confirmed. Open the deck to download the PDF.',
      'payment',
      '/app/?view=investor-decks'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.deck_export_from_payment() from public, anon, authenticated;

drop trigger if exists payments_deck_export on public.payments;
create trigger payments_deck_export
  after update on public.payments
  for each row execute function public.deck_export_from_payment();

-- ---------------------------------------------------------------------------
-- 3. Row-level security. Owners manage their decks. Investors read nothing
--    directly; they use investor_shared_decks().
-- ---------------------------------------------------------------------------
alter table public.investor_decks enable row level security;
alter table public.investor_deck_shares enable row level security;
alter table public.deck_exports enable row level security;

revoke all on public.investor_decks from anon, authenticated;
revoke all on public.investor_deck_shares from anon, authenticated;
revoke all on public.deck_exports from anon, authenticated;
grant select, insert, update, delete on public.investor_decks to authenticated;
grant select on public.investor_deck_shares to authenticated;
grant select on public.deck_exports to authenticated;

drop policy if exists investor_decks_owner_all on public.investor_decks;
create policy investor_decks_owner_all on public.investor_decks
  for all to authenticated
  using (owner_id = auth.uid() and public.is_account_type('owner'))
  with check (owner_id = auth.uid() and public.is_account_type('owner'));

drop policy if exists investor_deck_shares_owner_read on public.investor_deck_shares;
create policy investor_deck_shares_owner_read on public.investor_deck_shares
  for select to authenticated
  using (owner_id = auth.uid());

drop policy if exists investor_deck_shares_investor_read on public.investor_deck_shares;
create policy investor_deck_shares_investor_read on public.investor_deck_shares
  for select to authenticated
  using (investor_id = auth.uid());

drop policy if exists deck_exports_owner_read on public.deck_exports;
create policy deck_exports_owner_read on public.deck_exports
  for select to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Data an owner may put into a deck. Only the sections asked for are read,
--    and only from the caller's own business. The result is frozen into the
--    deck's slides; an investor never gets a live path back to this data.
-- ---------------------------------------------------------------------------
create or replace function public.deck_data_snapshot(p_sections text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  wanted text[] := coalesce(p_sections, '{}');
  result jsonb := '{}'::jsonb;
  biz_json jsonb;
  inv_json jsonb;
  sales_json jsonb;
begin
  if actor is null then raise exception 'Sign in to build a deck.' using errcode = '42501'; end if;
  if not public.is_account_type('owner') then
    raise exception 'Only business owners can build an investor deck.' using errcode = '42501';
  end if;
  if not (wanted <@ array['business', 'inventory', 'sales']::text[]) then
    raise exception 'Unknown data section.' using errcode = '22023';
  end if;

  if 'business' = any(wanted) then
    select jsonb_build_object(
             'name', b.name,
             'category', b.category,
             'location', b.location,
             'stage', b.stage,
             'description', b.description,
             'targetAudience', b.target_audience,
             'goals', b.goals
           )
      into biz_json
      from public.businesses b
     where b.owner_id = actor
     order by b.created_at desc
     limit 1;
    result := result || jsonb_build_object('business', coalesce(biz_json, 'null'::jsonb));
  end if;

  if 'inventory' = any(wanted) then
    select jsonb_build_object(
             'products', count(*),
             'unitsInStock', coalesce(sum(greatest(sp.stock, 0)), 0),
             'publishedOnWebsite', count(*) filter (where sp.website_published)
           )
      into inv_json
      from public.store_products sp
     where sp.owner_id = actor;
    result := result || jsonb_build_object('inventory', inv_json);
  end if;

  if 'sales' = any(wanted) then
    select coalesce(jsonb_agg(jsonb_build_object(
             'currency', s.currency,
             'orders', s.orders,
             'revenue', s.revenue
           ) order by s.currency), '[]'::jsonb)
      into sales_json
      from (
        select so.currency, count(*) as orders, coalesce(sum(so.total_amount), 0) as revenue
          from public.store_orders so
         where so.owner_id = actor
           and so.placed_at >= now() - interval '30 days'
         group by so.currency
      ) s;
    result := result || jsonb_build_object('sales', sales_json, 'salesWindowDays', 30);
  end if;

  return jsonb_build_object('generatedAt', now(), 'sections', result);
end;
$$;

revoke all on function public.deck_data_snapshot(text[]) from public, anon;
grant execute on function public.deck_data_snapshot(text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Sharing. The owner decides; the investor is told; either side can stop.
-- ---------------------------------------------------------------------------
create or replace function public.deck_share(p_deck uuid, p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  handle text := lower(btrim(coalesce(p_username, '')));
  deck public.investor_decks%rowtype;
  target public.profiles%rowtype;
  share_id uuid;
begin
  if actor is null then raise exception 'Sign in to share a deck.' using errcode = '42501'; end if;
  if not public.is_account_type('owner') then
    raise exception 'Only business owners can share a deck.' using errcode = '42501';
  end if;

  select * into deck from public.investor_decks where id = p_deck and owner_id = actor;
  if not found then raise exception 'That deck was not found.' using errcode = 'P0002'; end if;
  if deck.status <> 'ready' then
    raise exception 'Mark the deck ready (at least three slides) before you share it.' using errcode = '22023';
  end if;

  select * into target from public.profiles where username = handle;
  if not found or target.account_type <> 'investor' then
    raise exception 'No investor account has that handle. Ask them to join as an investor first.' using errcode = '22023';
  end if;

  insert into public.investor_deck_shares (deck_id, owner_id, investor_id)
  values (deck.id, actor, target.id)
  on conflict (deck_id, investor_id) do update set revoked_at = null, shared_at = now()
  returning id into share_id;

  insert into public.notifications (user_id, title, body, type, link)
  values (
    target.id,
    'A founder shared a deck with you',
    'Open Shared with me to read "' || deck.title || '".',
    'investor',
    '/app/?view=investor'
  );

  return jsonb_build_object('shareId', share_id, 'investor', target.username);
end;
$$;

revoke all on function public.deck_share(uuid, text) from public, anon;
grant execute on function public.deck_share(uuid, text) to authenticated, service_role;

create or replace function public.deck_unshare(p_share uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  update public.investor_deck_shares
     set revoked_at = now()
   where id = p_share and owner_id = actor and revoked_at is null;
  if not found then raise exception 'That share was not found.' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.deck_unshare(uuid) from public, anon;
grant execute on function public.deck_unshare(uuid) to authenticated, service_role;

create or replace function public.investor_remove_share(p_share uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  update public.investor_deck_shares
     set revoked_at = now()
   where id = p_share and investor_id = actor and revoked_at is null;
  if not found then raise exception 'That deck is not in your list.' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.investor_remove_share(uuid) from public, anon;
grant execute on function public.investor_remove_share(uuid) to authenticated, service_role;

/* What an investor can see: active shares of ready decks, with only the slides
   the owner put in. The owner's handle identifies who shared it. */
create or replace function public.investor_shared_decks()
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
           'shareId', s.id,
           'deckId', d.id,
           'title', d.title,
           'slides', d.slides,
           'sharedAt', s.shared_at,
           'sharedBy', p.username
         )
    from public.investor_deck_shares s
    join public.investor_decks d on d.id = s.deck_id
    join public.profiles p on p.id = s.owner_id
   where s.investor_id = auth.uid()
     and s.revoked_at is null
     and d.status = 'ready'
     and public.is_account_type('investor')
   order by s.shared_at desc;
$$;

revoke all on function public.investor_shared_decks() from public, anon;
grant execute on function public.investor_shared_decks() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Export entitlements. The Edge Function takes one before it renders a paid
--    PDF, and gives it back if rendering fails.
-- ---------------------------------------------------------------------------
create or replace function public.deck_export_take(p_deck uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  entitlement uuid;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not public.is_account_type('owner') then
    raise exception 'Only business owners can export a deck.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.investor_decks where id = p_deck and owner_id = actor) then
    raise exception 'That deck was not found.' using errcode = 'P0002';
  end if;

  select id into entitlement
    from public.deck_exports
   where owner_id = actor and used_at is null
   order by created_at
   limit 1
   for update skip locked;

  if entitlement is null then return null; end if;

  update public.deck_exports set used_at = now(), deck_id = p_deck where id = entitlement;
  return entitlement;
end;
$$;

revoke all on function public.deck_export_take(uuid) from public, anon;
grant execute on function public.deck_export_take(uuid) to authenticated, service_role;

create or replace function public.deck_export_release(p_export uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.deck_exports
     set used_at = null, deck_id = null
   where id = p_export and owner_id = auth.uid();
end;
$$;

revoke all on function public.deck_export_release(uuid) from public, anon;
grant execute on function public.deck_export_release(uuid) to authenticated, service_role;
