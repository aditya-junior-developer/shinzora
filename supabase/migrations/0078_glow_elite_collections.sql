-- ============================================================================
-- 0078 — Glow and Elite wallpaper collections (replaces the 0059 collections)
--
-- What changes:
--   - The four 0059 collections (Anime, Ghibli-inspired, Cyberpunk, Trend 2026)
--     and their wallpapers are DEACTIVATED, never deleted. A member's saved
--     choice keeps pointing at an inactive wallpaper, so the catalog reports it
--     unavailable and the app shows the default background (the agreed fallback).
--   - Two collections replace them:
--       Glow  (required_tier 'glow')  — four designs from the supplied Glow pack
--       Elite (required_tier 'elite') — four designs from the supplied Elite pack
--     A higher tier covers a lower one (theme_tier_rank), so Elite also unlocks
--     Glow, and Glow alone does not unlock Elite.
--   - theme_catalog() now returns a preview address for every active wallpaper,
--     locked or not, so members can look at a locked theme. Previews do not
--     apply a theme: theme_set_wallpaper() still refuses any wallpaper the caller's
--     tier does not cover, and that check runs in the database.
--
-- The tiers themselves come from profile_entitlements (P6, 0054), which only the
-- admin function writes after a verified UPI payment. Nothing here changes that.
-- ============================================================================

-- 1. Retire the old collections and their wallpapers (rows kept).
update public.theme_wallpapers
   set active = false, updated_at = now()
 where active
   and collection_id not in ('glow', 'elite');

update public.theme_collections
   set active = false, updated_at = now()
 where active
   and id not in ('glow', 'elite');

-- 2. The two new collections.
insert into public.theme_collections (id, name, description, required_tier, active, sort_order)
values
  ('glow', 'Glow',
   'Four original dashboard designs. Included with the Glow profile (₹99, one-time).',
   'glow', true, 1),
  ('elite', 'Elite',
   'Four original dashboard designs. Included with the Elite profile (₹199, one-time), which also includes Glow.',
   'elite', true, 2)
on conflict (id) do update
  set name = excluded.name,
      description = excluded.description,
      required_tier = excluded.required_tier,
      active = true,
      sort_order = excluded.sort_order,
      updated_at = now();

-- 3. The eight wallpapers, each pointing at the artwork shipped in public/assets/themes/.
insert into public.theme_wallpapers (collection_id, title, image_url, active, sort_order)
select v.collection_id, v.title, v.image_url, true, v.sort_order
  from (values
    ('glow',  'Glow I · Glass home',       '/assets/themes/glow-01.jpg',  1),
    ('glow',  'Glow II · Smart home',      '/assets/themes/glow-02.jpg',  2),
    ('glow',  'Glow III · Stormy skies',   '/assets/themes/glow-03.jpg',  3),
    ('glow',  'Glow IV · Golden weather',  '/assets/themes/glow-04.jpg',  4),
    ('elite', 'Elite I · Violet analytics','/assets/themes/elite-01.jpg', 1),
    ('elite', 'Elite II · Ember games',    '/assets/themes/elite-02.jpg', 2),
    ('elite', 'Elite III · Amber finance', '/assets/themes/elite-03.jpg', 3),
    ('elite', 'Elite IV · Plum investing', '/assets/themes/elite-04.jpg', 4)
  ) as v(collection_id, title, image_url, sort_order)
 where not exists (
   select 1 from public.theme_wallpapers w where w.image_url = v.image_url
 );

-- 4. The catalog: previews for every active wallpaper. Locking is unchanged.
create or replace function public.theme_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_rank integer;
  v_chosen uuid;
  v_tier text;
  result jsonb;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  v_rank := public.theme_caller_rank();
  v_tier := case v_rank when 2 then 'elite' when 1 then 'glow' else null end;

  select wallpaper_id into v_chosen from public.profile_theme_choices where user_id = actor;

  select jsonb_build_object(
    'tier', v_tier,
    'chosenWallpaperId', v_chosen,
    'collections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'requiredTier', c.required_tier,
          'locked', c.required_tier is not null and public.theme_tier_rank(c.required_tier) > v_rank,
          'wallpapers', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', w.id,
                'title', w.title,
                'imageUrl', w.image_url,
                'previewOnly', c.required_tier is not null and public.theme_tier_rank(c.required_tier) > v_rank
              ) order by w.sort_order, w.title
            )
            from public.theme_wallpapers w
            where w.collection_id = c.id and w.active
          ), '[]'::jsonb)
        ) order by c.sort_order, c.name
      )
      from public.theme_collections c
      where c.active
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;
