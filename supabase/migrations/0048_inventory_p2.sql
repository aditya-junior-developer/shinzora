-- ============================================================================
-- SHINZORA · 0048_inventory_p2.sql
-- ----------------------------------------------------------------------------
-- Inventory, part 2:
--   • product images (brand-assets bucket, owner folder), per-product low-stock
--     threshold, optional SKU that is unique per owner when present
--   • low-stock alerts honour the threshold and can be resolved
--   • "Push to website": publish / unpublish one product. The quality gate is
--     enforced here in the database, not in the browser.
--   • public_store_products: the only thing an anonymous visitor can read, and
--     only for products the owner has published and set Active.
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Product columns
-- ---------------------------------------------------------------------------
alter table public.store_products
  add column if not exists image_urls text[] not null default '{}',
  add column if not exists low_stock_threshold int not null default 5,
  add column if not exists website_published boolean not null default false,
  add column if not exists website_slug text,
  add column if not exists website_published_at timestamptz,
  add column if not exists website_unpublished_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'store_products_threshold_nonneg') then
    alter table public.store_products
      add constraint store_products_threshold_nonneg check (low_stock_threshold >= 0);
  end if;
end $$;

/* SKU stays optional. When one is given it must be unique within the owner's
   catalogue, so an import or an edit cannot quietly create a second copy. */
create unique index if not exists store_products_owner_sku_uidx
  on public.store_products (owner_id, lower(btrim(sku)))
  where sku is not null and btrim(sku) <> '';

create unique index if not exists store_products_website_slug_uidx
  on public.store_products (website_slug)
  where website_slug is not null;

-- ---------------------------------------------------------------------------
-- 2. Alerts: threshold-aware, resolvable, still one per product and state
-- ---------------------------------------------------------------------------
alter table public.product_alerts
  add column if not exists resolved_at timestamptz;

create or replace function public.product_stock_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  limit_at int := coalesce(new.low_stock_threshold, 5);
  state_now text;
begin
  state_now := case
    when new.stock <= 0 then 'out'
    when new.stock <= limit_at then 'low'
    else null
  end;

  if state_now is null then
    -- Back above the threshold: the alert clears, and a later drop raises a new one.
    delete from public.product_alerts where product_id = new.id;
    return new;
  end if;

  -- Already alerted in this state: refresh the numbers only. A resolved alert
  -- stays resolved, and no second notification is sent for the same stock state.
  if exists (select 1 from public.product_alerts where product_id = new.id and state = state_now) then
    update public.product_alerts
       set stock = new.stock, product_name = new.name, threshold = limit_at
     where product_id = new.id and state = state_now;
    return new;
  end if;

  delete from public.product_alerts where product_id = new.id;

  insert into public.product_alerts (owner_id, product_id, product_name, stock, threshold, state)
  values (new.owner_id, new.id, new.name, new.stock, limit_at, state_now)
  on conflict (product_id, state) do update
    set stock = excluded.stock, product_name = excluded.product_name, threshold = excluded.threshold,
        created_at = now(), seen_at = null, resolved_at = null;

  perform public.notify_user(
    new.owner_id,
    'inventory',
    case when state_now = 'out' then 'Out of stock: ' else 'Low stock: ' end || coalesce(new.name, 'a product'),
    case when state_now = 'out'
      then 'There are none left. Restock before somebody tries to buy.'
      else new.stock || ' left. The alert clears by itself once you are above ' || limit_at || '.'
    end,
    '/app/?view=inventory'
  );

  return new;
end $$;

drop trigger if exists product_stock_alert on public.store_products;
create trigger product_stock_alert
  after insert or update of stock, low_stock_threshold on public.store_products
  for each row execute function public.product_stock_alert();

revoke all on function public.product_stock_alert() from public, anon, authenticated;

/* Resolve = "I have dealt with this". It stays in the history but leaves the
   open list. The product is still low, so it does not alert again until it
   recovers and drops once more. */
create or replace function public.product_alert_resolve(p_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  touched int;
begin
  if actor is null then raise exception 'Sign in to resolve an alert.' using errcode = '42501'; end if;
  update public.product_alerts
     set resolved_at = now(), seen_at = coalesce(seen_at, now())
   where owner_id = actor
     and resolved_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics touched = row_count;
  return jsonb_build_object('ok', true, 'resolved', touched);
end $$;

revoke all on function public.product_alert_resolve(uuid[]) from public, anon;
grant execute on function public.product_alert_resolve(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Push to website / unpublish (one product at a time)
-- ---------------------------------------------------------------------------
create or replace function public.product_set_website(p_product uuid, p_publish boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  item public.store_products;
  problems text[] := '{}';
  new_slug text;
begin
  if actor is null then raise exception 'Sign in to publish a product.' using errcode = '42501'; end if;

  select * into item from public.store_products where id = p_product and owner_id = actor for update;
  if not found then raise exception 'That product is not in your catalogue.' using errcode = '42501'; end if;

  if not coalesce(p_publish, false) then
    update public.store_products
       set website_published = false, website_unpublished_at = now(), updated_at = now()
     where id = item.id;
    return jsonb_build_object('ok', true, 'published', false);
  end if;

  /* Quality gate. Each reason is checked here so no client can publish a
     product that would show a broken or empty card. */
  if item.status <> 'active' then problems := array_append(problems, 'set the product to Active'); end if;
  if coalesce(btrim(item.name), '') = '' then problems := array_append(problems, 'give it a name'); end if;
  if item.price is null or item.price <= 0 then problems := array_append(problems, 'set a price above zero'); end if;
  if coalesce(array_length(item.image_urls, 1), 0) = 0 then problems := array_append(problems, 'add at least one image'); end if;

  if array_length(problems, 1) > 0 then
    raise exception 'Cannot publish yet: %.', array_to_string(problems, ', ') using errcode = '22023';
  end if;

  /* The slug is created once and kept, so a product keeps its address and a
     repeated push updates the same row instead of making a second page. */
  new_slug := coalesce(
    item.website_slug,
    left(regexp_replace(lower(item.name), '[^a-z0-9]+', '-', 'g'), 60) || '-' || left(item.id::text, 6)
  );
  new_slug := trim(both '-' from new_slug);

  update public.store_products
     set website_published = true,
         website_slug = new_slug,
         website_published_at = coalesce(item.website_published_at, now()),
         website_unpublished_at = null,
         updated_at = now()
   where id = item.id;

  return jsonb_build_object('ok', true, 'published', true, 'slug', new_slug);
end $$;

revoke all on function public.product_set_website(uuid, boolean) from public, anon;
grant execute on function public.product_set_website(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Public read: published, active products only, no internal columns
-- ---------------------------------------------------------------------------
create or replace view public.public_store_products as
select
  p.website_slug as slug,
  p.name,
  p.description,
  p.price,
  p.currency,
  (p.stock > 0) as in_stock,
  p.image_urls,
  p.category,
  p.website_published_at as published_at,
  p.updated_at
from public.store_products p
where p.website_published = true
  and p.status = 'active'
  and p.website_slug is not null;

grant select on public.public_store_products to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Storage: product images use brand-assets, owner folder (0003 policies).
--    Nothing to add here; the folder layout is <owner-id>/products/<file>.
-- ---------------------------------------------------------------------------
