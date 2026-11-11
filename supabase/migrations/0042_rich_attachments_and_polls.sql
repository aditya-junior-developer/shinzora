-- ============================================================================
-- 0042 · Richer attachments, and polls that live in the thread
-- ----------------------------------------------------------------------------
-- Three things, all of them about the composer:
--
--   1. More than pictures and PDFs. Video (with a preview), audio (playable in
--      the bubble) and ordinary documents are allowed now, so the attach menu
--      can offer four real choices instead of one. The bucket, the size limit
--      and `group_send` are changed together — a client that only changes its
--      accept="" attribute would get a refusal from the server.
--   2. Polls. A poll is a message with a poll attached, so it inherits the
--      thread, the unread count and the notifications that already work. The
--      votes live in their own table with one row per person per option, which
--      makes "who voted" and "how many" the same query and keeps a repeat vote
--      idempotent.
--   3. Membership is checked in every one of these functions, because a poll is
--      still a thing only the group may see.
-- ============================================================================

/* ---------------------------------------------------------------------------
-- 1. Which attachment types are allowed
-- ---------------------------------------------------------------------------
-- One list in one place. `group_send` calls it, so the database and the file
-- picker cannot drift apart, and adding a type later is a new row here rather
-- than an edit in four functions.
*/
create or replace function public.attachment_mime_ok(p_mime text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_mime, '') in (
    /* pictures */
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    /* video — previewed in the thread */
    'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
    /* audio — played in the thread */
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg',
    'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac',
    /* documents — opened, never forced into a download */
    'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
$$;

revoke all on function public.attachment_mime_ok(text) from public, anon;
grant execute on function public.attachment_mime_ok(text) to authenticated, service_role;

/* The bucket is the second half of the same rule: storage refuses an upload of
   a type it does not list, so both have to agree. */
update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp', 'image/gif',
         'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
         'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg',
         'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac',
         'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation'
       ]
 where id = 'group-chat-files';

/* ---------------------------------------------------------------------------
-- 2. Polls
-- --------------------------------------------------------------------------- */
create table if not exists public.group_polls (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.community_groups(id) on delete cascade,
  question    text not null check (char_length(btrim(question)) between 1 and 300),
  /* Two to ten options, stored as they were typed. `jsonb_array_length` cannot
     be used in a check with a subquery, so the shape is checked by the RPC and
     the count here. */
  options     jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 10),
  multiple    boolean not null default false,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  closes_at   timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists group_polls_group_idx on public.group_polls (group_id, created_at desc);

create table if not exists public.group_poll_votes (
  poll_id      uuid not null references public.group_polls(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  option_index integer not null check (option_index between 0 and 9),
  created_at   timestamptz not null default now(),
  primary key (poll_id, user_id, option_index)
);

create index if not exists group_poll_votes_poll_idx on public.group_poll_votes (poll_id);

/* Read only through the RPCs below, which know whether the caller is a member.
   No policy grants a direct select, so a leaked id is not a leaked poll. */
alter table public.group_polls enable row level security;
alter table public.group_poll_votes enable row level security;

/**
 * The tally, in the shape the bubble needs: counts per option, who voted for
 * what, and which options are mine.
 */
create or replace function public.group_poll_payload(p_poll uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  poll_row public.group_polls;
  tally jsonb;
  mine jsonb;
begin
  select * into poll_row from public.group_polls p where p.id = p_poll;
  if poll_row.id is null then
    raise exception 'That poll does not exist.' using errcode = 'P0002';
  end if;
  if not public.group_is_member(poll_row.group_id, actor) then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'index', ord.idx,
           'label', ord.label,
           'count', coalesce(votes.n, 0)
         ) order by ord.idx), '[]'::jsonb)
    into tally
    from (
      select (t.ordinality - 1)::int as idx, t.value as label
      from jsonb_array_elements_text(poll_row.options) with ordinality as t(value, ordinality)
    ) ord
    left join (
      select option_index, count(*)::int as n
      from public.group_poll_votes
      where poll_id = p_poll
      group by option_index
    ) votes on votes.option_index = ord.idx;

  select coalesce(jsonb_agg(option_index), '[]'::jsonb)
    into mine
    from public.group_poll_votes
    where poll_id = p_poll and user_id = actor;

  return jsonb_build_object(
    'id', poll_row.id,
    'groupId', poll_row.group_id,
    'question', poll_row.question,
    'multiple', poll_row.multiple,
    'closed', poll_row.closes_at is not null and poll_row.closes_at < now(),
    'closesAt', poll_row.closes_at,
    'options', tally,
    'mine', mine,
    'totalVoters', (select count(distinct user_id) from public.group_poll_votes where poll_id = p_poll),
    'canClose', public.group_role_of(poll_row.group_id, actor) in ('owner', 'admin')
  );
end $$;

revoke all on function public.group_poll_payload(uuid) from public, anon;
grant execute on function public.group_poll_payload(uuid) to authenticated;

/**
 * Create a poll — and the message that carries it.
 *
 * The message is written by `group_send`, not here, so a poll lands in the
 * thread with the same preview, mentions and notifications as any other
 * message. One path for "something was said in this group".
 */
create or replace function public.group_poll_create(
  p_group uuid,
  p_question text,
  p_options jsonb,
  p_multiple boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  clean_question text := btrim(coalesce(p_question, ''));
  clean_options jsonb := '[]'::jsonb;
  option_text text;
  poll_id uuid;
  message jsonb;
begin
  if actor is null then raise exception 'Sign in to create a poll.' using errcode = '42501'; end if;
  if not public.group_is_member(p_group, actor) then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;
  if char_length(clean_question) < 1 then
    raise exception 'A poll needs a question.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_options) <> 'array' then
    raise exception 'Poll options must be a list.' using errcode = '22023';
  end if;

  /* Empty options are dropped rather than refused: a stray blank line in a
     pasted list should not cost the whole poll. */
  for option_text in select jsonb_array_elements_text(p_options) loop
    if char_length(btrim(option_text)) > 0 then
      clean_options := clean_options || to_jsonb(left(btrim(option_text), 120));
    end if;
  end loop;

  if jsonb_array_length(clean_options) < 2 then
    raise exception 'A poll needs at least two options.' using errcode = '22023';
  end if;
  if jsonb_array_length(clean_options) > 10 then
    raise exception 'Ten options at most.' using errcode = '22023';
  end if;

  insert into public.group_polls (group_id, question, options, multiple, created_by)
  values (p_group, left(clean_question, 300), clean_options, coalesce(p_multiple, false), actor)
  returning id into poll_id;

  message := public.group_send(
    p_group,
    clean_question,
    jsonb_build_array(jsonb_build_object(
      'kind', 'poll',
      'mime', 'application/x-shinzora-poll',
      'pollId', poll_id,
      'path', 'poll:' || poll_id::text,
      'name', left(clean_question, 60),
      'size', 1
    ))
  );

  return jsonb_build_object(
    'poll', public.group_poll_payload(poll_id),
    'message', message
  );
end $$;

revoke all on function public.group_poll_create(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.group_poll_create(uuid, text, jsonb, boolean) to authenticated;

/** Read one poll. */
create or replace function public.group_poll_get(p_poll uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in to see a poll.' using errcode = '42501'; end if;
  return public.group_poll_payload(p_poll);
end $$;

revoke all on function public.group_poll_get(uuid) from public, anon;
grant execute on function public.group_poll_get(uuid) to authenticated;

/**
 * Vote, or take a vote back.
 *
 * A single-choice poll removes the voter's other rows first, so the state can
 * never be "two options in a poll that only allows one". Voting twice for the
 * same option is a no-op, which makes a double tap harmless.
 */
create or replace function public.group_poll_vote(
  p_poll uuid,
  p_option integer,
  p_on boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  poll_row public.group_polls;
begin
  if actor is null then raise exception 'Sign in to vote.' using errcode = '42501'; end if;
  select * into poll_row from public.group_polls p where p.id = p_poll;
  if poll_row.id is null then
    raise exception 'That poll does not exist.' using errcode = 'P0002';
  end if;
  if not public.group_is_member(poll_row.group_id, actor) then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;
  if poll_row.closes_at is not null and poll_row.closes_at < now() then
    raise exception 'This poll is closed.' using errcode = '22023';
  end if;
  if p_option is null or p_option < 0 or p_option >= jsonb_array_length(poll_row.options) then
    raise exception 'That option is not in this poll.' using errcode = '22023';
  end if;

  if p_on then
    if not poll_row.multiple then
      delete from public.group_poll_votes
       where poll_id = p_poll and user_id = actor and option_index <> p_option;
    end if;
    insert into public.group_poll_votes (poll_id, user_id, option_index)
    values (p_poll, actor, p_option)
    on conflict do nothing;
  else
    delete from public.group_poll_votes
     where poll_id = p_poll and user_id = actor and option_index = p_option;
  end if;

  return public.group_poll_payload(p_poll);
end $$;

revoke all on function public.group_poll_vote(uuid, integer, boolean) from public, anon;
grant execute on function public.group_poll_vote(uuid, integer, boolean) to authenticated;

/* ---------------------------------------------------------------------------
-- 3. `group_send`, unchanged except for the two rules above
-- ---------------------------------------------------------------------------
-- Copied verbatim from 0039 with only the attachment checks replaced, so the
-- mention and notification behaviour cannot drift while this file is applied.
*/
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
    if coalesce(item->>'mime', '') <> 'application/x-shinzora-poll'
       and item->>'path' not like (p_group::text || '/%') then
      raise exception 'That file does not belong to this group.' using errcode = '42501';
    end if;
    /* A poll rides along as an attachment so that it lives in the same thread,
       with the same notifications. It is not a file: there is no object behind
       it, so the path check above is replaced by "this poll is in this group". */
    if coalesce(item->>'mime', '') = 'application/x-shinzora-poll' then
      if not exists (
        select 1 from public.group_polls gp
        where gp.id = public.safe_uuid(replace(coalesce(item->>'path', ''), 'poll:', ''))
          and gp.group_id = p_group
      ) then
        raise exception 'That poll is not in this group.' using errcode = '42501';
      end if;
      continue;
    end if;
    if not public.attachment_mime_ok(item->>'mime') then
      raise exception 'That file type cannot be attached. Pictures, video, audio, PDFs and documents are allowed.' using errcode = '22023';
    end if;
    if coalesce((item->>'size')::bigint, 0) < 1 or (item->>'size')::bigint > 52428800 then
      raise exception 'Each file must be under 50 MB.' using errcode = '22023';
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

/* ---------------------------------------------------------------------------
-- 4. The same rules in a direct conversation
-- ---------------------------------------------------------------------------
-- `team_chat_send` had its own two-line whitelist; it now asks the same
-- function, so a video can be sent to a colleague as easily as to a group and
-- the two can never disagree about what is allowed.
*/
create or replace function public.team_chat_send(p_conversation uuid, p_body text, p_attachments jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  conversation public.team_conversations%rowtype;
  body_text text := btrim(coalesce(p_body, ''));
  attachment_list jsonb := coalesce(p_attachments, '[]'::jsonb);
  attachment jsonb;
  saved public.team_chat_messages%rowtype;
begin
  select * into conversation from public.team_conversations c where c.id = p_conversation;
  if conversation.id is null or actor is null
     or not public.is_team_conversation_member(p_conversation, actor) then
    raise exception 'Not a member of this conversation.' using errcode = '42501';
  end if;
  if jsonb_typeof(attachment_list) <> 'array' or jsonb_array_length(attachment_list) > 10 then
    raise exception 'Attachments must be a list of up to ten files.' using errcode = '22023';
  end if;
  if char_length(body_text) > 4000 or (body_text = '' and jsonb_array_length(attachment_list) = 0) then
    raise exception 'Write a message or attach a file.' using errcode = '22023';
  end if;
  for attachment in select value from jsonb_array_elements(attachment_list) loop
    if not public.attachment_mime_ok(attachment->>'mime')
       or coalesce((attachment->>'size')::bigint, 0) < 1
       or (attachment->>'size')::bigint > 52428800
       or coalesce(attachment->>'path', '') not like p_conversation::text || '/' || actor::text || '/%'
       or coalesce(attachment->>'path', '') like '%..%' then
      raise exception 'A file is not allowed for team chat.' using errcode = '22023';
    end if;
  end loop;

  insert into public.team_chat_messages (conversation_id, sender_id, body, attachments)
  values (p_conversation, actor, body_text, attachment_list)
  returning * into saved;
  update public.team_conversations set last_message_at = saved.created_at where id = p_conversation;
  return jsonb_build_object('id', saved.id, 'conversationId', saved.conversation_id,
    'senderId', saved.sender_id, 'body', saved.body, 'attachments', saved.attachments, 'createdAt', saved.created_at);
end;
$$;

revoke all on function public.team_chat_send(uuid, text, jsonb) from public, anon;
grant execute on function public.team_chat_send(uuid, text, jsonb) to authenticated, service_role;

/* The direct-message bucket gets the same list and the same ceiling. */
update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = (select allowed_mime_types from storage.buckets where id = 'group-chat-files')
 where id = 'team-chat-files';
