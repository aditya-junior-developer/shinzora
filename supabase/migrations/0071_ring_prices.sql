-- ============================================================================
-- 0071 — Ring prices: four premium designs at ₹20, the rest at ₹10
--
-- Each design now carries its own price. The Edge Function reads the price from
-- this table when it creates a ring order, so the browser never sets it.
--   premium (₹20): pink-gold, diamond-wings, tiger-gold, gothic-skull
--   standard (₹10): kuromi-neon, starlight-vine, sakura, thorn-rose
-- ring_orders.amount_paise must match one of the two prices.
-- ============================================================================

alter table public.ring_designs
  add column if not exists price_paise integer not null default 1000;

alter table public.ring_designs drop constraint if exists ring_designs_price_paise_check;
alter table public.ring_designs
  add constraint ring_designs_price_paise_check check (price_paise in (1000, 2000));

update public.ring_designs set price_paise = 2000
 where id in ('pink-gold', 'diamond-wings', 'tiger-gold', 'gothic-skull');
update public.ring_designs set price_paise = 1000
 where id in ('kuromi-neon', 'starlight-vine', 'sakura', 'thorn-rose');

alter table public.ring_orders drop constraint if exists ring_orders_amount_paise_check;
alter table public.ring_orders
  add constraint ring_orders_amount_paise_check check (amount_paise in (1000, 2000));

-- The browser can read the price with the design (no secret in it).
grant select (id, name, sort_order, active, price_paise) on public.ring_designs to anon, authenticated;
