-- ============================================================================
-- 0015 · Two production bugs found by exercising 0014 for real
-- ----------------------------------------------------------------------------
-- 1. public.set_admin_role() revoked a role by writing profiles.role = 'owner'.
--    profiles.role only allows 'customer', 'admin' or 'staff', so every revoke
--    raised 23514 and the administrator stayed an administrator. The role is
--    now put back to 'customer', which is what a revoked account is.
--
-- 2. public.messaging_send() pointed every recipient at /admin/. A business
--    user cannot open the console, so the notification link went nowhere. The
--    link now follows the recipient's own role.
--
-- Both are CREATE OR REPLACE of functions that already exist; no data is
-- rewritten here.
-- ============================================================================

create or replace function public.set_admin_role(p_user uuid, p_role text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
  wanted text := lower(coalesce(p_role, ''));
  previous text;
  previous_protected boolean := false;
  remaining int;
  before_row jsonb;
  after_row jsonb;
begin
  if actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  if not public.is_superadmin(actor) then
    raise exception 'Only a super administrator can change administrator roles.'
      using errcode = '42501';
  end if;

  if wanted not in ('admin', 'superadmin', 'none') then
    raise exception 'Role must be admin, superadmin or none.' using errcode = '22023';
  end if;

  if p_user is null then
    raise exception 'A user id is required.' using errcode = '22023';
  end if;

  select role, protected into previous, previous_protected
    from public.admin_users where user_id = p_user;

  if previous is null and wanted = 'none' then
    raise exception 'That account is not an administrator.' using errcode = 'P0002';
  end if;

  select to_jsonb(a) into before_row from public.admin_users a where a.user_id = p_user;

  if previous_protected and wanted <> 'superadmin' then
    raise exception 'The protected owner account cannot be demoted or revoked.'
      using errcode = '42501';
  end if;

  if previous = 'superadmin' and wanted <> 'superadmin' then
    select count(*)::int into remaining from public.admin_users where role = 'superadmin' and user_id <> p_user;
    if remaining < 1 then
      raise exception 'This is the last super administrator. Promote another account first.'
        using errcode = '42501';
    end if;
  end if;

  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'No account exists for that user id.' using errcode = 'P0002';
  end if;

  if wanted = 'none' then
    delete from public.admin_users where user_id = p_user;
    /* 'owner' is not a value profiles.role accepts. A revoked administrator is
       an ordinary customer again, and the business row it may own is untouched. */
    update public.profiles set role = 'customer', updated_at = now() where id = p_user;
  else
    insert into public.admin_users as a (user_id, email, role, granted_by, granted_at, updated_at)
    values (
      p_user,
      (select coalesce(email, '') from public.profiles where id = p_user),
      wanted, actor, now(), now()
    )
    on conflict (user_id) do update
      set role = excluded.role,
          email = excluded.email,
          updated_at = now()
      where a.protected = false;

    if not exists (select 1 from public.admin_users where user_id = p_user and role = wanted) then
      raise exception 'The protected owner account cannot be demoted or revoked.'
        using errcode = '42501';
    end if;

    /* A business owner keeps their business; profiles.role only records that the
       account may enter the console. */
    update public.profiles set role = 'admin', updated_at = now() where id = p_user;
  end if;

  select to_jsonb(a) into after_row from public.admin_users a where a.user_id = p_user;

  perform public.write_admin_audit(
    case when wanted = 'none' then 'admin.revoke' else 'admin.set_role' end,
    'admin_users', p_user, p_reason, before_row, after_row
  );

  insert into public.customer_activity (user_id, action, entity_type, entity_id, meta)
  values (p_user, 'admin.role_changed', 'admin_users', p_user::text,
          jsonb_build_object('from', previous, 'to', wanted, 'actor', actor));

  return jsonb_build_object(
    'user_id', p_user,
    'previous', previous,
    'role', wanted,
    'ok', true
  );
end;
$$;

revoke all on function public.set_admin_role(uuid, text, text) from public;
grant execute on function public.set_admin_role(uuid, text, text) to authenticated, service_role;

create or replace function public.messaging_send(p_conversation uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
  text_body text := btrim(coalesce(p_body, ''));
  made jsonb;
  recipient record;
  sender_name text;
begin
  if actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if p_conversation is null or not public.is_conversation_member(p_conversation, actor) then
    raise exception 'You are not part of that conversation.' using errcode = '42501';
  end if;
  if char_length(text_body) = 0 then
    raise exception 'Write a message first.' using errcode = '22023';
  end if;
  if char_length(text_body) > 4000 then
    raise exception 'A message can be at most 4000 characters.' using errcode = '22023';
  end if;

  insert into public.admin_messages (conversation_id, sender_id, body)
  values (p_conversation, actor, text_body)
  returning jsonb_build_object(
    'id', id, 'conversationId', conversation_id, 'senderId', sender_id,
    'body', body, 'createdAt', created_at
  ) into made;

  update public.admin_conversation_participants
     set last_read_at = now()
   where conversation_id = p_conversation and user_id = actor;

  select coalesce(nullif(full_name, ''), split_part(coalesce(email, ''), '@', 1), 'Shinzora')
    into sender_name
    from public.profiles where id = actor;

  for recipient in
    select m.user_id from public.admin_conversation_participants m
     where m.conversation_id = p_conversation and m.user_id <> actor
  loop
    insert into public.notifications (user_id, title, body, type, link, meta)
    values (recipient.user_id,
            'New message from ' || coalesce(sender_name, 'Shinzora'),
            left(text_body, 200),
            'message',
            case when public.is_admin(recipient.user_id)
                 then '/admin/?view=chat&c=' || p_conversation::text
                 else '/app/?view=messages&c=' || p_conversation::text
            end,
            jsonb_build_object('conversationId', p_conversation, 'messageId', (made->>'id')));
  end loop;

  return made;
end;
$$;

revoke all on function public.messaging_send(uuid, text) from public;
grant execute on function public.messaging_send(uuid, text) to authenticated, service_role;
