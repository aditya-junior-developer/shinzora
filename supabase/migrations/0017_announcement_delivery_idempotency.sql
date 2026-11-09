-- 0017 · Idempotent announcements and exactly-once notification fan-out.
-- The Edge Function supplies one UUID per user submission. A retry reuses the
-- same announcement and never duplicates notification delivery.

alter table public.admin_announcements
  add column if not exists request_key uuid;

create unique index if not exists admin_announcements_request_key_unique
  on public.admin_announcements (request_key)
  where request_key is not null;

create or replace function public.admin_create_announcement(
  p_admin_id uuid,
  p_title text,
  p_body text,
  p_audience text,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  made public.admin_announcements%rowtype;
  created_now boolean := false;
  delivered_count integer := 0;
  audience_key text := coalesce(nullif(btrim(p_audience), ''), 'all');
begin
  if p_admin_id is null or p_request_key is null then
    raise exception 'An administrator and idempotency key are required.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 3 and 160
     or char_length(btrim(coalesce(p_body, ''))) not between 5 and 4000 then
    raise exception 'Announcement title or message is invalid.' using errcode = '22023';
  end if;
  if audience_key not in ('all', 'customers', 'free', 'pro', 'enterprise')
     and audience_key !~ '^user:[0-9a-fA-F-]{36}$' then
    raise exception 'Announcement audience is invalid.' using errcode = '22023';
  end if;

  insert into public.admin_announcements
    (title, body, audience, created_by, request_key, published_at)
  values
    (btrim(p_title), btrim(p_body), audience_key, p_admin_id, p_request_key, now())
  on conflict (request_key) where request_key is not null do nothing
  returning * into made;

  if found then
    created_now := true;
  else
    select * into made
      from public.admin_announcements
     where request_key = p_request_key
     for update;
    if made.id is null then
      raise exception 'Announcement could not be created.' using errcode = '40001';
    end if;
  end if;

  if created_now then
    -- DISTINCT is intentional: profile/plan joins must never send duplicates.
    with recipients as (
      select distinct p.id as user_id
        from public.profiles p
        left join public.subscriptions s on s.user_id = p.id
       where case
         when audience_key = 'all' then true
         when audience_key = 'customers' then true
         when audience_key in ('free', 'pro', 'enterprise') then s.plan = audience_key
         when audience_key like 'user:%' then p.id = split_part(audience_key, ':', 2)::uuid
         else false
       end
    )
    insert into public.notifications (user_id, title, body, type, link, meta)
    select r.user_id,
           made.title,
           made.body,
           'admin',
           '/app/?view=notifications',
           jsonb_build_object('announcement_id', made.id, 'audience', audience_key)
      from recipients r
     order by r.user_id;
    get diagnostics delivered_count = row_count;
  else
    select count(*)::integer into delivered_count
      from public.notifications n
     where n.meta->>'announcement_id' = made.id::text;
  end if;

  return jsonb_build_object(
    'announcement', to_jsonb(made),
    'delivered', delivered_count,
    'duplicate_request', not created_now
  );
end;
$$;

revoke all on function public.admin_create_announcement(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_create_announcement(uuid, text, text, text, uuid) to service_role;
