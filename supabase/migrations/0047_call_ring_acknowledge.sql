-- ============================================================================
-- 0047 · Silencing a ring, and asking who answered
-- ----------------------------------------------------------------------------
-- Two small gaps left by 0046, both of them the difference between a ring that
-- ends properly and one that keeps coming back.
--
--   call_invite_acknowledge()  the callee dismissed the ring (or let it expire).
--                              The stored `call` notification is marked read so
--                              a reload does not ring again for a call that is
--                              already over. Only the person being rung can do
--                              this — the caller marking it read would hide the
--                              call from the person they rang.
--
--   call_invite_state()        what happened to one invite: who accepted, who
--                              declined, how many are still ringing. The caller's
--                              surface reads this so a call that was declined
--                              says "declined" instead of showing a spinner
--                              forever.
-- ============================================================================

/**
 * Dismiss the ring for this topic.
 *
 * Idempotent and safe to call for an invite that has already expired.
 */
create or replace function public.call_invite_acknowledge(p_topic text)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  cleared integer := 0;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;

  update public.notifications
     set is_read = true
   where type = 'call'
     and user_id = actor
     and meta ->> 'callTopic' = p_topic;

  get diagnostics cleared = row_count;
  return jsonb_build_object('acknowledged', true, 'cleared', cleared);
end $$;

revoke all on function public.call_invite_acknowledge(text) from public, anon;
grant execute on function public.call_invite_acknowledge(text) to authenticated, service_role;

/**
 * The state of one invite, for the caller.
 *
 * Visible to the person who started the call and to anybody who was rung; a
 * stranger gets an empty result rather than somebody else's call log.
 */
create or replace function public.call_invite_state(p_topic text)
returns jsonb
language plpgsql
stable
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  invite public.call_invites%rowtype;
  accepted jsonb := '[]'::jsonb;
  declined jsonb := '[]'::jsonb;
  allowed boolean := false;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;

  select * into invite from public.call_invites
   where topic = p_topic
   order by created_at desc limit 1;

  if invite.id is null then
    return jsonb_build_object('found', false);
  end if;

  allowed := invite.started_by = actor
          or (invite.group_id is not null and public.group_is_member(invite.group_id, actor))
          or (invite.conversation_id is not null and public.dm_is_member(invite.conversation_id, actor));

  if not allowed then
    return jsonb_build_object('found', false);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('userId', r.user_id, 'name', coalesce(nullif(btrim(p.full_name), ''), 'Someone'))), '[]'::jsonb)
    into accepted
    from public.call_responses r
    left join public.profiles p on p.id = r.user_id
   where r.invite_id = invite.id and r.status = 'accepted';

  select coalesce(jsonb_agg(jsonb_build_object('userId', r.user_id, 'name', coalesce(nullif(btrim(p.full_name), ''), 'Someone'))), '[]'::jsonb)
    into declined
    from public.call_responses r
    left join public.profiles p on p.id = r.user_id
   where r.invite_id = invite.id and r.status = 'declined';

  return jsonb_build_object(
    'found', true,
    'inviteId', invite.id,
    'kind', invite.kind,
    'startedBy', invite.started_by,
    'expiresAt', invite.expires_at,
    'expired', invite.expires_at <= now(),
    'accepted', accepted,
    'declined', declined
  );
end $$;

revoke all on function public.call_invite_state(text) from public, anon;
grant execute on function public.call_invite_state(text) to authenticated, service_role;

-- --------------------------------------------------------------- realtime
-- A meeting has to be able to say "the host ended this" to the people inside
-- it. Without these two tables on the publication, an attendee's client can
-- only find out by polling, and an ended meeting looks like a frozen call.
-- RLS still decides which rows Realtime delivers.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meetings'
    ) then
      alter publication supabase_realtime add table public.meetings;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meeting_attendees'
    ) then
      alter publication supabase_realtime add table public.meeting_attendees;
    end if;
  end if;
end $$;

comment on table public.meetings is
  'A room with a short code, a host and an end. On the realtime publication since 0047, so attendees learn when the host ends or locks it.';
