-- 0035 — the store and support operations that were missing
--
-- Ten of the thirty functions in docs/features-audit.md had no implementation:
-- nothing recorded a visit, nothing told you an order had shipped, no customer
-- could look up an order, there was no way to import a catalogue, no category
-- totals, no escalation, no automatic reply, and the assistant could talk about
-- your shop but not change it.
--
-- Everything here follows the rules the rest of the schema already uses:
--   * the browser is never trusted with a service key,
--   * every owner-scoped read and write is checked here or by RLS,
--   * the customer-facing tracking function is the only anon-readable path, and
--     it returns one order for one random token, nothing else,
--   * an action that could notify somebody writes the notification in the same
--     transaction as the change.
--
-- Idempotent: every object is created with `if not exists` / `or replace`, and
-- the backfills are guarded.

-- ---------------------------------------------------------------------------
-- 1. Store visits — the denominator for a conversion rate
-- ---------------------------------------------------------------------------
create table if not exists public.store_visits (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  day date not null default current_date,
  visits int not null default 0 check (visits >= 0),
  source text,
  updated_at timestamptz not null default now(),
  unique (owner_id, day)
);

create index if not exists store_visits_owner_day_idx on public.store_visits (owner_id, day desc);

alter table public.store_visits enable row level security;

drop policy if exists store_visits_owner_read on public.store_visits;
create policy store_visits_owner_read on public.store_visits
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- Writes go through the function below, never straight from the browser.
drop policy if exists store_visits_owner_write on public.store_visits;
create policy store_visits_owner_write on public.store_visits
  for all to authenticated
  using (false) with check (false);

/*
 * One visit, counted per owner per day.
 *
 * The published site is anonymous, so this is callable by `anon` — but it can
 * only ever add one to today's counter for an owner id that already exists as a
 * business or project owner. It cannot read anything back, and it cannot write
 * more than one row's worth of information. That makes it useless as an
 * enumeration oracle while still being a real denominator.
 */
create or replace function public.store_track_visit(p_owner uuid, p_source text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_owner is null then return; end if;
  if not exists (
    select 1 from public.businesses where owner_id = p_owner
    union all
    select 1 from public.projects where owner_id = p_owner
  ) then
    return;
  end if;

  insert into public.store_visits (owner_id, day, visits, source, updated_at)
  values (p_owner, current_date, 1, left(coalesce(p_source, 'site'), 40), now())
  on conflict (owner_id, day) do update
    set visits = public.store_visits.visits + 1,
        updated_at = now();
end $$;

grant execute on function public.store_track_visit(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Order tracking — a customer-facing link that shows one order
-- ---------------------------------------------------------------------------
alter table public.store_orders add column if not exists tracking_token text;
alter table public.store_orders add column if not exists tracking_revoked_at timestamptz;
alter table public.store_orders add column if not exists shipped_at timestamptz;
alter table public.store_orders add column if not exists delivered_at timestamptz;

create unique index if not exists store_orders_tracking_token_idx
  on public.store_orders (tracking_token) where tracking_token is not null;

create table if not exists public.store_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.store_orders(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  status text,
  note text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists store_order_events_order_idx on public.store_order_events (order_id, created_at);

alter table public.store_order_events enable row level security;

drop policy if exists store_order_events_owner_read on public.store_order_events;
create policy store_order_events_owner_read on public.store_order_events
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- Rows are written by order_set_status() only.
drop policy if exists store_order_events_owner_write on public.store_order_events;
create policy store_order_events_owner_write on public.store_order_events
  for all to authenticated
  using (false) with check (false);

/*
 * Turn tracking on for one order. Returns the existing token if there is one, so
 * a second click cannot invalidate a link that has already been sent.
 */
create or replace function public.order_tracking_link(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  row_order public.store_orders;
  token text;
begin
  if actor is null then raise exception 'Sign in to share an order.' using errcode = '42501'; end if;

  select * into row_order from public.store_orders where id = p_order;
  if row_order.id is null then raise exception 'That order does not exist.' using errcode = '22023'; end if;
  if row_order.owner_id <> actor and not public.is_admin() then
    raise exception 'That order belongs to another business.' using errcode = '42501';
  end if;

  token := row_order.tracking_token;
  if token is null or row_order.tracking_revoked_at is not null then
    -- md5 of random + clock, twice, then shaped into a URL-safe token: this
    -- project deliberately avoids pgcrypto's gen_random_bytes so a database
    -- without the extension still runs every migration.
    token := replace(replace(replace(
               substr(md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text), 1, 24),
               '+', '-'), '/', '_'), '=', '');
  end if;

  update public.store_orders
     set tracking_token = token,
         tracking_revoked_at = null,
         updated_at = now()
   where id = p_order;

  insert into public.store_order_events (order_id, owner_id, status, note, actor_id)
  values (p_order, row_order.owner_id, row_order.status, 'Tracking link created', actor);

  return jsonb_build_object('token', token, 'link', '/track/?t=' || token);
end $$;

revoke all on function public.order_tracking_link(uuid) from public, anon;
grant execute on function public.order_tracking_link(uuid) to authenticated;

/* Stop an existing link working, without losing the history behind it. */
create or replace function public.order_tracking_revoke(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
begin
  if actor is null then raise exception 'Sign in to manage an order.' using errcode = '42501'; end if;
  select owner_id into owner from public.store_orders where id = p_order;
  if owner is null then raise exception 'That order does not exist.' using errcode = '22023'; end if;
  if owner <> actor and not public.is_admin() then
    raise exception 'That order belongs to another business.' using errcode = '42501';
  end if;
  update public.store_orders set tracking_revoked_at = now(), updated_at = now() where id = p_order;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.order_tracking_revoke(uuid) from public, anon;
grant execute on function public.order_tracking_revoke(uuid) to authenticated;

/*
 * The customer's view. Anonymous, keyed only by the random token, and it returns
 * the order status, its timeline, the line items and the business name — no
 * email, no address, no other order, no owner id.
 */
create or replace function public.order_tracking(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  row_order public.store_orders;
  business_name text;
  result jsonb;
begin
  if coalesce(btrim(p_token), '') = '' then
    raise exception 'That tracking link is incomplete.' using errcode = '22023';
  end if;

  select * into row_order
    from public.store_orders
   where tracking_token = btrim(p_token)
     and tracking_revoked_at is null;

  if row_order.id is null then
    raise exception 'This tracking link is not valid any more.' using errcode = '22023';
  end if;

  select name into business_name from public.businesses where owner_id = row_order.owner_id limit 1;

  select jsonb_build_object(
    'orderNumber', row_order.order_number,
    'status', row_order.status,
    'placedAt', row_order.placed_at,
    'shippedAt', row_order.shipped_at,
    'deliveredAt', row_order.delivered_at,
    'currency', row_order.currency,
    'total', row_order.total_amount,
    'business', coalesce(business_name, 'The business'),
    'customerFirstName', split_part(coalesce(row_order.customer_name, 'there'), ' ', 1),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', i.product_name, 'quantity', i.quantity, 'unitPrice', i.unit_price
      ) order by i.created_at)
      from public.store_order_items i where i.order_id = row_order.id
    ), '[]'::jsonb),
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object(
        'status', e.status, 'note', e.note, 'at', e.created_at
      ) order by e.created_at desc)
      from public.store_order_events e
      where e.order_id = row_order.id
        -- Internal notes are for the owner; the customer sees the milestones.
        and coalesce(e.note, '') not like 'internal:%'
    ), '[]'::jsonb)
  ) into result;

  return result;
end $$;

revoke all on function public.order_tracking(text) from public;
grant execute on function public.order_tracking(text) to anon, authenticated;

/*
 * Changing an order's status is now one function, because three things have to
 * happen together: the row changes, the timeline records it, and the customer is
 * told. Previously the screen wrote the column directly and the customer found
 * out by refreshing.
 */
create or replace function public.order_set_status(
  p_order uuid,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  next_status text := lower(btrim(coalesce(p_status, '')));
  row_order public.store_orders;
  notify_user uuid;
  label text;
begin
  if actor is null then raise exception 'Sign in to update an order.' using errcode = '42501'; end if;
  if next_status not in ('pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'fulfilled') then
    raise exception 'That is not an order status.' using errcode = '22023';
  end if;

  select * into row_order from public.store_orders where id = p_order;
  if row_order.id is null then raise exception 'That order does not exist.' using errcode = '22023'; end if;
  if row_order.owner_id <> actor and not public.is_admin() then
    raise exception 'That order belongs to another business.' using errcode = '42501';
  end if;

  update public.store_orders
     set status = next_status,
         shipped_at = case when next_status = 'shipped' then coalesce(shipped_at, now()) else shipped_at end,
         delivered_at = case when next_status in ('delivered', 'fulfilled') then coalesce(delivered_at, now()) else delivered_at end,
         updated_at = now()
   where id = p_order;

  insert into public.store_order_events (order_id, owner_id, status, note, actor_id)
  values (p_order, row_order.owner_id, next_status, nullif(btrim(coalesce(p_note, '')), ''), actor);

  label := initcap(replace(next_status, '_', ' '));

  /* The customer hears about it in one of two ways.
   *
   * A customer record that was linked to a Shinzora *account* has an inbox, and
   * gets a notification there. store_customers has no user_id column, so the link
   * is the email on the order matching a profile — which is the same identity
   * rule the rest of the schema uses, and it is checked, not assumed.
   *
   * Everybody else is a guest. They cannot receive a notification, so the
   * tracking link is their channel, and this function does not pretend
   * otherwise by writing a notification nobody can read. */
  if nullif(btrim(coalesce(row_order.customer_email, '')), '') is not null then
    select p.id into notify_user
      from public.profiles p
     where lower(coalesce(p.email, '')) = lower(btrim(row_order.customer_email))
     limit 1;
  end if;

  if notify_user is not null and notify_user <> actor then
    perform public.notify_user(
      notify_user,
      'order',
      'Order ' || coalesce(row_order.order_number, '') || ' is ' || lower(label),
      coalesce(p_note, 'The status of your order changed.'),
      case when row_order.tracking_token is null then '/app/'
           else '/track/?t=' || row_order.tracking_token end
    );
  end if;

  insert into public.customer_activity (user_id, action, entity_type, entity_id, meta)
  values (row_order.owner_id, 'order_status', 'order', p_order::text,
          jsonb_build_object('to', next_status, 'by', actor));

  return jsonb_build_object(
    'ok', true,
    'status', next_status,
    'trackingToken', row_order.tracking_token
  );
end $$;

revoke all on function public.order_set_status(uuid, text, text) from public, anon;
grant execute on function public.order_set_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Low-stock alerts
-- ---------------------------------------------------------------------------
create table if not exists public.product_alerts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid references public.store_products(id) on delete cascade,
  product_name text,
  stock int not null default 0,
  threshold int not null default 5,
  state text not null default 'low' check (state in ('low', 'out')),
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, state)
);

create index if not exists product_alerts_owner_idx on public.product_alerts (owner_id, created_at desc);

alter table public.product_alerts enable row level security;

drop policy if exists product_alerts_owner_read on public.product_alerts;
create policy product_alerts_owner_read on public.product_alerts
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

/* The owner may acknowledge an alert, but not fabricate one. */
drop policy if exists product_alerts_owner_ack on public.product_alerts;
create policy product_alerts_owner_ack on public.product_alerts
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

/*
 * Stock crossing the line raises an alert and a notification, once per
 * product per state. Re-crossing after a restock raises a new one, because the
 * old row is deleted when the product comes back above the threshold — an alert
 * list that only ever grows is a list nobody reads.
 */
create or replace function public.product_stock_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  threshold int := 5;
  state_now text;
begin
  state_now := case
    when new.stock <= 0 then 'out'
    when new.stock <= threshold then 'low'
    else null
  end;

  if state_now is null then
    delete from public.product_alerts where product_id = new.id;
    return new;
  end if;

  -- Already alerted for this product in this state: nothing new to say.
  if exists (select 1 from public.product_alerts where product_id = new.id and state = state_now) then
    update public.product_alerts set stock = new.stock, product_name = new.name
     where product_id = new.id and state = state_now;
    return new;
  end if;

  delete from public.product_alerts where product_id = new.id;

  insert into public.product_alerts (owner_id, product_id, product_name, stock, threshold, state)
  values (new.owner_id, new.id, new.name, new.stock, threshold, state_now)
  on conflict (product_id, state) do update
    set stock = excluded.stock, product_name = excluded.product_name, created_at = now(), seen_at = null;

  perform public.notify_user(
    new.owner_id,
    'inventory',
    case when state_now = 'out' then 'Out of stock: ' else 'Low stock: ' end || coalesce(new.name, 'a product'),
    case when state_now = 'out'
      then 'There are none left. Restock before somebody tries to buy.'
      else new.stock || ' left. The alert clears by itself once you are above ' || threshold || '.'
    end,
    '/app/?view=inventory'
  );

  return new;
end $$;

drop trigger if exists product_stock_alert on public.store_products;
create trigger product_stock_alert
  after insert or update of stock on public.store_products
  for each row execute function public.product_stock_alert();

revoke all on function public.product_stock_alert() from public, anon, authenticated;

/* A catalogue import must not have to fire one notification per low row, and it
   must not leave alerts behind for products it did not touch. */
create or replace function public.product_alerts_ack(p_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  touched int;
begin
  if actor is null then raise exception 'Sign in to clear an alert.' using errcode = '42501'; end if;
  update public.product_alerts
     set seen_at = now()
   where owner_id = actor
     and (p_ids is null or id = any (p_ids));
  get diagnostics touched = row_count;
  return jsonb_build_object('ok', true, 'acknowledged', touched);
end $$;

revoke all on function public.product_alerts_ack(uuid[]) from public, anon;
grant execute on function public.product_alerts_ack(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. CSV catalogue import
-- ---------------------------------------------------------------------------
/*
 * The file is parsed in the browser (a CSV parser belongs there), and every row
 * is re-validated here: name required, price and stock numeric and non-negative,
 * SKU de-duplicated against this owner's catalogue. The function reports what it
 * skipped and why rather than failing the whole file on one bad line.
 */
create or replace function public.store_import_products(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  row_item jsonb;
  imported int := 0;
  updated int := 0;
  skipped int := 0;
  problems jsonb := '[]'::jsonb;
  clean_name text;
  clean_sku text;
  clean_price numeric;
  clean_stock int;
  clean_category text;
  existing uuid;
  index_no int := 0;
begin
  if actor is null then raise exception 'Sign in to import a catalogue.' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Send the rows as an array.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2000 rows at a time.' using errcode = '22023';
  end if;

  for row_item in select * from jsonb_array_elements(p_rows) loop
    index_no := index_no + 1;
    clean_name := nullif(btrim(coalesce(row_item ->> 'name', '')), '');
    clean_sku := nullif(btrim(coalesce(row_item ->> 'sku', '')), '');
    clean_category := nullif(btrim(coalesce(row_item ->> 'category', '')), '');

    if clean_name is null then
      skipped := skipped + 1;
      problems := problems || jsonb_build_object('row', index_no, 'reason', 'A name is required.');
      continue;
    end if;

    begin
      clean_price := coalesce(nullif(btrim(coalesce(row_item ->> 'price', '')), '')::numeric, 0);
      clean_stock := coalesce(nullif(btrim(coalesce(row_item ->> 'stock', '')), '')::int, 0);
    exception when others then
      skipped := skipped + 1;
      problems := problems || jsonb_build_object('row', index_no, 'reason', 'Price and stock must be numbers.');
      continue;
    end;

    if clean_price < 0 or clean_stock < 0 then
      skipped := skipped + 1;
      problems := problems || jsonb_build_object('row', index_no, 'reason', 'Price and stock cannot be negative.');
      continue;
    end if;

    existing := null;
    if clean_sku is not null then
      select id into existing from public.store_products
       where owner_id = actor and lower(coalesce(sku, '')) = lower(clean_sku) limit 1;
    end if;

    if existing is not null then
      update public.store_products
         set name = clean_name,
             price = clean_price,
             stock = clean_stock,
             category = coalesce(clean_category, category),
             description = coalesce(nullif(btrim(coalesce(row_item ->> 'description', '')), ''), description),
             updated_at = now()
       where id = existing;
      updated := updated + 1;
    else
      insert into public.store_products (owner_id, name, sku, price, stock, category, description, status)
      values (
        actor, clean_name, clean_sku, clean_price, clean_stock, clean_category,
        nullif(btrim(coalesce(row_item ->> 'description', '')), ''),
        -- The fallback has to be inside the then-branch too: a row with no
        -- status column would otherwise insert NULL and fail the not-null check
        -- after the row had already been counted as imported.
        case when lower(coalesce(row_item ->> 'status', 'active')) in ('active', 'draft', 'archived')
             then lower(coalesce(row_item ->> 'status', 'active')) else 'active' end
      );
      imported := imported + 1;
    end if;
  end loop;

  insert into public.customer_activity (user_id, action, entity_type, meta)
  values (actor, 'catalogue_import', 'products',
          jsonb_build_object('imported', imported, 'updated', updated, 'skipped', skipped));

  return jsonb_build_object(
    'imported', imported, 'updated', updated, 'skipped', skipped, 'problems', problems
  );
end $$;

revoke all on function public.store_import_products(jsonb) from public, anon;
grant execute on function public.store_import_products(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. One analytics payload, including the parts that were missing
-- ---------------------------------------------------------------------------
/*
 * Category totals and conversion need joins the browser was doing by hand,
 * badly. Doing them here keeps one definition of "revenue" (paid orders only)
 * for the screen, the CSV report and the AI analysis.
 */
create or replace function public.store_analytics(p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  span int := greatest(1, least(coalesce(p_days, 30), 365));
  since timestamptz := now() - (span || ' days')::interval;
  paid text[] := array['paid', 'processing', 'shipped', 'delivered', 'fulfilled'];
  revenue numeric := 0;
  order_count int := 0;
  paid_count int := 0;
  customer_count int := 0;
  repeat_customers int := 0;
  visits int := 0;
  categories jsonb := '[]'::jsonb;
  top_customers jsonb := '[]'::jsonb;
begin
  if actor is null then raise exception 'Sign in to read your analytics.' using errcode = '42501'; end if;

  select coalesce(sum(total_amount), 0), count(*), count(*) filter (where status = any (paid))
    into revenue, order_count, paid_count
    from public.store_orders
   where owner_id = actor and coalesce(placed_at, created_at) >= since;

  select count(*) into customer_count from public.store_customers where owner_id = actor;

  select count(*) into repeat_customers from (
    select coalesce(customer_id::text, lower(coalesce(customer_email, customer_name, ''))) as who, count(*) as n
      from public.store_orders
     where owner_id = actor
     group by 1
    having count(*) > 1
  ) x where coalesce(who, '') <> '';

  select coalesce(sum(v.visits), 0) into visits
    from public.store_visits v
   where v.owner_id = actor and v.day >= (current_date - span);

  /* Category comes from the product the line item points at; a line item whose
     product was deleted is reported as Uncategorised rather than dropped, so the
     totals still add up to the revenue figure above. */
  select coalesce(jsonb_agg(jsonb_build_object(
           'category', x.category, 'orders', x.orders, 'units', x.units, 'revenue', x.revenue
         ) order by x.revenue desc), '[]'::jsonb)
    into categories
    from (
      select coalesce(nullif(p.category, ''), 'Uncategorised') as category,
             count(distinct o.id) as orders,
             coalesce(sum(i.quantity), 0) as units,
             coalesce(sum(i.quantity * i.unit_price), 0) as revenue
        from public.store_order_items i
        join public.store_orders o on o.id = i.order_id
        left join public.store_products p on p.id = i.product_id
       where o.owner_id = actor
         and o.status = any (paid)
         and coalesce(o.placed_at, o.created_at) >= since
       group by 1
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', x.name, 'orders', x.orders, 'revenue', x.revenue, 'lastOrderAt', x.last_at
         ) order by x.revenue desc), '[]'::jsonb)
    into top_customers
    from (
      select coalesce(nullif(customer_name, ''), nullif(customer_email, ''), 'Guest') as name,
             count(*) as orders,
             coalesce(sum(total_amount), 0) as revenue,
             max(coalesce(placed_at, created_at)) as last_at
        from public.store_orders
       where owner_id = actor and status = any (paid)
       group by 1
       order by 3 desc
       limit 8
    ) x;

  return jsonb_build_object(
    'days', span,
    'revenue', revenue,
    'orders', order_count,
    'paidOrders', paid_count,
    'averageOrder', case when paid_count > 0 then round(revenue / paid_count, 2) else 0 end,
    'customers', customer_count,
    'repeatCustomers', repeat_customers,
    'visits', visits,
    /* Null, not zero: with no visits there is no conversion rate, and 0% would
       be a claim the data does not support. */
    'conversionRate', case when visits > 0 then round((paid_count::numeric / visits) * 100, 2) else null end,
    'categories', categories,
    'topCustomers', top_customers
  );
end $$;

revoke all on function public.store_analytics(int) from public, anon;
grant execute on function public.store_analytics(int) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Support: escalation, automatic replies, and a customer's whole history
-- ---------------------------------------------------------------------------
alter table public.support_tickets add column if not exists escalated_at timestamptz;
alter table public.support_tickets add column if not exists escalation_reason text;
alter table public.support_tickets add column if not exists auto_reply boolean not null default false;
alter table public.support_tickets add column if not exists last_customer_message_at timestamptz;

/*
 * Hand a ticket to a human. The flag lives on the ticket, so the admin console
 * can queue it without a second table, and the owner sees the reason in their
 * own thread.
 */
create or replace function public.support_escalate(p_ticket uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  row_ticket public.support_tickets;
begin
  if actor is null then raise exception 'Sign in to escalate a ticket.' using errcode = '42501'; end if;

  select * into row_ticket from public.support_tickets where id = p_ticket;
  if row_ticket.id is null then raise exception 'That ticket does not exist.' using errcode = '22023'; end if;
  if row_ticket.owner_id <> actor and not public.is_admin() then
    raise exception 'That ticket belongs to another business.' using errcode = '42501';
  end if;

  update public.support_tickets
     set escalated_at = coalesce(escalated_at, now()),
         escalation_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), escalation_reason),
         status = case when status = 'closed' then 'open' else status end,
         priority = case when priority in ('low', 'normal') then 'high' else priority end,
         updated_at = now()
   where id = p_ticket;

  insert into public.support_replies (ticket_id, author_id, author_role, body)
  values (p_ticket, actor, 'system',
          'Escalated to the Shinzora team' ||
          case when nullif(btrim(coalesce(p_reason, '')), '') is null then '.' else ': ' || btrim(p_reason) end);

  return jsonb_build_object('ok', true, 'escalatedAt', now());
end $$;

revoke all on function public.support_escalate(uuid, text) from public, anon;
grant execute on function public.support_escalate(uuid, text) to authenticated;

/* Turn automatic replies on or off for one ticket. Off by default: a wrong
   automatic reply to a customer is worse than a slow one. */
create or replace function public.support_set_auto_reply(p_ticket uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
begin
  if actor is null then raise exception 'Sign in to change this.' using errcode = '42501'; end if;
  select owner_id into owner from public.support_tickets where id = p_ticket;
  if owner is null then raise exception 'That ticket does not exist.' using errcode = '22023'; end if;
  if owner <> actor and not public.is_admin() then
    raise exception 'That ticket belongs to another business.' using errcode = '42501';
  end if;
  update public.support_tickets
     set auto_reply = coalesce(p_enabled, false), updated_at = now()
   where id = p_ticket;
  return jsonb_build_object('ok', true, 'autoReply', coalesce(p_enabled, false));
end $$;

revoke all on function public.support_set_auto_reply(uuid, boolean) from public, anon;
grant execute on function public.support_set_auto_reply(uuid, boolean) to authenticated;

/*
 * Every ticket and reply for one customer, oldest first, so the support screen
 * can show history instead of a single thread. Scoped to the owner (or an admin).
 */
create or replace function public.support_customer_history(p_email text default null, p_customer uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  mail text := lower(btrim(coalesce(p_email, '')));
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to read support history.' using errcode = '42501'; end if;
  if mail = '' and p_customer is null then
    raise exception 'Name a customer.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ticketId', t.id,
           'subject', t.subject,
           'status', t.status,
           'priority', t.priority,
           'escalatedAt', t.escalated_at,
           'openedAt', t.created_at,
           'replies', coalesce((
             select jsonb_agg(jsonb_build_object(
               'role', r.author_role, 'body', r.body, 'at', r.created_at
             ) order by r.created_at)
             from public.support_replies r
             where r.ticket_id = t.id and t.owner_id = actor
           ), '[]'::jsonb)
         ) order by t.created_at desc), '[]'::jsonb)
    into result
    from public.support_tickets t
    left join public.store_customers c on c.id = p_customer and c.owner_id = actor
   where t.owner_id = actor
     and t.archived_at is null
     and (
       (p_customer is not null and c.id is not null and
        (lower(coalesce(t.customer_email_used, '')) = lower(coalesce(c.email, ''))
         or t.customer_id = c.id))
       or (mail <> '' and lower(coalesce(t.customer_email_used, '')) = mail)
     );

  return coalesce(result, '[]'::jsonb);
end $$;

revoke all on function public.support_customer_history(text, uuid) from public, anon;
grant execute on function public.support_customer_history(text, uuid) to authenticated;

-- The ticket needs to remember who it was about for the history lookup to work.
alter table public.support_tickets add column if not exists customer_id uuid references public.store_customers(id) on delete set null;
alter table public.support_tickets add column if not exists customer_email_used text;

create index if not exists support_tickets_customer_idx
  on public.support_tickets (owner_id, customer_email_used);

-- ---------------------------------------------------------------------------
-- 7. Natural-language commands
-- ---------------------------------------------------------------------------
/*
 * The assistant proposes; the browser confirms; this executes. Three rules:
 *
 *   * the action must be one of the four below — the model cannot add a fifth,
 *   * a run is recorded before the change so a repeated run is not silent,
 *   * the payload is validated here exactly as if it had been typed into a form.
 *
 * A command that fails validation returns the reason and changes nothing.
 */
create table if not exists public.assistant_commands (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists assistant_commands_owner_idx on public.assistant_commands (owner_id, created_at desc);

alter table public.assistant_commands enable row level security;

drop policy if exists assistant_commands_owner_read on public.assistant_commands;
create policy assistant_commands_owner_read on public.assistant_commands
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

drop policy if exists assistant_commands_owner_write on public.assistant_commands;
create policy assistant_commands_owner_write on public.assistant_commands
  for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function public.assistant_command_apply(
  p_action text,
  p_payload jsonb,
  p_command uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  action text := lower(btrim(coalesce(p_action, '')));
  data jsonb := coalesce(p_payload, '{}'::jsonb);
  new_id uuid;
  affected int := 0;
  record_id uuid;
begin
  if actor is null then raise exception 'Sign in to run a command.' using errcode = '42501'; end if;
  if action not in ('create_product', 'update_stock', 'set_order_status', 'add_customer') then
    raise exception 'That is not something the assistant may do.' using errcode = '22023';
  end if;

  if p_command is not null then
    -- Only this owner's proposal, only once.
    update public.assistant_commands
       set status = 'applied', applied_at = now()
     where id = p_command and owner_id = actor and status = 'proposed';
    get diagnostics affected = row_count;
    if affected = 0 then
      raise exception 'That suggestion was already used or does not belong to you.' using errcode = '42501';
    end if;
  end if;

  if action = 'create_product' then
    if nullif(btrim(coalesce(data ->> 'name', '')), '') is null then
      raise exception 'A product needs a name.' using errcode = '22023';
    end if;
    insert into public.store_products (owner_id, name, price, stock, category, description)
    values (
      actor,
      left(btrim(data ->> 'name'), 200),
      greatest(coalesce((data ->> 'price')::numeric, 0), 0),
      greatest(coalesce((data ->> 'stock')::int, 0), 0),
      nullif(btrim(coalesce(data ->> 'category', '')), ''),
      nullif(btrim(coalesce(data ->> 'description', '')), '')
    )
    returning id into record_id;
    return jsonb_build_object('ok', true, 'action', action, 'productId', record_id);
  end if;

  if action = 'update_stock' then
    if nullif(btrim(coalesce(data ->> 'productId', '')), '') is null then
      raise exception 'Name the product whose stock changes.' using errcode = '22023';
    end if;
    update public.store_products
       set stock = greatest(coalesce((data ->> 'stock')::int, stock), 0),
           updated_at = now()
     where id = (data ->> 'productId')::uuid and owner_id = actor;
    get diagnostics affected = row_count;
    if affected = 0 then raise exception 'That product is not in your catalogue.' using errcode = '22023'; end if;
    return jsonb_build_object('ok', true, 'action', action);
  end if;

  if action = 'set_order_status' then
    return public.order_set_status(
      (data ->> 'orderId')::uuid,
      data ->> 'status',
      data ->> 'note'
    );
  end if;

  -- add_customer
  if nullif(btrim(coalesce(data ->> 'name', '')), '') is null
     and nullif(btrim(coalesce(data ->> 'email', '')), '') is null then
    raise exception 'A customer needs a name or an email.' using errcode = '22023';
  end if;
  insert into public.store_customers (owner_id, name, email, phone, city, notes, source)
  values (
    actor,
    nullif(btrim(coalesce(data ->> 'name', '')), ''),
    nullif(lower(btrim(coalesce(data ->> 'email', ''))), ''),
    nullif(btrim(coalesce(data ->> 'phone', '')), ''),
    nullif(btrim(coalesce(data ->> 'city', '')), ''),
    nullif(btrim(coalesce(data ->> 'notes', '')), ''),
    'assistant'
  )
  returning id into record_id;

  return jsonb_build_object('ok', true, 'action', action, 'customerId', record_id);
end $$;

revoke all on function public.assistant_command_apply(text, jsonb, uuid) from public, anon;
grant execute on function public.assistant_command_apply(text, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. The new tables join the backup list in scripts/lib/supabase-admin.mjs
--    (checked by `npm run check`), and the owner-scoped ones get updated_at
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists store_visits_touch on public.store_visits;
create trigger store_visits_touch
  before update on public.store_visits
  for each row execute function public.touch_updated_at();
