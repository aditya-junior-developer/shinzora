-- ============================================================================
-- 0039 · Group attachments, and the permissions real-time calls need
-- ----------------------------------------------------------------------------
-- Two additions, both of them database-enforced:
--
--   1. A group message may carry up to five files. The public Community rooms
--      stay text-only — that was a deliberate decision in 0024 and this
--      migration does not quietly reverse it.
--   2. Calls (voice in a direct conversation, video in a group) signal over
--      Supabase Realtime *private* channels. A private channel is only readable
--      and writable by a caller that a policy on `realtime.messages` allows, so
--      a non-member cannot listen to a group's call or inject an offer into it.
--      The media itself is peer-to-peer WebRTC and never touches the database.
-- ============================================================================

/* ---------------------------------------------------------------------------
-- 0. A cast that cannot explode
-- ---------------------------------------------------------------------------
-- Policies below turn part of a storage path or a realtime topic into a uuid.
-- A plain `::uuid` raises on anything else, and a raise inside a policy makes an
-- unrelated channel look broken to everyone in the project. This returns null.
*/
create or replace function public.safe_uuid(p_value text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p_value::uuid;
exception when others then
  return null;
end $$;

revoke all on function public.safe_uuid(text) from public, anon;
grant execute on function public.safe_uuid(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Attachments on a message
-- ---------------------------------------------------------------------------
alter table public.community_messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'community_messages_attachments_array'
      and conrelid = 'public.community_messages'::regclass
  ) then
    alter table public.community_messages
      add constraint community_messages_attachments_array
      check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 5);
  end if;
end $$;

/* The old rule required at least one character of body, which made "send just a
   picture" impossible. A message now needs *something*: text, or a file — and a
   public channel still needs text, because those rooms are text-only. */
alter table public.community_messages drop constraint if exists community_messages_body_check;
alter table public.community_messages
  add constraint community_messages_body_check check (
    char_length(btrim(body)) <= 4000
    and (
      char_length(btrim(body)) >= 1
      or (group_id is not null and jsonb_array_length(attachments) > 0)
    )
  );

/* Files live in their own private bucket. The path is
   `<group id>/<uploader id>/<uuid>-<name>`, so the policies below can read the
   group and the uploader straight out of the object name — no join table to
   keep in sync, and no way to file a group's upload under somebody else. */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'group-chat-files', 'group-chat-files', false, 20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "group files members read" on storage.objects;
create policy "group files members read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'group-chat-files'
    and public.group_is_member(public.safe_uuid((storage.foldername(name))[1]), auth.uid())
  );

drop policy if exists "group files own upload" on storage.objects;
create policy "group files own upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'group-chat-files'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.group_is_member(public.safe_uuid((storage.foldername(name))[1]), auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 2. send: text, files, or both
-- ---------------------------------------------------------------------------
-- The old two-argument function is dropped rather than left beside the new one,
-- because a call with two arguments would keep resolving to it and silently
-- discard the files.
drop function if exists public.group_send(uuid, text);

create or replace function public.group_send(
  p_group uuid,
  p_body text,
  p_attachments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  clean text := left(coalesce(p_body, ''), 4000);
  files jsonb := coalesce(p_attachments, '[]'::jsonb);
  attachment_count int := 0;
  item jsonb;
  preview text;
  my_role text;
  group_row public.community_groups;
  actor_name text;
  new_message_id uuid;
  handles text[];
  handle text;
  person record;
  wants_everyone boolean := false;
  everyone_allowed boolean := false;
  notified int := 0;
  suppressed int := 0;
begin
  if actor is null then raise exception 'Sign in to post.' using errcode = '42501'; end if;
  my_role := public.group_role_of(p_group, actor);
  if my_role is null then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;
  if jsonb_typeof(files) <> 'array' then
    raise exception 'Attachments must be a list.' using errcode = '22023';
  end if;
  attachment_count := jsonb_array_length(files);
  if attachment_count > 5 then
    raise exception 'Five files at most in one message.' using errcode = '22023';
  end if;

  if char_length(btrim(clean)) = 0 and attachment_count = 0 then
    raise exception 'Write something or attach a file.' using errcode = '22023';
  end if;

  /* Every attachment is checked here, not in the browser: the object must live
     under this group's own folder, be one of the allowed types, and be small
     enough to exist. A forged path cannot aim a message at another group. */
  for item in select * from jsonb_array_elements(files) loop
    if coalesce(item->>'path', '') = '' or coalesce(item->>'name', '') = '' then
      raise exception 'An attachment is missing its file path or name.' using errcode = '22023';
    end if;
    if item->>'path' not like (p_group::text || '/%') then
      raise exception 'That file does not belong to this group.' using errcode = '42501';
    end if;
    if coalesce(item->>'mime', '') not in (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'
    ) then
      raise exception 'Attach a JPEG, PNG, WebP, GIF or PDF.' using errcode = '22023';
    end if;
    if coalesce((item->>'size')::bigint, 0) < 1 or (item->>'size')::bigint > 20971520 then
      raise exception 'Each file must be under 20 MB.' using errcode = '22023';
    end if;
  end loop;

  /* What a notification says when there is no first line of text to quote. */
  preview := left(
    coalesce(
      nullif(split_part(clean, E'\n', 1), ''),
      case when attachment_count > 1 then attachment_count || ' files' else 'Attachment' end
    ),
    160
  );

  select * into group_row from public.community_groups g where g.id = p_group;
  select coalesce(nullif(full_name, ''), username, 'Someone') into actor_name
    from public.profiles where id = actor;

  /* Which mentions does the text contain? Case-insensitive, letters/digits/._ */
  handles := array(
    select distinct lower(m[1])
    from regexp_matches(clean, '@([a-zA-Z0-9_.]{2,30})', 'g') as m
  );

  wants_everyone := exists (
    select 1 from unnest(handles) h where h in ('everyone', 'all')
  );

  if wants_everyone then
    everyone_allowed := group_row.allow_everyone_mentions
      and (not group_row.everyone_mentions_admins or my_role in ('owner', 'admin'));
    if not everyone_allowed then
      raise exception 'Mass mentions are not allowed in this group.' using errcode = '42501';
    end if;
  end if;

  insert into public.community_messages (group_id, author_id, body, attachments)
  values (p_group, actor, clean, files)
  returning id into new_message_id;

  /* Real members only: the join is on this group's membership rows. */
  if array_length(handles, 1) > 0 then
    for person in
      select m.user_id, m.muted, pr.username
      from public.community_group_members m
      join public.profiles pr on pr.id = m.user_id
      where m.group_id = p_group
        and m.user_id <> actor
        and lower(pr.username) = any (handles)
    loop
      insert into public.community_mentions (message_id, group_id, mentioned_user, kind)
      values (new_message_id, p_group, person.user_id, 'user')
      on conflict (message_id, mentioned_user) do nothing;
      get diagnostics notified = row_count;
      if notified > 0 then
        perform public.notify_user(
          person.user_id, 'group_mention',
          actor_name || ' mentioned you in ' || left(group_row.name, 60),
          preview,
          '/app/?view=messages&group=' || p_group::text || '&message=' || new_message_id::text,
          jsonb_build_object(
            'groupId', p_group, 'messageId', new_message_id,
            'groupName', group_row.name, 'senderName', actor_name,
            'senderId', actor, 'kind', 'mention'
          )
        );
      end if;
    end loop;
  end if;

  /* @everyone is stored as one row per member so that the same unique index
     makes it idempotent, and so the UI can mark the message as a mass mention. */
  if wants_everyone then
    for person in
      select m.user_id, m.muted
      from public.community_group_members m
      where m.group_id = p_group and m.user_id <> actor
    loop
      insert into public.community_mentions (message_id, group_id, mentioned_user, kind)
      values (new_message_id, p_group, person.user_id, 'everyone')
      on conflict (message_id, mentioned_user) do nothing;
      get diagnostics notified = row_count;
      if notified > 0 then
        perform public.notify_user(
          person.user_id, 'group_mention',
          actor_name || ' mentioned @everyone in ' || left(group_row.name, 60),
          preview,
          '/app/?view=messages&group=' || p_group::text || '&message=' || new_message_id::text,
          jsonb_build_object(
            'groupId', p_group, 'messageId', new_message_id,
            'groupName', group_row.name, 'senderName', actor_name,
            'senderId', actor, 'kind', 'everyone'
          )
        );
      end if;
    end loop;
  end if;

  /* Ordinary message notifications, for members who have not muted the group and
     who were not already told about a mention in this same message. */
  for person in
    select m.user_id
    from public.community_group_members m
    left join public.notification_preferences pref on pref.user_id = m.user_id
    where m.group_id = p_group
      and m.user_id <> actor
      and m.muted = false
      and coalesce(pref.group_messages, true)
      and not exists (
        select 1 from public.community_mentions cm
        where cm.message_id = new_message_id and cm.mentioned_user = m.user_id
      )
  loop
    perform public.notify_user(
      person.user_id, 'group',
      actor_name || ' in ' || left(group_row.name, 60),
      preview,
      '/app/?view=messages&group=' || p_group::text || '&message=' || new_message_id::text,
      jsonb_build_object(
        'groupId', p_group, 'messageId', new_message_id,
        'groupName', group_row.name, 'senderName', actor_name, 'senderId', actor,
        'kind', 'message'
      )
    );
  end loop;

  update public.community_group_members
     set last_read_at = now()
   where group_id = p_group and user_id = actor;

  return jsonb_build_object(
    'id', new_message_id,
    'createdAt', now(),
    'attachments', files,
    'everyone', wants_everyone
  );
end $$;
revoke all on function public.group_send(uuid, text, jsonb) from public, anon;
grant execute on function public.group_send(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The thread returns what was attached
-- ---------------------------------------------------------------------------
create or replace function public.group_messages_list(
  p_group uuid,
  p_before timestamptz default null,
  p_limit integer default 60
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  cap int := greatest(1, least(coalesce(p_limit, 60), 200));
begin
  if actor is null then raise exception 'Sign in to read messages.' using errcode = '42501'; end if;
  if not public.group_is_member(p_group, actor) then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', x.id,
      'body', x.body,
      'createdAt', x.created_at,
      'authorId', x.author_id,
      'authorName', x.author_name,
      'authorUsername', x.author_username,
      'authorAvatarUrl', x.author_avatar,
      'attachments', x.attachments,
      'mentions', x.mentions
    ) order by x.created_at)
    from (
      select m.id, m.body, m.created_at, m.author_id, m.attachments,
             coalesce(nullif(p.full_name, ''), p.username, 'Member') as author_name,
             p.username as author_username,
             p.avatar_url as author_avatar,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                 'userId', cm.mentioned_user, 'kind', cm.kind,
                 'username', mp.username, 'name', mp.full_name
               ))
               from public.community_mentions cm
               join public.profiles mp on mp.id = cm.mentioned_user
               where cm.message_id = m.id
             ), '[]'::jsonb) as mentions
      from public.community_messages m
      join public.profiles p on p.id = m.author_id
      where m.group_id = p_group
        and m.removed_at is null
        and (p_before is null or m.created_at < p_before)
      order by m.created_at desc
      limit cap
    ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.group_messages_list(uuid, timestamptz, integer) from public, anon;
grant execute on function public.group_messages_list(uuid, timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Realtime Authorization for calls
-- ---------------------------------------------------------------------------
-- Topics:
--   call-group:<uuid>   a voice/video meeting inside a group
--   call-dm:<uuid>      a one-to-one call inside a direct conversation
--
-- `realtime.messages` is a real table with RLS already enabled, so these are
-- ordinary policies: Realtime asks the database before it lets a socket join or
-- publish on a topic.

/** True when the caller is in the conversation a `call-dm:` topic names. */
create or replace function public.dm_is_member(p_conversation uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_conversation_members m
    where m.conversation_id = p_conversation and m.user_id = p_user
  );
$$;

revoke all on function public.dm_is_member(uuid, uuid) from public, anon;
grant execute on function public.dm_is_member(uuid, uuid) to authenticated, service_role;

drop policy if exists "call signalling for members" on realtime.messages;
create policy "call signalling for members"
  on realtime.messages
  for all
  to authenticated
  using (
    case
      when realtime.topic() like 'call-group:%' then
        public.group_is_member(public.safe_uuid(split_part(realtime.topic(), ':', 2)), auth.uid())
      when realtime.topic() like 'call-dm:%' then
        public.dm_is_member(public.safe_uuid(split_part(realtime.topic(), ':', 2)), auth.uid())
      else false
    end
  )
  with check (
    case
      when realtime.topic() like 'call-group:%' then
        public.group_is_member(public.safe_uuid(split_part(realtime.topic(), ':', 2)), auth.uid())
      when realtime.topic() like 'call-dm:%' then
        public.dm_is_member(public.safe_uuid(split_part(realtime.topic(), ':', 2)), auth.uid())
      else false
    end
  );

comment on policy "call signalling for members" on realtime.messages is
  'Only a member of the group or conversation named in the topic may signal on it. Anonymous and non-member clients are refused by Realtime itself.';
