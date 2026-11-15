-- ============================================================================
-- 0059 — Theme collections and wallpapers (P10)
--
-- Four collections of original wallpapers: Anime, Ghibli-inspired, Cyberpunk and
-- Trending 2026. Each collection needs a premium tier from P6 (glow or elite) or
-- none. There is no second payment system: a locked collection points to the
-- existing Billing page, where the P6 tiers are bought.
--
-- Rules enforced here, not in the browser:
--   - The browser never reads these tables directly. theme_catalog() shows a
--     locked collection without its image URLs, and theme_set_wallpaper() refuses
--     a wallpaper the caller's tier does not cover.
--   - Tiers come from profile_entitlements (0054), which only the admin function
--     writes. Elite includes Glow, so a higher tier always covers a lower one.
--   - Admins manage collections and wallpapers through the admin Edge Function
--     (service role). Rows are deactivated, never deleted, so a member's saved
--     choice survives a change of plan or artwork.
--   - A change of tier keeps the saved choice. The catalog then reports it as
--     locked and the app falls back to the default background.
-- ============================================================================

create table if not exists public.theme_collections (
  id text primary key check (id ~ '^[a-z][a-z0-9-]{1,40}$'),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  description text not null default '' check (char_length(description) <= 280),
  required_tier text check (required_tier in ('glow', 'elite')),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.theme_collections is
  'Wallpaper collections. required_tier null means every signed-in member may use it; otherwise the member needs that P6 tier or higher.';

create table if not exists public.theme_wallpapers (
  id uuid primary key default gen_random_uuid(),
  collection_id text not null references public.theme_collections(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 2 and 60),
  image_url text not null
    check (char_length(image_url) <= 500)
    check (image_url ~ '^/assets/themes/[a-z0-9._-]+$' or image_url ~ '^https://[^[:space:]]+$'),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists theme_wallpapers_collection_idx
  on public.theme_wallpapers (collection_id, active, sort_order);

create table if not exists public.profile_theme_choices (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wallpaper_id uuid references public.theme_wallpapers(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.theme_collections enable row level security;
alter table public.theme_wallpapers enable row level security;
alter table public.profile_theme_choices enable row level security;

-- No direct table access for the browser at all. Everything goes through the
-- functions below, which carry the tier check.
revoke all on public.theme_collections from anon, authenticated;
revoke all on public.theme_wallpapers from anon, authenticated;
revoke all on public.profile_theme_choices from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tier rank: a higher rank covers a lower one. Elite includes Glow.
-- ---------------------------------------------------------------------------
create or replace function public.theme_tier_rank(p_tier text)
returns integer
language sql
immutable
as $$
  select case p_tier when 'elite' then 2 when 'glow' then 1 else 0 end
$$;

create or replace function public.theme_caller_rank()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select public.theme_tier_rank(e.tier) from public.profile_entitlements e where e.user_id = auth.uid()),
    0
  )
$$;

revoke all on function public.theme_tier_rank(text) from public;
revoke all on function public.theme_caller_rank() from public, anon;
grant execute on function public.theme_caller_rank() to authenticated;

-- ---------------------------------------------------------------------------
-- The catalog. Locked collections show their name and tier, never their images.
-- ---------------------------------------------------------------------------
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
                'imageUrl', case
                  when c.required_tier is null or public.theme_tier_rank(c.required_tier) <= v_rank then w.image_url
                  else null
                end
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

-- ---------------------------------------------------------------------------
-- Choose a wallpaper. Refused when inactive, or when the caller's tier does not
-- cover the collection. The check runs here, with the caller's own entitlement.
-- ---------------------------------------------------------------------------
create or replace function public.theme_set_wallpaper(p_wallpaper uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_row record;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select w.id, w.active as wallpaper_active, c.active as collection_active, c.required_tier, w.collection_id
    into v_row
    from public.theme_wallpapers w
    join public.theme_collections c on c.id = w.collection_id
   where w.id = p_wallpaper;

  if not found or not v_row.wallpaper_active or not v_row.collection_active then
    raise exception 'That wallpaper is not available.' using errcode = 'P0002';
  end if;

  if v_row.required_tier is not null
     and public.theme_tier_rank(v_row.required_tier) > public.theme_caller_rank() then
    raise exception 'This collection is part of the % profile. Unlock it from Billing.', initcap(v_row.required_tier)
      using errcode = '42501';
  end if;

  insert into public.profile_theme_choices (user_id, wallpaper_id, updated_at)
  values (actor, p_wallpaper, now())
  on conflict (user_id) do update
    set wallpaper_id = excluded.wallpaper_id, updated_at = now();

  return jsonb_build_object('ok', true, 'wallpaperId', p_wallpaper, 'collectionId', v_row.collection_id);
end;
$$;

create or replace function public.theme_clear_wallpaper()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  delete from public.profile_theme_choices where user_id = auth.uid();
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.theme_catalog() from public, anon;
revoke all on function public.theme_set_wallpaper(uuid) from public, anon;
revoke all on function public.theme_clear_wallpaper() from public, anon;
grant execute on function public.theme_catalog() to authenticated;
grant execute on function public.theme_set_wallpaper(uuid) to authenticated;
grant execute on function public.theme_clear_wallpaper() to authenticated;

-- ---------------------------------------------------------------------------
-- Audit for theme changes. write_admin_audit() (0009) takes its actor from
-- auth.uid(), which is empty when the admin Edge Function writes with the service
-- role, so it would record no actor. This function takes the verified actor from
-- the function, re-checks that the actor is an administrator, and writes the same
-- row shape. Only the service role may call it.
-- ---------------------------------------------------------------------------
create or replace function public.theme_admin_audit(
  p_actor uuid,
  p_action text,
  p_target_table text,
  p_target_id uuid,
  p_reason text,
  p_before jsonb,
  p_after jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_role text;
  entry uuid;
begin
  select a.email, a.role into v_email, v_role
    from public.admin_users a
   where a.user_id = p_actor and a.role in ('admin', 'superadmin');

  if v_role is null then
    raise exception 'Only administrators can change themes.' using errcode = '42501';
  end if;

  insert into public.admin_audit (
    actor_id, actor_email, actor_role, action, target_table, target_id, reason, before, after
  )
  values (p_actor, v_email, v_role, p_action, p_target_table, p_target_id, p_reason, p_before, p_after)
  returning id into entry;

  return entry;
end;
$$;

revoke all on function public.theme_admin_audit(uuid, text, text, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.theme_admin_audit(uuid, text, text, uuid, text, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Seed: four collections and two original wallpapers each. Owners may change
-- tiers and artwork later in the admin panel. Tiers are proposals, subject to
-- business review.
-- ---------------------------------------------------------------------------
insert into public.theme_collections (id, name, description, required_tier, sort_order) values
  ('anime', 'Anime', 'Bright skies, petal drift and speed-line energy. Original artwork.', 'glow', 10),
  ('ghibli-inspired', 'Ghibli-inspired', 'Soft hills, pastel skies and slow clouds, painted in an original hand-drawn style.', 'glow', 20),
  ('cyberpunk', 'Cyberpunk', 'Neon grids, rain-lit towers and magenta against cyan. Original artwork.', 'elite', 30),
  ('trending-2026', 'Trending 2026', 'This year''s soft gradients, glass shapes and quiet type frames. Original artwork.', 'elite', 40)
on conflict (id) do nothing;

insert into public.theme_wallpapers (collection_id, title, image_url, sort_order)
select v.collection_id, v.title, v.image_url, v.sort_order
  from (values
    ('anime', 'Petal sky', '/assets/themes/anime-petal-sky.svg', 10),
    ('anime', 'Speed lines', '/assets/themes/anime-speed-lines.svg', 20),
    ('ghibli-inspired', 'Meadow wind', '/assets/themes/ghibli-meadow-wind.svg', 10),
    ('ghibli-inspired', 'Lantern hills', '/assets/themes/ghibli-lantern-hills.svg', 20),
    ('cyberpunk', 'Neon grid', '/assets/themes/cyber-neon-grid.svg', 10),
    ('cyberpunk', 'Rain towers', '/assets/themes/cyber-rain-towers.svg', 20),
    ('trending-2026', 'Glass mesh', '/assets/themes/trend-glass-mesh.svg', 10),
    ('trending-2026', 'Quiet gradient', '/assets/themes/trend-quiet-gradient.svg', 20)
  ) as v(collection_id, title, image_url, sort_order)
 where not exists (
   select 1 from public.theme_wallpapers w where w.image_url = v.image_url
 );
