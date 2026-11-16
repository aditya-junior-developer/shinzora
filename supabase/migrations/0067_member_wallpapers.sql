-- ============================================================================
-- 0067 — Member wallpapers: a private PNG or GIF for Glow and Elite (R7)
--
-- A Glow or Elite member may upload their own PNG or GIF as a wallpaper. Only
-- that member can see it. Free members see the upload control locked.
--
-- Rules enforced here, not in the browser:
--   - Storage: the bucket is private, accepts PNG and GIF only, and is capped at
--     5 MB. An insert needs a Glow or Elite tier and a path in the caller's own
--     folder. Read and delete are limited to the caller's own folder.
--   - member_wallpaper_register() checks the stored object's real size and type
--     (from storage metadata), not what the browser claimed, and refuses an
--     object outside the caller's folder or over the count limit.
--   - Every function checks the tier itself. Use and register need Glow or Elite.
--     Delete does not, so a member can always remove their own files.
--   - Uploads are never listed to anyone else. The table has no browser grants.
--   - A saved upload and a catalogue wallpaper are exclusive: choosing one
--     clears the other.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The private bucket. Limits here match config/member-wallpaper.js.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('member-wallpapers', 'member-wallpapers', false, 5242880, array['image/png', 'image/gif'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies. Each one is named, so a re-run replaces it cleanly.
drop policy if exists member_wallpapers_insert_own on storage.objects;
create policy member_wallpapers_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'member-wallpapers'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.theme_caller_rank() >= 1
  );

drop policy if exists member_wallpapers_read_own on storage.objects;
create policy member_wallpapers_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'member-wallpapers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists member_wallpapers_delete_own on storage.objects;
create policy member_wallpapers_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'member-wallpapers'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- One row per uploaded wallpaper. Written only by the functions below.
-- ---------------------------------------------------------------------------
create table if not exists public.member_wallpapers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique
    check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|gif)$'),
  mime_type text not null check (mime_type in ('image/png', 'image/gif')),
  byte_size integer not null check (byte_size between 1 and 5242880),
  created_at timestamptz not null default now()
);

create index if not exists member_wallpapers_owner_idx
  on public.member_wallpapers (owner_id, created_at);

alter table public.member_wallpapers enable row level security;
revoke all on public.member_wallpapers from anon, authenticated;

alter table public.profile_theme_choices
  add column if not exists member_wallpaper_id uuid references public.member_wallpapers(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Register an object the browser has just uploaded.
-- ---------------------------------------------------------------------------
create or replace function public.member_wallpaper_register(p_path text)
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  actor uuid := auth.uid();
  v_obj record;
  v_size bigint;
  v_mime text;
  v_id uuid;
  v_count integer;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if public.theme_caller_rank() < 1 then
    raise exception 'Your own wallpapers come with a Glow or Elite profile. Unlock it from Billing.'
      using errcode = '42501';
  end if;
  if p_path is null or split_part(p_path, '/', 1) <> actor::text then
    raise exception 'That file is not in your folder.' using errcode = '42501';
  end if;

  select o.metadata into v_obj
    from storage.objects o
   where o.bucket_id = 'member-wallpapers' and o.name = p_path;
  if not found then
    raise exception 'The upload is not there. Try again.' using errcode = 'P0002';
  end if;

  /* A refusal here does not remove the stored file: a raised error rolls back
     any delete made in the same call. The browser removes the rejected file
     itself, and the bucket limits (5 MB, PNG and GIF) stop most of these first. */
  v_size := coalesce((v_obj.metadata->>'size')::bigint, 0);
  v_mime := coalesce(v_obj.metadata->>'mimetype', '');
  if v_size < 1 or v_size > 5242880 then
    raise exception 'A wallpaper can be at most 5 MB.' using errcode = '22001';
  end if;
  if v_mime not in ('image/png', 'image/gif') then
    raise exception 'Only PNG and GIF files can be used as wallpapers.' using errcode = '22023';
  end if;

  select count(*) into v_count from public.member_wallpapers where owner_id = actor;
  if v_count >= 5 then
    raise exception 'You can keep 5 uploaded wallpapers. Remove one to add another.' using errcode = '53400';
  end if;

  insert into public.member_wallpapers (owner_id, storage_path, mime_type, byte_size)
  values (actor, p_path, v_mime, v_size)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'path', p_path);
end;
$$;

-- ---------------------------------------------------------------------------
-- What the Settings page needs: the caller's uploads and which one is in use.
-- chosenPath is only given while the caller still holds Glow or Elite.
-- ---------------------------------------------------------------------------
create or replace function public.member_wallpaper_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_ok boolean;
  v_chosen uuid;
  v_path text;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  v_ok := public.theme_caller_rank() >= 1;

  select pc.member_wallpaper_id into v_chosen
    from public.profile_theme_choices pc
   where pc.user_id = actor;

  if v_chosen is not null then
    select w.storage_path into v_path
      from public.member_wallpapers w
     where w.id = v_chosen and w.owner_id = actor;
  end if;

  return jsonb_build_object(
    'tierOk', v_ok,
    'limit', 5,
    'chosenId', v_chosen,
    'chosenPath', case when v_ok then v_path else null end,
    'uploads', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id,
               'path', w.storage_path,
               'mimeType', w.mime_type,
               'byteSize', w.byte_size,
               'createdAt', w.created_at,
               'chosen', w.id = v_chosen
             ) order by w.created_at)
        from public.member_wallpapers w
       where w.owner_id = actor
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Use one of your uploads. Clears any catalogue choice, so only one is in use.
-- ---------------------------------------------------------------------------
create or replace function public.member_wallpaper_use(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if public.theme_caller_rank() < 1 then
    raise exception 'Your own wallpapers come with a Glow or Elite profile. Unlock it from Billing.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.member_wallpapers w where w.id = p_id and w.owner_id = actor) then
    raise exception 'That wallpaper is not yours.' using errcode = 'P0002';
  end if;

  insert into public.profile_theme_choices (user_id, wallpaper_id, member_wallpaper_id, updated_at)
  values (actor, null, p_id, now())
  on conflict (user_id) do update
    set wallpaper_id = null, member_wallpaper_id = excluded.member_wallpaper_id, updated_at = now();

  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Remove one of your uploads. The browser then removes the stored file.
-- No tier check: a member can always delete their own file.
-- ---------------------------------------------------------------------------
create or replace function public.member_wallpaper_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_path text;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select w.storage_path into v_path
    from public.member_wallpapers w
   where w.id = p_id and w.owner_id = actor;
  if not found then
    raise exception 'That wallpaper is not yours.' using errcode = 'P0002';
  end if;

  update public.profile_theme_choices
     set member_wallpaper_id = null, updated_at = now()
   where user_id = actor and member_wallpaper_id = p_id;

  delete from public.member_wallpapers where id = p_id and owner_id = actor;

  return jsonb_build_object('ok', true, 'path', v_path);
end;
$$;

-- ---------------------------------------------------------------------------
-- Catalogue choice now clears an upload, so the two never disagree.
-- Same behaviour as 0059 otherwise.
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

  insert into public.profile_theme_choices (user_id, wallpaper_id, member_wallpaper_id, updated_at)
  values (actor, p_wallpaper, null, now())
  on conflict (user_id) do update
    set wallpaper_id = excluded.wallpaper_id, member_wallpaper_id = null, updated_at = now();

  return jsonb_build_object('ok', true, 'wallpaperId', p_wallpaper, 'collectionId', v_row.collection_id);
end;
$$;

revoke all on function public.member_wallpaper_register(text) from public, anon;
revoke all on function public.member_wallpaper_state() from public, anon;
revoke all on function public.member_wallpaper_use(uuid) from public, anon;
revoke all on function public.member_wallpaper_delete(uuid) from public, anon;
grant execute on function public.member_wallpaper_register(text) to authenticated;
grant execute on function public.member_wallpaper_state() to authenticated;
grant execute on function public.member_wallpaper_use(uuid) to authenticated;
grant execute on function public.member_wallpaper_delete(uuid) to authenticated;
