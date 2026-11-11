-- ============================================================================
-- 0044 · A ringing phone needs a stored ring
-- ----------------------------------------------------------------------------
-- Calls were pure Realtime broadcast: a private channel, an offer, an answer. It
-- works beautifully between two open tabs and cannot work at all beyond them,
-- because nothing about a call was ever written down. A phone with the screen
-- off, or a laptop with Shinzora behind another window, cannot hear a broadcast
-- it is not subscribed to.
--
-- So a call now leaves a row and a notification:
--
--   call_invite_start(...)  → one `call_invites` row (the ring, valid for two
--                             minutes) + one notification per person being rung.
--
-- The notification is the same kind of row every other alert uses, so it reaches
-- a closed tab through the Web Push fan-out from 0038 with no new plumbing. The
-- invite is what makes the ring *stoppable*: it expires, and the client stops
-- ringing when it does, so nobody comes back to a silent phone stuck mid-ring.
--
-- Nothing here decides who may join the media room — `realtime.messages` policy
-- and the call's own topic still do that. This only says "somebody is calling".
-- ============================================================================

create table if not exists public.call_invites (
  id              uuid primary key default gen_random_uuid(),
  topic           text not null check (char_length(topic) between 3 and 200),
  kind            text not null default 'voice' check (kind in ('voice', 'video')),
  group_id        uuid references public.community_groups(id) on delete cascade,
  conversation_id uuid references public.team_conversations(id) on delete cascade,
  started_by      uuid not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '2 minutes',
  check (group_id is not null or conversation_id is not null)
);

create index if not exists call_invites_live_idx on public.call_invites (expires_at desc);

alter table public.call_invites enable row level security;

drop policy if exists call_invites_member_read on public.call_invites;
create policy call_invites_member_read on public.call_invites
  for select to authenticated
  using (
    started_by = auth.uid()
    or (group_id is not null and public.group_is_member(group_id))
    or (conversation_id is not null and public.is_team_conversation_member(conversation_id))
  );

/**
 * Start ringing.
 *
 * `p_topic` is the Realtime topic the call itself uses, so the notification can
 * lead the person straight into the same room. Returns the invite id and how
 * many people were actually rung — a caller is told the truth about a ringout
 * that reached nobody.
 */
create or replace function public.call_invite_start(
  p_topic text,
  p_kind text default 'voice',
  p_group uuid default null,
  p_conversation uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  clean_topic text := left(btrim(coalesce(p_topic, '')), 200);
  clean_kind text := case when lower(coalesce(p_kind, 'voice')) = 'video' then 'video' else 'voice' end;
  invite public.call_invites%rowtype;
  caller_name text;
  where_name text;
  link text;
  recipient record;
  rung integer := 0;
begin
  if actor is null then raise exception 'Sign in to start a call.' using errcode = '42501'; end if;
  if char_length(clean_topic) < 3 then raise exception 'A call needs a topic.' using errcode = '22023'; end if;

  if p_group is not null then
    if not public.group_is_member(p_group, actor) then
      raise exception 'You are not in that group.' using errcode = '42501';
    end if;
    select coalesce(nullif(btrim(name), ''), 'Group') into where_name
    from public.community_groups where id = p_group;
    link := '/app/?view=messages&group=' || p_group::text || '&call=' || clean_topic;
  elsif p_conversation is not null then
    if not public.is_team_conversation_member(p_conversation, actor) then
      raise exception 'You are not in that conversation.' using errcode = '42501';
    end if;
    select coalesce(nullif(btrim(title), ''), 'Direct message') into where_name
    from public.team_conversations where id = p_conversation;
    link := '/app/?view=messages&conversation=' || p_conversation::text || '&call=' || clean_topic;
  else
    raise exception 'A call belongs to a group or a conversation.' using errcode = '22023';
  end if;

  select coalesce(nullif(btrim(full_name), ''), 'Someone') into caller_name
  from public.profiles where id = actor;

  insert into public.call_invites (topic, kind, group_id, conversation_id, started_by)
  values (clean_topic, clean_kind, p_group, p_conversation, actor)
  returning * into invite;

  for recipient in
    select m.user_id, coalesce(m.muted, false) as muted
    from public.community_group_members m
    where p_group is not null and m.group_id = p_group and m.user_id <> actor
    union all
    select cm.user_id, false as muted
    from public.team_conversation_members cm
    where p_conversation is not null and cm.conversation_id = p_conversation and cm.user_id <> actor
  loop
    /* A muted group stays quiet — but a call is the one thing that is worth a
       ring even then only if the person asked for it. Muted means muted. */
    continue when recipient.muted;

    perform public.notify_user(
      recipient.user_id,
      'call',
      (case when clean_kind = 'video' then 'Video call from ' else 'Call from ' end) || coalesce(caller_name, 'someone'),
      coalesce(where_name, 'Shinzora'),
      link,
      jsonb_build_object(
        'callTopic', clean_topic,
        'callKind', clean_kind,
        'inviteId', invite.id,
        'groupId', p_group,
        'conversationId', p_conversation,
        'senderName', caller_name,
        'kind', 'call',
        'expiresAt', invite.expires_at
      )
    );
    rung := rung + 1;
  end loop;

  return jsonb_build_object(
    'inviteId', invite.id,
    'topic', clean_topic,
    'kind', clean_kind,
    'rung', rung,
    'expiresAt', invite.expires_at
  );
end $$;

revoke all on function public.call_invite_start(text, text, uuid, uuid) from public, anon;
grant execute on function public.call_invite_start(text, text, uuid, uuid) to authenticated, service_role;

/** Stop ringing — called when the caller hangs up or the call is accepted. */
create or replace function public.call_invite_end(p_topic text)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  removed integer := 0;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  delete from public.call_invites
  where topic = p_topic
    and (started_by = actor
      or (group_id is not null and public.group_role_of(group_id, actor) in ('owner', 'admin')));
  get diagnostics removed = row_count;
  update public.notifications
     set is_read = true
   where type = 'call'
     and user_id = actor
     and meta ->> 'callTopic' = p_topic;
  return jsonb_build_object('ended', true, 'removed', removed);
end $$;

revoke all on function public.call_invite_end(text) from public, anon;
grant execute on function public.call_invite_end(text) to authenticated, service_role;

comment on table public.call_invites is
  'A ringing call. Rows expire after two minutes; the client stops ringing when they do.';
comment on function public.call_invite_start(text, text, uuid, uuid) is
  'Rings every member who has not muted the group, through the ordinary notification pipeline.';
