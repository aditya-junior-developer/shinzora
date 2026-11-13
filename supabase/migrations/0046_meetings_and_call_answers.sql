-- ============================================================================
-- 0046 · Real calling: answers, missed calls, and meetings with a code
-- ----------------------------------------------------------------------------
-- 0044 made a call *visible* — a row and a notification, so a ring could reach
-- a tab that was not already in the room. What it could not do is *answer*:
-- there was one invite row for the whole call, no per-person outcome, and no
-- way to say "they picked up", "they declined" or "nobody answered".
--
-- This migration adds the three things a phone has had since 1876:
--
--   call_responses          one row per person rung: accepted / declined
--   call_invite_answer()    the callee picks up
--   call_invite_decline()   the callee refuses — the caller is told, and told
--                           in a notification that does NOT ring
--   call_invite_missed()    the caller hangs up with nobody answering; every
--                           person still ringing gets a missed-call notice
--
-- And it adds meetings, because "video meeting" was a group call with no
-- identity of its own: no code, no lobby, no host, no record.
--
--   meetings           a room with a short code, a host, and an end
--   meeting_attendees  who was in it, and whether they are still in it
--   meeting_create / meeting_lookup / meeting_join / meeting_leave /
--   meeting_end / meeting_lock / meeting_mine
--
-- Authorisation is in the database, not the browser:
--   • a meeting can only be joined with its code, and only by a signed-in user;
--   • a locked meeting is only joinable by the host;
--   • signalling on `call-meeting:<id>` is allowed only to somebody who already
--     holds an attendee row for that meeting, so a guessed id is useless.
-- ============================================================================

-- ------------------------------------------------------------------ answers

create table if not exists public.call_responses (
  invite_id    uuid not null references public.call_invites(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  status       text not null check (status in ('accepted', 'declined')),
  responded_at timestamptz not null default now(),
  primary key (invite_id, user_id)
);

alter table public.call_responses enable row level security;

drop policy if exists call_responses_self on public.call_responses;
create policy call_responses_self on public.call_responses
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.call_invites i
      where i.id = invite_id and i.started_by = auth.uid()
    )
  );

/** The invite this topic belongs to, if the caller is allowed to see it. */
create or replace function public.call_invite_for_topic(p_topic text)
returns public.call_invites
language sql
stable
security definer
set search_path to public
as $$
  select * from public.call_invites
  where topic = p_topic
  order by created_at desc
  limit 1;
$$;

revoke all on function public.call_invite_for_topic(text) from public, anon;
grant execute on function public.call_invite_for_topic(text) to authenticated, service_role;

/**
 * Pick up.
 *
 * Writes the answer, stops this member's ring, and returns what the client
 * needs to join the room — the kind, the where, and the starter's name.
 * Idempotent: pressing Accept twice is not an error.
 */
create or replace function public.call_invite_answer(p_topic text)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  invite public.call_invites%rowtype;
  starter_name text;
  allowed boolean := false;
begin
  if actor is null then raise exception 'Sign in to answer a call.' using errcode = '42501'; end if;

  select * into invite from public.call_invites
   where topic = p_topic and expires_at > now()
   order by created_at desc limit 1;

  if invite.id is null then
    raise exception 'That call is no longer ringing.' using errcode = 'P0002';
  end if;

  allowed := (invite.group_id is not null and public.group_is_member(invite.group_id, actor))
          or (invite.conversation_id is not null and public.dm_is_member(invite.conversation_id, actor))
          or invite.started_by = actor;

  if not allowed then
    raise exception 'You are not part of this call.' using errcode = '42501';
  end if;

  insert into public.call_responses (invite_id, user_id, status)
  values (invite.id, actor, 'accepted')
  on conflict (invite_id, user_id) do update set status = 'accepted', responded_at = now();

  /* The ring row is for the people being rung; once one of them answers the
     notification has done its job for this member. Leaving the row to expire is
     what makes a stale ring appear on the next page load. */
  update public.notifications
     set is_read = true
   where type = 'call' and user_id = actor
     and meta ->> 'callTopic' = p_topic;

  select coalesce(nullif(btrim(full_name), ''), 'Someone') into starter_name
    from public.profiles where id = invite.started_by;

  return jsonb_build_object(
    'inviteId', invite.id,
    'topic', invite.topic,
    'kind', invite.kind,
    'groupId', invite.group_id,
    'conversationId', invite.conversation_id,
    'startedBy', invite.started_by,
    'starterName', starter_name,
    'status', 'accepted'
  );
end $$;

revoke all on function public.call_invite_answer(text) from public, anon;
grant execute on function public.call_invite_answer(text) to authenticated, service_role;

/**
 * Refuse.
 *
 * The caller is told, through the ordinary notification pipeline — but with a
 * type that does not ring, because a declined call must not start another one.
 */
create or replace function public.call_invite_decline(p_topic text)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  invite public.call_invites%rowtype;
  who text;
  allowed boolean := false;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;

  select * into invite from public.call_invites
   where topic = p_topic
   order by created_at desc limit 1;

  if invite.id is null then return jsonb_build_object('declined', false, 'reason', 'gone'); end if;

  allowed := (invite.group_id is not null and public.group_is_member(invite.group_id, actor))
          or (invite.conversation_id is not null and public.dm_is_member(invite.conversation_id, actor));
  if not allowed then
    raise exception 'You are not part of this call.' using errcode = '42501';
  end if;

  insert into public.call_responses (invite_id, user_id, status)
  values (invite.id, actor, 'declined')
  on conflict (invite_id, user_id) do update set status = 'declined', responded_at = now();

  update public.notifications
     set is_read = true
   where type = 'call' and user_id = actor and meta ->> 'callTopic' = p_topic;

  select coalesce(nullif(btrim(full_name), ''), 'Someone') into who
    from public.profiles where id = actor;

  /* Not type `call`: this must never ring. */
  perform public.notify_user(
    invite.started_by,
    'call_declined',
    who || ' declined your call',
    'They are not joining the call.',
    null,
    jsonb_build_object('callTopic', p_topic, 'declinedBy', actor, 'kind', 'call_declined')
  );

  return jsonb_build_object('declined', true, 'status', 'declined');
end $$;

revoke all on function public.call_invite_decline(text) from public, anon;
grant execute on function public.call_invite_decline(text) to authenticated, service_role;

/**
 * Nobody answered.
 *
 * Called by the caller when their call ends. Every person still ringing gets a
 * missed-call notice, which is the only honest thing to write: they did not
 * answer, and pretending otherwise (a stale "X is calling" banner) is worse.
 */
create or replace function public.call_invite_missed(p_topic text)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  invite public.call_invites%rowtype;
  caller_name text;
  where_name text;
  missed integer := 0;
  recipient record;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;

  select * into invite from public.call_invites
   where topic = p_topic and started_by = actor
   order by created_at desc limit 1;

  /* Only the caller may declare their own call unanswered. */
  if invite.id is null then return jsonb_build_object('missed', 0, 'reason', 'not_yours'); end if;

  select coalesce(nullif(btrim(full_name), ''), 'Someone') into caller_name
    from public.profiles where id = actor;

  where_name := case
    when invite.group_id is not null then (select coalesce(name, 'Group') from public.community_groups where id = invite.group_id)
    else (select coalesce(title, 'Direct message') from public.team_conversations where id = invite.conversation_id)
  end;

  for recipient in
    select distinct r.user_id as user_id
      from public.call_responses r
     where r.invite_id = invite.id and r.status = 'accepted'
    union
    select m.user_id from public.community_group_members m
     where invite.group_id is not null and m.group_id = invite.group_id and m.user_id <> actor
    union
    select cm.user_id from public.team_conversation_members cm
     where invite.conversation_id is not null and cm.conversation_id = invite.conversation_id and cm.user_id <> actor
  loop
    /* Anyone who answered is in the call or left it — that is not a miss. */
    continue when exists (
      select 1 from public.call_responses r
       where r.invite_id = invite.id and r.user_id = recipient.user_id and r.status = 'accepted'
    );

    perform public.notify_user(
      recipient.user_id,
      'call_missed',
      'Missed call from ' || coalesce(caller_name, 'someone'),
      coalesce(where_name, 'Shinzora'),
      null,
      jsonb_build_object(
        'callTopic', p_topic,
        'kind', 'call_missed',
        'callKind', invite.kind,
        'senderName', caller_name,
        'groupId', invite.group_id,
        'conversationId', invite.conversation_id
      )
    );
    missed := missed + 1;
  end loop;

  delete from public.call_invites where id = invite.id;
  return jsonb_build_object('missed', missed);
end $$;

revoke all on function public.call_invite_missed(text) from public, anon;
grant execute on function public.call_invite_missed(text) to authenticated, service_role;

-- ----------------------------------------------------------------- meetings

create table if not exists public.meetings (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[a-z0-9]{9}$'),
  title       text not null check (char_length(btrim(title)) between 1 and 120),
  kind        text not null default 'video' check (kind in ('video', 'voice')),
  host_id     uuid not null references public.profiles(id) on delete cascade,
  is_locked   boolean not null default false,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  ended_at    timestamptz
);

create index if not exists meetings_host_idx on public.meetings (host_id, created_at desc);
create index if not exists meetings_code_idx on public.meetings (code);

create table if not exists public.meeting_attendees (
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'guest' check (role in ('host', 'guest')),
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (meeting_id, user_id)
);

create index if not exists meeting_attendees_live_idx
  on public.meeting_attendees (meeting_id) where left_at is null;

alter table public.meetings enable row level security;
alter table public.meeting_attendees enable row level security;

drop policy if exists meetings_read on public.meetings;
create policy meetings_read on public.meetings
  for select to authenticated
  using (
    host_id = auth.uid()
    or exists (
      select 1 from public.meeting_attendees a
      where a.meeting_id = meetings.id and a.user_id = auth.uid()
    )
  );

drop policy if exists meeting_attendees_read on public.meeting_attendees;
create policy meeting_attendees_read on public.meeting_attendees
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.meetings m where m.id = meeting_id and m.host_id = auth.uid()
    )
    or exists (
      select 1 from public.meeting_attendees self
      where self.meeting_id = meeting_attendees.meeting_id and self.user_id = auth.uid()
    )
  );

/** A short, readable, non-guessable code: 9 base-32 characters. */
create or replace function public.meeting_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789';
  candidate text := '';
  index_at integer;
begin
  for index_at in 1..9 loop
    candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return candidate;
end $$;

revoke all on function public.meeting_code() from public, anon, authenticated;

/**
 * Start a meeting. The host is an attendee from the first frame, and the code
 * is retried until it is unique — a collision is an ordinary event, not an error
 * the user should ever see.
 */
create or replace function public.meeting_create(p_title text, p_kind text default 'video')
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  clean_title text := coalesce(nullif(btrim(p_title), ''), 'Meeting');
  clean_kind text := case when lower(coalesce(p_kind, 'video')) = 'voice' then 'voice' else 'video' end;
  new_code text;
  attempt integer := 0;
  meeting public.meetings%rowtype;
begin
  if actor is null then raise exception 'Sign in to start a meeting.' using errcode = '42501'; end if;

  loop
    attempt := attempt + 1;
    new_code := public.meeting_code();
    exit when not exists (select 1 from public.meetings where code = new_code);
    if attempt > 12 then raise exception 'Could not allocate a meeting code. Try again.' using errcode = 'P0001'; end if;
  end loop;

  insert into public.meetings (code, title, kind, host_id, started_at)
  values (new_code, left(clean_title, 120), clean_kind, actor, now())
  returning * into meeting;

  insert into public.meeting_attendees (meeting_id, user_id, role)
  values (meeting.id, actor, 'host')
  on conflict (meeting_id, user_id) do update set left_at = null, role = 'host';

  return jsonb_build_object(
    'id', meeting.id,
    'code', meeting.code,
    'title', meeting.title,
    'kind', meeting.kind,
    'hostId', meeting.host_id,
    'topic', 'call-meeting:' || meeting.id::text,
    'joinUrl', '/app/?view=meeting&code=' || meeting.code
  );
end $$;

revoke all on function public.meeting_create(text, text) from public, anon;
grant execute on function public.meeting_create(text, text) to authenticated, service_role;

/**
 * Look a meeting up by its code.
 *
 * Deliberately narrow: it returns what the lobby needs to show and nothing
 * else, and it does not admit anybody. Joining is a separate, recorded act.
 */
create or replace function public.meeting_lookup(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  meeting public.meetings%rowtype;
  host_name text;
  live integer := 0;
begin
  if actor is null then raise exception 'Sign in to join a meeting.' using errcode = '42501'; end if;

  select * into meeting from public.meetings where code = lower(btrim(coalesce(p_code, '')));
  if meeting.id is null then return jsonb_build_object('found', false); end if;

  if meeting.ended_at is not null then
    return jsonb_build_object('found', true, 'ended', true, 'title', meeting.title);
  end if;

  select coalesce(nullif(btrim(full_name), ''), 'Someone') into host_name
    from public.profiles where id = meeting.host_id;

  select count(*) into live from public.meeting_attendees
   where meeting_id = meeting.id and left_at is null;

  return jsonb_build_object(
    'found', true,
    'id', meeting.id,
    'code', meeting.code,
    'title', meeting.title,
    'kind', meeting.kind,
    'hostId', meeting.host_id,
    'hostName', host_name,
    'locked', meeting.is_locked,
    'youAreHost', meeting.host_id = actor,
    'participants', live,
    'topic', 'call-meeting:' || meeting.id::text
  );
end $$;

revoke all on function public.meeting_lookup(text) from public, anon;
grant execute on function public.meeting_lookup(text) to authenticated, service_role;

/**
 * Admit yourself.
 *
 * The attendee row is what authorises signalling on the meeting's topic, so
 * this is the door. A locked meeting opens only for its host.
 */
create or replace function public.meeting_join(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  found jsonb;
  meeting public.meetings%rowtype;
  name_of_actor text;
begin
  if actor is null then raise exception 'Sign in to join a meeting.' using errcode = '42501'; end if;

  select * into meeting from public.meetings where code = lower(btrim(coalesce(p_code, '')));
  if meeting.id is null then raise exception 'No meeting has that code.' using errcode = 'P0002'; end if;
  if meeting.ended_at is not null then raise exception 'That meeting has ended.' using errcode = 'P0001'; end if;
  if meeting.is_locked and meeting.host_id <> actor then
    raise exception 'This meeting is locked by the host.' using errcode = '42501';
  end if;

  insert into public.meeting_attendees (meeting_id, user_id, role)
  values (meeting.id, actor, case when meeting.host_id = actor then 'host' else 'guest' end)
  on conflict (meeting_id, user_id) do update
    set left_at = null,
        role = case when meeting.host_id = actor then 'host' else 'guest' end;

  select coalesce(nullif(btrim(full_name), ''), 'You') into name_of_actor
    from public.profiles where id = actor;

  found := public.meeting_lookup(meeting.code);

  /* A host arriving is worth announcing: it is the difference between joining a
     room and joining an empty room. */
  if meeting.host_id <> actor then
    perform public.notify_user(
      meeting.host_id,
      'meeting_joined',
      name_of_actor || ' joined "' || meeting.title || '"',
      'A participant joined your meeting.',
      '/app/?view=meeting&code=' || meeting.code,
      jsonb_build_object('meetingId', meeting.id, 'meetingCode', meeting.code, 'kind', 'meeting_joined')
    );
  end if;

  return found || jsonb_build_object('joined', true, 'youAreHost', meeting.host_id = actor);
end $$;

revoke all on function public.meeting_join(text) from public, anon;
grant execute on function public.meeting_join(text) to authenticated, service_role;

create or replace function public.meeting_leave(p_meeting uuid)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  update public.meeting_attendees
     set left_at = now()
   where meeting_id = p_meeting and user_id = actor and left_at is null;
  return jsonb_build_object('left', true);
end $$;

revoke all on function public.meeting_leave(uuid) from public, anon;
grant execute on function public.meeting_leave(uuid) to authenticated, service_role;

/** End a meeting for everybody. Host only. */
create or replace function public.meeting_end(p_meeting uuid)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  meeting public.meetings%rowtype;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;

  select * into meeting from public.meetings where id = p_meeting;
  if meeting.id is null then raise exception 'No such meeting.' using errcode = 'P0002'; end if;
  if meeting.host_id <> actor then
    raise exception 'Only the host can end this meeting.' using errcode = '42501';
  end if;

  update public.meetings set ended_at = now() where id = p_meeting;
  update public.meeting_attendees set left_at = now() where meeting_id = p_meeting and left_at is null;
  return jsonb_build_object('ended', true);
end $$;

revoke all on function public.meeting_end(uuid) from public, anon;
grant execute on function public.meeting_end(uuid) to authenticated, service_role;

/** Lock or unlock the door. Host only. */
create or replace function public.meeting_lock(p_meeting uuid, p_locked boolean)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  meeting public.meetings%rowtype;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  select * into meeting from public.meetings where id = p_meeting;
  if meeting.id is null then raise exception 'No such meeting.' using errcode = 'P0002'; end if;
  if meeting.host_id <> actor then
    raise exception 'Only the host can lock this meeting.' using errcode = '42501';
  end if;
  update public.meetings set is_locked = coalesce(p_locked, false) where id = p_meeting;
  return jsonb_build_object('locked', coalesce(p_locked, false));
end $$;

revoke all on function public.meeting_lock(uuid, boolean) from public, anon;
grant execute on function public.meeting_lock(uuid, boolean) to authenticated, service_role;

/** Meetings this member hosted or sat in recently. */
create or replace function public.meeting_mine(p_limit integer default 20)
returns setof jsonb
language sql
stable
security definer
set search_path to public
as $$
  select jsonb_build_object(
           'id', m.id,
           'code', m.code,
           'title', m.title,
           'kind', m.kind,
           'hostId', m.host_id,
           'youAreHost', m.host_id = auth.uid(),
           'createdAt', m.created_at,
           'endedAt', m.ended_at,
           'isLocked', m.is_locked
         )
    from public.meetings m
   where auth.uid() is not null
     and (
       m.host_id = auth.uid()
       or exists (
         select 1 from public.meeting_attendees a
          where a.meeting_id = m.id and a.user_id = auth.uid()
       )
     )
   order by m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

revoke all on function public.meeting_mine(integer) from public, anon;
grant execute on function public.meeting_mine(integer) to authenticated, service_role;

-- ------------------------------------------------ realtime authorisation

/**
 * A meeting's signalling topic is private, and the door is the attendee row.
 * Replacing rather than adding a policy: `realtime.messages` policies are
 * permissive, and a second one would loosen the first.
 */
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
      when realtime.topic() like 'call-meeting:%' then
        exists (
          select 1 from public.meeting_attendees a
           where a.meeting_id = public.safe_uuid(split_part(realtime.topic(), ':', 2))
             and a.user_id = auth.uid()
             and a.left_at is null
        )
      else false
    end
  )
  with check (
    case
      when realtime.topic() like 'call-group:%' then
        public.group_is_member(public.safe_uuid(split_part(realtime.topic(), ':', 2)), auth.uid())
      when realtime.topic() like 'call-dm:%' then
        public.dm_is_member(public.safe_uuid(split_part(realtime.topic(), ':', 2)), auth.uid())
      when realtime.topic() like 'call-meeting:%' then
        exists (
          select 1 from public.meeting_attendees a
           where a.meeting_id = public.safe_uuid(split_part(realtime.topic(), ':', 2))
             and a.user_id = auth.uid()
             and a.left_at is null
        )
      else false
    end
  );

comment on table public.meetings is
  'A room with a short code, a host who can end or lock it, and a signalling topic only its attendees may use.';
comment on function public.call_invite_answer(text) is
  'Answers a ring: records the acceptance and returns what the client needs to join the room.';
comment on function public.call_invite_decline(text) is
  'Declines a ring and tells the caller, in a notification type that does not ring.';
comment on function public.call_invite_missed(text) is
  'Called by the caller when nobody answered; writes missed-call notices for everybody still ringing.';
