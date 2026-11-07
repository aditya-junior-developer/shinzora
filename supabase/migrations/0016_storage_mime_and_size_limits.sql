-- ============================================================================
-- 0016 · Storage: raster images only, with a size ceiling
-- ----------------------------------------------------------------------------
-- Found by uploading to the live buckets rather than reading the policies.
-- `brand-assets` accepted `image/svg+xml` with an owner token: an SVG is a
-- document that can carry script and external references, and these buckets are
-- served from the project origin. A "logo" upload must not be a script host.
--
-- The buckets only constrained mime type by bucket *name*; none of them declared
-- `allowed_mime_types`, so Storage accepted whatever the client claimed. This
-- pins the list, and adds a per-bucket size ceiling so a 200 MB "logo" is
-- refused at the edge instead of landing in the account's folder.
--
-- Storage policies (who may write to which folder) are unchanged: a user may
-- only write under `<auth.uid()>/…`, which is already enforced and confirmed.
-- ============================================================================

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
       file_size_limit = 5 * 1024 * 1024
 where id in ('avatars', 'brand-assets', 'product-images');

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
       file_size_limit = 10 * 1024 * 1024
 where id = 'payment-proofs';

update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4'],
       file_size_limit = 20 * 1024 * 1024
 where id = 'marketing-assets';

-- Invariant: no public bucket may advertise a mime list that includes a file
-- format capable of carrying script.
do $$
declare
  offending text;
begin
  select string_agg(id, ', ') into offending
    from storage.buckets
   where id in ('avatars', 'brand-assets', 'product-images', 'payment-proofs', 'marketing-assets')
     and (allowed_mime_types is null or 'image/svg+xml' = any (allowed_mime_types));
  if offending is not null then
    raise exception '0016 invariant: these buckets still accept unchecked or SVG uploads: %', offending;
  end if;
end $$;
