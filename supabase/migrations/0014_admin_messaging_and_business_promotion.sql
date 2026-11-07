-- ============================================================================
-- 0014 · Administrator messaging, business directory and promotion
-- ----------------------------------------------------------------------------
-- Part 1 of the repair brief:
--
--   • every business and every administrator is visible to the Super Admin
--   • a registered business can be promoted to administrator without creating a
--     second account and without losing a single row of its own data
--   • administrators and businesses can hold a real conversation: a list of
--     conversations, timestamps, read/unread state, and history that survives
--     reloads because it lives in the database
--   • an ordinary administrator can read everything and talk to anyone, but
--     cannot delete or downgrade anybody — those paths do not exist here, and
--     the functions that could do it re-check the role in the database
--
-- Nothing in this file trusts the browser. Every write goes through a SECURITY
-- DEFINER function that re-derives the caller from auth.uid(), and every table
-- carries RLS so a direct PostgREST call cannot reach another account's rows.
-- ============================================================================

-- ---------------------------------------------------------------- tables ----
create table if not exists public.admin_conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'direct' check (kind in ('direct', 'group')),
  title text check (char_length(title) <= 160),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.admin_conversation_participants (
  conversation_id uuid not null references public.admin_conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create table if not exists public.admin_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.admin_conversations (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists admin_messages_thread_idx
  on public.admin_messages (conversation_id, created_at);
create index if not exists admin_messages_sender_idx
  on public.admin_messages (sender_id, created_at desc);
create index if not exists admin_participiants_user_idx
  on public.admin_conversation_participants (user_id, conversation_id);

-- ------------------------------------------------------------ membership ----
create or replace function public.is_conversation_member(p_conversation uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.admin_conversation_participants m
    where m.conversation_id = p_conversation and m.user_id = p_user
  );
$$;

revoke all on function public.is_conversation_member(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated, service_role;

-- Keep the conversation ordering honest even if a row arrives by another path.
create or replace function public.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.admin_conversations
     set last_message_at = greatest(last_message_at, new.created_at)
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists admin_messages_touch on public.admin_messages;
create trigger admin_messages_touch
  after insert on public.admin_messages
  for each row execute function public.touch_conversation();

-- ------------------------------------------------------------------- RLS ----
alter table public.admin_conversations enable row level security;
alter table public.admin_conversation_participants enable row level security;
alter table public.admin_messages enable row level security;

drop policy if exists "participants read their conversations" on public.admin_conversations;
create policy "participants read their conversations" on public.admin_conversations
  for select to authenticated
  using (public.is_conversation_member(id));

drop policy if exists "members read the roster" on public.admin_conversation_participants;
create policy "members read the roster" on public.admin_conversation_participants
  for select to authenticated
  using (public.is_conversation_member(conversation_id));

drop policy if exists "members update their own read marker" on public.admin_conversation_participants;
create policy "members update their own read marker" on public.admin_conversation_participants
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "members read their messages" on public.admin_messages;
create policy "members read their messages" on public.admin_messages
  for select to authenticated
  using (public.is_conversation_member(conversation_id));

drop policy if exists "members write as themselves" on public.admin_messages;
create policy "members write as themselves" on public.admin_messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));

-- There is deliberately no update or delete policy on admin_messages, and no
-- delete policy on conversations: a message cannot be rewritten or removed by
-- a client, administrator or otherwise.

-- --------------------------------------------------------------- helpers ----
create or replace function public.admin_peers()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(row order by row->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'userId', a.user_id,
             'name', coalesce(nullif(p.full_name, ''), split_part(coalesce(a.email, ''), '@', 1)),
             'email', a.email,
             'role', a.role,
             'kind', 'admin'
           ) as row
      from public.admin_users a
      left join public.profiles p on p.id = a.user_id
     where a.user_id <> auth.uid()
    union all
    select jsonb_build_object(
             'userId', b.owner_id,
             'name', b.name,
             'email', coalesce(b.email, p.email),
             'role', coalesce(public.admin_role(b.owner_id), 'business'),
             'kind', 'business',
             'businessId', b.id,
             'planDeadline', null
           )
      from public.businesses b
      left join public.profiles p on p.id = b.owner_id
     where b.owner_id is not null and b.owner_id <> auth.uid()
  ) s;
$$;

revoke all on function public.admin_peers() from public;
grant execute on function public.admin_peers() to authenticated, service_role;

-- ------------------------------------------------------- start a thread ----
create or replace function public.messaging_start(p_participants uuid[], p_title text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
  people uuid[];
  existing uuid;
  made uuid;
  other uuid;
begin
  if actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  select array_agg(distinct x) into people
    from unnest(coalesce(p_participants, array[]::uuid[])) x
   where x is not null;

  if people is null or array_length(people, 1) < 1 then
    raise exception 'Choose at least one person to message.' using errcode = '22023';
  end if;

  if array_length(people, 1) > 25 then
    raise exception 'A conversation can hold at most 25 people.' using errcode = '22023';
  end if;

  if actor <> all(people) then
    people := people || actor;
  end if;

  -- Only administrators may open a conversation; a business may reply in one an
  -- administrator started, and may open one addressed to an administrator.
  if not public.is_admin(actor) then
    if not exists (select 1 from public.admin_users a where a.user_id = any(people)) then
      raise exception 'Start a conversation with an administrator.' using errcode = '42501';
    end if;
  end if;

  if array_length(people, 1) = 2 then
    select c.id into existing
      from public.admin_conversations c
     where c.kind = 'direct'
       and (select count(*) from public.admin_conversation_participants m where m.conversation_id = c.id) = 2
       and exists (select 1 from public.admin_conversation_participants m where m.conversation_id = c.id and m.user_id = actor)
       and exists (select 1 from public.admin_conversation_participants m where m.conversation_id = c.id and m.user_id = any(people) and m.user_id <> actor)
     limit 1;
    if existing is not null then
      return jsonb_build_object('conversationId', existing, 'reused', true);
    end if;
  end if;

  insert into public.admin_conversations (kind, title, created_by)
  values (case when array_length(people, 1) = 2 then 'direct' else 'group' end,
          left(nullif(btrim(coalesce(p_title, '')), ''), 160),
          actor)
  returning id into made;

  foreach other in array people loop
    insert into public.admin_conversation_participants (conversation_id, user_id, added_by, last_read_at)
    values (made, other, actor, case when other = actor then now() else null end)
    on conflict do nothing;
  end loop;

  return jsonb_build_object('conversationId', made, 'reused', false);
end;
$$;

revoke all on function public.messaging_start(uuid[], text) from public;
grant execute on function public.messaging_start(uuid[], text) to authenticated, service_role;

-- --------------------------------------------------------- send a message ----
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

  select coalesce(nullif(full_name, ''), split_part(coalesce(email, ''), '@', 1), 'Administrator')
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
            '/admin/?view=chat&c=' || p_conversation::text,
            jsonb_build_object('conversationId', p_conversation, 'messageId', (made->>'id')));
  end loop;

  return made;
end;
$$;

revoke all on function public.messaging_send(uuid, text) from public;
grant execute on function public.messaging_send(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------ read the mailbox ----
create or replace function public.messaging_list()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(row order by (row->>'lastMessageAt') desc)
    from (
      select jsonb_build_object(
               'conversationId', c.id,
               'kind', c.kind,
               'title', coalesce(
                 nullif(c.title, ''),
                 (select string_agg(coalesce(nullif(p.full_name, ''), nullif(b.name, ''), split_part(coalesce(p.email, ''), '@', 1), 'Account'), ', ' order by 1)
                    from public.admin_conversation_participants m
                    left join public.profiles p on p.id = m.user_id
                    left join public.businesses b on b.owner_id = m.user_id
                   where m.conversation_id = c.id and m.user_id <> actor)
               ),
               'lastMessageAt', c.last_message_at,
               'lastMessage', (select m2.body from public.admin_messages m2 where m2.conversation_id = c.id order by m2.created_at desc limit 1),
               'lastSenderId', (select m3.sender_id from public.admin_messages m3 where m3.conversation_id = c.id order by m3.created_at desc limit 1),
               'unread', (select count(*) from public.admin_messages m4
                           where m4.conversation_id = c.id
                             and m4.sender_id <> actor
                             and (mine.last_read_at is null or m4.created_at > mine.last_read_at)),
               'participants', (select count(*) from public.admin_conversation_participants m5 where m5.conversation_id = c.id)
             ) as row
        from public.admin_conversations c
        join public.admin_conversation_participants mine
          on mine.conversation_id = c.id and mine.user_id = actor
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.messaging_list() from public;
grant execute on function public.messaging_list() to authenticated, service_role;

create or replace function public.messaging_thread(p_conversation uuid, p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
  head public.admin_conversations;
begin
  if actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if not public.is_conversation_member(p_conversation, actor) then
    raise exception 'You are not part of that conversation.' using errcode = '42501';
  end if;

  select * into head from public.admin_conversations where id = p_conversation;

  update public.admin_conversation_participants
     set last_read_at = now()
   where conversation_id = p_conversation and user_id = actor;

  return jsonb_build_object(
    'conversationId', p_conversation,
    'kind', head.kind,
    'title', head.title,
    'createdAt', head.created_at,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'userId', m.user_id,
               'name', coalesce(nullif(p.full_name, ''), nullif(b.name, ''), split_part(coalesce(p.email, ''), '@', 1), 'Account'),
               'role', coalesce(public.admin_role(m.user_id), 'business'),
               'lastReadAt', m.last_read_at
             ) order by 2)
        from public.admin_conversation_participants m
        left join public.profiles p on p.id = m.user_id
        left join public.businesses b on b.owner_id = m.user_id
       where m.conversation_id = p_conversation
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'senderId', m.sender_id, 'body', m.body, 'createdAt', m.created_at
             ) order by m.created_at)
        from (
          select * from public.admin_messages
           where conversation_id = p_conversation
           order by created_at desc
           limit greatest(1, least(coalesce(p_limit, 200), 500))
        ) m
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.messaging_thread(uuid, int) from public;
grant execute on function public.messaging_thread(uuid, int) to authenticated, service_role;

create or replace function public.messaging_mark_read(p_conversation uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not public.is_conversation_member(p_conversation, actor) then
    raise exception 'You are not part of that conversation.' using errcode = '42501';
  end if;
  update public.admin_conversation_participants
     set last_read_at = now()
   where conversation_id = p_conversation and user_id = actor;
  return jsonb_build_object('ok', true, 'readAt', now());
end;
$$;

revoke all on function public.messaging_mark_read(uuid) from public;
grant execute on function public.messaging_mark_read(uuid) to authenticated, service_role;

create or replace function public.messaging_unread()
returns int
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(count(*), 0)::int
    from public.admin_messages m
    join public.admin_conversation_participants mine
      on mine.conversation_id = m.conversation_id and mine.user_id = auth.uid()
   where m.sender_id <> auth.uid()
     and (mine.last_read_at is null or m.created_at > mine.last_read_at);
$$;

revoke all on function public.messaging_unread() from public;
grant execute on function public.messaging_unread() to authenticated, service_role;

-- ------------------------------------- one directory for people to talk to ----
create or replace function public.messaging_contacts()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;
  if not public.is_admin(actor) then
    -- A business only ever needs the administrator side of the directory.
    return coalesce((
      select jsonb_agg(row order by row->>'name')
      from (
        select jsonb_build_object(
                 'userId', a.user_id,
                 'name', coalesce(nullif(p.full_name, ''), split_part(coalesce(a.email, ''), '@', 1)),
                 'email', a.email, 'role', a.role, 'kind', 'admin'
               ) row
          from public.admin_users a
          left join public.profiles p on p.id = a.user_id
      ) s
    ), '[]'::jsonb);
  end if;
  return public.admin_peers();
end;
$$;

revoke all on function public.messaging_contacts() from public;
grant execute on function public.messaging_contacts() to authenticated, service_role;

-- -------------------------------------------- business management (Part 1) ----
create or replace function public.admin_businesses(p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
  needle text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if actor is null or not public.is_admin(actor) then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(row order by lower(row->>'name'))
    from (
      select jsonb_build_object(
               'businessId', b.id,
               'name', b.name,
               'status', b.status,
               'stage', b.stage,
               'subdomain', b.subdomain,
               'logoUrl', b.logo_url,
               'location', b.location,
               'ownerId', b.owner_id,
               'ownerName', coalesce(nullif(p.full_name, ''), split_part(coalesce(p.email, b.email, ''), '@', 1)),
               'ownerEmail', coalesce(p.email, b.email),
               'adminRole', public.admin_role(b.owner_id),
               'plan', coalesce(sub.plan, p.plan, 'free'),
               'projects', (select count(*) from public.projects pr where pr.owner_id = b.owner_id),
               'createdAt', b.created_at
             ) row
        from public.businesses b
        left join public.profiles p on p.id = b.owner_id
        left join public.subscriptions sub on sub.user_id = b.owner_id
       where needle is null
          or b.name ilike '%' || needle || '%'
          or coalesce(p.email, b.email, '') ilike '%' || needle || '%'
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_businesses(text) from public;
grant execute on function public.admin_businesses(text) to authenticated, service_role;

/*
  Promotion reuses the account that already exists. It calls set_admin_role(),
  which is the single audited path into public.admin_users: it refuses anyone
  who is not a super administrator, refuses to touch the protected owner, and
  refuses to leave the platform without a super administrator. The business row,
  its projects, payments and documents are untouched — the person simply gains
  the administrator capability on the same user id.
*/
create or replace function public.admin_promote_business(p_business uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
  business_name text;
  already text;
begin
  if actor is null or not public.is_superadmin(actor) then
    raise exception 'Only a super administrator can make an account an administrator.'
      using errcode = '42501';
  end if;
  if p_business is null then
    raise exception 'Choose a business.' using errcode = '22023';
  end if;

  select b.owner_id, b.name into owner, business_name from public.businesses b where b.id = p_business;
  if owner is null then
    raise exception 'That business has no owner account.' using errcode = 'P0002';
  end if;

  select role into already from public.admin_users where user_id = owner;
  if already in ('admin', 'superadmin') then
    return jsonb_build_object('ok', true, 'userId', owner, 'role', already, 'changed', false,
                              'message', 'That account already has administrator access.');
  end if;

  perform public.set_admin_role(
    owner,
    'admin',
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Promoted from business ' || coalesce(business_name, '') )
  );

  return jsonb_build_object('ok', true, 'userId', owner, 'role', 'admin', 'changed', true,
                            'message', 'The business owner now has administrator access on the same account.');
end;
$$;

revoke all on function public.admin_promote_business(uuid, text) from public;
grant execute on function public.admin_promote_business(uuid, text) to authenticated, service_role;

-- --------------------------------------------------------- introspect -------
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'admin_messages'
  ) then
    raise exception '0014 invariant: admin_messages must carry row level security policies';
  end if;
end $$;
