-- ============================================================================
-- SHINZORA · 0003_storage_realtime.sql
-- ----------------------------------------------------------------------------
-- Storage buckets and Realtime publication. Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Buckets
--   avatars        public read, owner write
--   brand-assets   public read, owner write (logos, product images)
--   payment-proofs private — admin read only
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars',        'avatars',        true,  2097152, array['image/png','image/jpeg','image/webp']),
  ('brand-assets',   'brand-assets',   true,  5242880, array['image/png','image/jpeg','image/webp','image/svg+xml']),
  ('payment-proofs', 'payment-proofs', false, 5242880, array['image/png','image/jpeg','image/webp','application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies are stored in storage.objects and are not idempotent, so
-- each one is dropped before creation.
drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars owner write" on storage.objects;
create policy "avatars owner write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars owner update" on storage.objects;
create policy "avatars owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars owner delete" on storage.objects;
create policy "avatars owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "brand assets public read" on storage.objects;
create policy "brand assets public read" on storage.objects
  for select using (bucket_id = 'brand-assets');

drop policy if exists "brand assets owner write" on storage.objects;
create policy "brand assets owner write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'brand-assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "brand assets owner delete" on storage.objects;
create policy "brand assets owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'brand-assets' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "payment proofs owner insert" on storage.objects;
create policy "payment proofs owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'payment-proofs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "payment proofs admin read" on storage.objects;
create policy "payment proofs admin read" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and public.is_admin());

drop policy if exists "payment proofs owner read" on storage.objects;
create policy "payment proofs owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- Realtime — the notification badge and drawer subscribe to notifications.
-- Guarded so re-running does not raise "already member of publication".
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'projects'
  ) then
    alter publication supabase_realtime add table public.projects;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payments'
  ) then
    alter publication supabase_realtime add table public.payments;
  end if;
end;
$$;

-- Full row payloads so the client can render without a refetch.
alter table public.notifications replica identity full;
alter table public.payments replica identity full;
