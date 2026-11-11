-- ============================================================================
-- 0043 · A message is a notification
-- ----------------------------------------------------------------------------
-- Until now only *special* things made a notification row: a mention, being
-- added to a group, an invitation, a pitch. An ordinary message — the thing
-- that happens constantly — produced none, and because the Web Push fan-out in
-- 0038 hangs off `notifications` inserts, an ordinary message could not reach a
-- phone or a closed tab. The screenshots from the owner are exactly that: he
-- asked for a popup and a sound when a message arrives, and the database never
-- asked anybody's device to wake up.
--
-- This migration closes the gap:
--
--   • `team_chat_messages` insert  → one notification per other participant
--   • `community_messages` insert  → one notification per group member
--
-- Rules that keep it quiet enough to live with:
--
--   • The sender never notifies themselves.
--   • A muted group notifies nobody (muting is per member, on the membership).
--     A *direct mention* still arrives: `group_send` writes that row itself, and
--     this trigger stands aside when a mention row already exists for the same
--     message.
--   • The member's own preferences decide, read from `notification_preferences`,
--     with the defaults from 0037 when there is no row.
--   • One row per person per message, enforced by the existence check — a
--     constraint trigger, deferred to the end of the transaction, so it runs
--     after `group_send` has already written its mention rows and can see them.
--   • Attachments-only messages still say something ("sent a photo").
--
-- Everything it writes is an ordinary `notifications` row, so the notification
-- centre, the badge, the in-app notice, the OS alert and the Web Push all keep
-- working exactly as they already do. Nothing here is a second system.
-- ============================================================================

-- ------------------------------------------------------------------ 1. helpers

/**
 * "Sent a photo", "Sent 3 files" — a preview a person can act on when the body
 * is empty because everything was in the attachments.
 */
create or replace function public.message_preview(p_body text, p_attachments jsonb)
returns text
language sql
immutable
as $$
  select case
    when nullif(btrim(coalesce(p_body, '')), '') is not null
      then left(btrim(p_body), 140)
    when coalesce(jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)), 0) = 0 then 'New message'
    when jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) = 1 then
      case coalesce(coalesce(p_attachments, '[]'::jsonb) -> 0 ->> 'kind', 'file')
        when 'poll' then 'Sent a poll'
        when 'media' then 'Sent a photo or video'
        when 'audio' then 'Sent a voice note'
        else 'Sent a file'
      end
    else 'Sent ' || jsonb_array_length(p_attachments) || ' files'
  end;
$$;

comment on function public.message_preview(text, jsonb) is
  'One-line preview of a message for a notification body; never empty.';

/**
 * Is this person's message notification switched on?
 *
 * `pref_column` is the column name so one helper serves direct messages
 * (`group_messages`, the "new messages" switch in Settings) and groups (the same
 * switch, plus the group-specific mention column handled elsewhere).
 */
create or replace function public.message_alerts_on(p_user uuid, p_column text)
returns boolean
language plpgsql
stable
security definer
set search_path to public
as $$
declare
  enabled boolean;
begin
  if p_user is null then return false; end if;
  execute format('select %I from public.notification_preferences where user_id = $1', p_column)
    into enabled
    using p_user;
  -- No row yet means "never touched the switches": the 0037 defaults apply.
  return coalesce(enabled, true);
end;
$$;

comment on function public.message_alerts_on(uuid, text) is
  'The member''s own switch for message alerts, with the schema default when unset.';

revoke all on function public.message_alerts_on(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------- 2. direct messages

create or replace function public.tg_notify_team_chat_message()
returns trigger
language plpgsql
security definer
set search_path to public
as $$
declare
  recipient record;
  sender_name text;
  preview text := public.message_preview(new.body, new.attachments);
begin
  select coalesce(nullif(btrim(p.full_name), ''), 'Someone') into sender_name
  from public.profiles p where p.id = new.sender_id;

  for recipient in
    select m.user_id
    from public.team_conversation_members m
    where m.conversation_id = new.conversation_id
      and m.user_id <> new.sender_id
  loop
    continue when not public.message_alerts_on(recipient.user_id, 'group_messages');

    /* One notification per person per message, whatever else wrote one. */
    continue when exists (
      select 1 from public.notifications n
      where n.user_id = recipient.user_id
        and n.meta ->> 'messageId' = new.id::text
    );

    perform public.notify_user(
      recipient.user_id,
      'message',
      coalesce(sender_name, 'New message'),
      preview,
      '/app/?view=messages&conversation=' || new.conversation_id::text,
      jsonb_build_object(
        'messageId', new.id,
        'conversationId', new.conversation_id,
        'senderId', new.sender_id,
        'senderName', sender_name,
        'kind', 'message'
      )
    );
  end loop;

  return null;
end $$;

revoke all on function public.tg_notify_team_chat_message() from public, anon, authenticated;

drop trigger if exists team_chat_message_notifies on public.team_chat_messages;
create constraint trigger team_chat_message_notifies
  after insert on public.team_chat_messages
  deferrable initially deferred
  for each row
  execute function public.tg_notify_team_chat_message();

-- ------------------------------------------------------------ 3. group rooms

create or replace function public.tg_notify_group_message()
returns trigger
language plpgsql
security definer
set search_path to public
as $$
declare
  member record;
  sender_name text;
  group_name text;
  preview text := public.message_preview(new.body, new.attachments);
begin
  -- Public channels have no membership; this trigger is for group rows only.
  if new.group_id is null then return null; end if;

  select coalesce(nullif(btrim(p.full_name), ''), 'Someone') into sender_name
  from public.profiles p where p.id = new.author_id;
  select g.name into group_name from public.community_groups g where g.id = new.group_id;

  for member in
    select m.user_id, m.muted
    from public.community_group_members m
    where m.group_id = new.group_id
      and m.user_id <> new.author_id
  loop
    continue when member.muted;
    continue when not public.message_alerts_on(member.user_id, 'group_messages');

    /* `group_send` already writes a mention notification for the people it
       mentions; the deferral is what lets this check see those rows. */
    continue when exists (
      select 1 from public.notifications n
      where n.user_id = member.user_id
        and n.meta ->> 'messageId' = new.id::text
    );

    perform public.notify_user(
      member.user_id,
      'group',
      coalesce(group_name, 'Group') || ' · ' || coalesce(sender_name, 'Someone'),
      preview,
      '/app/?view=messages&group=' || new.group_id::text || '&message=' || new.id::text,
      jsonb_build_object(
        'messageId', new.id,
        'groupId', new.group_id,
        'groupName', group_name,
        'senderId', new.author_id,
        'senderName', sender_name,
        'kind', 'message'
      )
    );
  end loop;

  return null;
end $$;

revoke all on function public.tg_notify_group_message() from public, anon, authenticated;

/* `community_messages` is shared by public channels and groups, so the trigger
   is on the table and the function returns early for channel rows. */
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'community_messages' and column_name = 'group_id'
  ) then
    drop trigger if exists group_message_notifies on public.community_messages;
    create constraint trigger group_message_notifies
      after insert on public.community_messages
      deferrable initially deferred
      for each row
      execute function public.tg_notify_group_message();
  end if;
end $$;

-- --------------------------------------------------------- 4. what a client reads

comment on trigger team_chat_message_notifies on public.team_chat_messages is
  'Every direct message becomes a notification for the other participants, which is what the Web Push fan-out listens for.';
comment on trigger group_message_notifies on public.community_messages is
  'Every group message becomes a notification for the members who have not muted it.';
