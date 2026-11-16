-- ============================================================================
-- 0070 — Correct two ring design ids to match the artwork
--
-- 0069 seeded placeholder ids. Two of them did not describe the art:
--   neon-crescent -> kuromi-neon      (the pink neon ring with the Kuromi figure)
--   neon-blossom  -> starlight-vine   (the white flower wreath with stars)
-- The foreign keys are recreated with ON UPDATE CASCADE so the renames carry
-- through any existing orders and choices. No member has ordered a ring yet.
-- ============================================================================

alter table public.ring_orders drop constraint if exists ring_orders_ring_id_fkey;
alter table public.profile_ring_choices drop constraint if exists profile_ring_choices_ring_id_fkey;

update public.ring_designs set id = 'kuromi-neon', name = 'Kuromi neon' where id = 'neon-crescent';
update public.ring_designs set id = 'starlight-vine', name = 'Starlight vine' where id = 'neon-blossom';

alter table public.ring_orders
  add constraint ring_orders_ring_id_fkey foreign key (ring_id)
  references public.ring_designs (id) on update cascade;
alter table public.profile_ring_choices
  add constraint profile_ring_choices_ring_id_fkey foreign key (ring_id)
  references public.ring_designs (id) on update cascade;
