-- 0018 · Business teams, email invites, and private team chat.
-- All privileged mutations are SECURITY DEFINER RPCs. The browser is never
-- trusted for business membership, recipient identity, or message ownership.

alter table public.profiles
  add column if not exists member_type text not null default 'freelancer';

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname = 'profiles_member_type_check'
  ) then
    alter table public.profiles
      add constraint profiles_member_type_check
      check (member_type in ('freelancer', 'agent', 'agency', 'other'));
  end if;
end $$;

create table if not exists public.business_team_invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  invite_email_normalized text not null,
  member_type text not null check (member_type in ('freelancer', 'agent')),
  invited_by uuid references auth.users(id) on delete set null,
  invited_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  unique (id, business_id)
);

create index if not exists business_team_invites_email_idx
  on public.business_team_invites (invite_email_normalized, created_at desc)
  where accepted_at is null and revoked_at is null;
create unique index if not exists business_team_invites_active_unique
  on public.business_team_invites (business_id, invite_email_normalized)
  where accepted_at is null and revoked_at is null;

create table if not exists public.business_team_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_type text not null check (member_type in ('freelancer', 'agent')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index if not exists business_team_members_user_idx
  on public.business_team_members (user_id, business_id);

create or replace function public.is_business_team_member(p_business uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user is not null and exists (
    select 1 from public.businesses b where b.id = p_business and b.owner_id = p_user
    union all
    select 1 from public.business_team_members m where m.business_id = p_business and m.user_id = p_user
  );
$$;
revoke all on function public.is_business_team_member(uuid, uuid) from public, anon;
grant execute on function public.is_business_team_member(uuid, uuid) to authenticated, service_role;

alter table public.business_team_invites enable row level security;
alter table public.business_team_members enable row level security;
drop policy if exists business_team_members_read on public.business_team_members;
create policy business_team_members_read on public.business_team_members
  for select to authenticated
  using (public.is_business_team_member(business_id));
-- Invitations are only returned through exact-email SECURITY DEFINER RPCs.
-- There are deliberately no direct client write policies.

create or replace function public.team_invite_user(p_business uuid, p_email text, p_member_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  normalized text := lower(btrim(coalesce(p_email, '')));
  member_kind text := lower(btrim(coalesce(p_member_type, '')));
  known_user uuid;
  invite_row public.business_team_invites%rowtype;
begin
  if actor is null then raise exception 'Sign in to invite a teammate.' using errcode = '42501'; end if;
  if not exists (select 1 from public.businesses b where b.id = p_business and (b.owner_id = actor or public.is_admin(actor))) then
    raise exception 'Only the business owner can invite team members.' using errcode = '42501';
  end if;
  if normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if member_kind not in ('freelancer', 'agent') then
    raise exception 'Choose Freelancer or Agent.' using errcode = '22023';
  end if;

  select p.id into known_user from public.profiles p where lower(p.email) = normalized limit 1;
  if known_user = actor then raise exception 'You already own this business.' using errcode = '22023'; end if;
  if known_user is not null and exists (
    select 1 from public.business_team_members m where m.business_id = p_business and m.user_id = known_user
  ) then
    return jsonb_build_object('alreadyMember', true, 'userExists', true, 'inviteId', null);
  end if;

  select * into invite_row
    from public.business_team_invites i
   where i.business_id = p_business and i.invite_email_normalized = normalized
     and i.accepted_at is null and i.revoked_at is null
   limit 1;
  if invite_row.id is null then
    insert into public.business_team_invites
      (business_id, invite_email_normalized, member_type, invited_by, invited_user_id)
    values (p_business, normalized, member_kind, actor, known_user)
    returning * into invite_row;
  else
    update public.business_team_invites
       set member_type = member_kind, invited_by = actor, invited_user_id = known_user
     where id = invite_row.id
     returning * into invite_row;
  end if;

  return jsonb_build_object(
    'alreadyMember', false,
    'userExists', known_user is not null,
    'inviteId', invite_row.id,
    'email', invite_row.invite_email_normalized,
    'memberType', invite_row.member_type,
    'role', invite_row.member_type
  );
end;
$$;

create or replace function public.team_search_by_email(p_business uuid, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized text := lower(btrim(coalesce(p_email, '')));
  result jsonb;
begin
  if auth.uid() is null or not public.is_business_team_member(p_business, auth.uid()) then
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', p.id,
    'name', coalesce(nullif(p.full_name, ''), split_part(coalesce(p.email, ''), '@', 1)),
    'email', p.email,
    'memberType', coalesce(p.member_type, 'freelancer')
  )), '[]'::jsonb)
  into result
  from public.profiles p
  where lower(p.email) = normalized;
  return result;
end;
$$;

create or replace function public.team_my_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  mail text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  result jsonb;
begin
  if actor is null or mail = '' then raise exception 'Sign in with a verified email address.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'inviteId', i.id,
    'businessId', i.business_id,
    'businessName', b.name,
    'email', i.invite_email_normalized,
    'memberType', i.member_type,
    'createdAt', i.created_at
  ) order by i.created_at desc), '[]'::jsonb)
  into result
  from public.business_team_invites i
  join public.businesses b on b.id = i.business_id
  where i.invite_email_normalized = mail and i.accepted_at is null and i.revoked_at is null;
  return result;
end;
$$;

create or replace function public.team_accept_invite(p_invite uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  mail text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  invitation public.business_team_invites%rowtype;
begin
  if actor is null or mail = '' then raise exception 'Sign in with the invited email address.' using errcode = '42501'; end if;
  select * into invitation
    from public.business_team_invites i
   where i.id = p_invite and i.invite_email_normalized = mail
     and i.accepted_at is null and i.revoked_at is null
   for update;
  if invitation.id is null then raise exception 'This invitation is unavailable for this email address.' using errcode = '42501'; end if;

  insert into public.business_team_members (business_id, user_id, member_type, invited_by)
  values (invitation.business_id, actor, invitation.member_type, invitation.invited_by)
  on conflict (business_id, user_id) do update set member_type = excluded.member_type;
  update public.business_team_invites
     set accepted_at = now(), invited_user_id = actor
   where id = invitation.id;
  return jsonb_build_object('ok', true, 'businessId', invitation.business_id, 'memberType', invitation.member_type);
end;
$$;

create or replace function public.team_accessible_businesses()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.name), '[]'::jsonb)
  from (
    select distinct b.id, b.name, b.category,
           case when b.owner_id = auth.uid() then 'owner' else m.member_type end as role
      from public.businesses b
      left join public.business_team_members m on m.business_id = b.id and m.user_id = auth.uid()
     where b.owner_id = auth.uid() or m.user_id = auth.uid()
  ) x;
$$;

create or replace function public.team_update_my_profile(p_full_name text, p_member_type text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  kind text := lower(btrim(coalesce(p_member_type, '')));
  saved public.profiles%rowtype;
begin
  if actor is null then raise exception 'Sign in to update your profile.' using errcode = '42501'; end if;
  if kind not in ('freelancer', 'agent', 'agency', 'other') then raise exception 'Choose a valid member role.' using errcode = '22023'; end if;
  update public.profiles
     set full_name = left(btrim(coalesce(p_full_name, '')), 160), member_type = kind, updated_at = now()
   where id = actor
   returning * into saved;
  if saved.id is null then raise exception 'Profile not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('fullName', saved.full_name, 'memberType', saved.member_type);
end;
$$;

create table if not exists public.team_conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind in ('direct', 'group')),
  title text check (char_length(title) <= 160),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists team_conversations_business_idx
  on public.team_conversations (business_id, last_message_at desc);

create table if not exists public.team_conversation_members (
  conversation_id uuid not null references public.team_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);
create index if not exists team_conversation_members_user_idx
  on public.team_conversation_members (user_id, conversation_id);

create or replace function public.is_team_conversation_member(p_conversation uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user is not null and exists (
    select 1 from public.team_conversation_members m
    join public.team_conversations c on c.id = m.conversation_id
    where m.conversation_id = p_conversation and m.user_id = p_user
      and public.is_business_team_member(c.business_id, p_user)
  );
$$;
revoke all on function public.is_team_conversation_member(uuid, uuid) from public, anon;
grant execute on function public.is_team_conversation_member(uuid, uuid) to authenticated, service_role;

create table if not exists public.team_chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.team_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  created_at timestamptz not null default now(),
  check (char_length(body) <= 4000)
);
create index if not exists team_chat_messages_thread_idx
  on public.team_chat_messages (conversation_id, created_at);

alter table public.team_conversations enable row level security;
alter table public.team_conversation_members enable row level security;
alter table public.team_chat_messages enable row level security;
drop policy if exists team_conversations_read on public.team_conversations;
create policy team_conversations_read on public.team_conversations
  for select to authenticated
  using (public.is_team_conversation_member(id));
drop policy if exists team_conversation_members_read on public.team_conversation_members;
create policy team_conversation_members_read on public.team_conversation_members
  for select to authenticated
  using (public.is_team_conversation_member(conversation_id));
drop policy if exists team_chat_messages_read on public.team_chat_messages;
create policy team_chat_messages_read on public.team_chat_messages
  for select to authenticated
  using (public.is_team_conversation_member(conversation_id));
-- There are no direct write policies: all writes go through the RPCs below.

create or replace function public.team_chat_start(p_business uuid, p_participants uuid[], p_title text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  people uuid[];
  person uuid;
  conversation uuid;
  conversation_kind text;
begin
  if actor is null or not public.is_business_team_member(p_business, actor) then
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;
  select array_agg(distinct x order by x) into people
    from unnest(coalesce(p_participants, array[]::uuid[])) x
   where x is not null and x <> actor;
  if people is null or cardinality(people) < 1 then raise exception 'Choose a teammate.' using errcode = '22023'; end if;
  if cardinality(people) > 24 then raise exception 'A team chat can have at most 25 people.' using errcode = '22023'; end if;
  if exists (
    select 1 from unnest(people) p(user_id)
    where not public.is_business_team_member(p_business, p.user_id)
  ) then raise exception 'Every participant must be an active member of this business.' using errcode = '42501'; end if;

  conversation_kind := case when cardinality(people) = 1 then 'direct' else 'group' end;
  if conversation_kind = 'direct' then
    select c.id into conversation
      from public.team_conversations c
      join public.team_conversation_members a on a.conversation_id = c.id and a.user_id = actor
      join public.team_conversation_members b on b.conversation_id = c.id and b.user_id = people[1]
     where c.business_id = p_business and c.kind = 'direct'
       and (select count(*) from public.team_conversation_members x where x.conversation_id = c.id) = 2
     limit 1;
  end if;
  if conversation is null then
    insert into public.team_conversations (business_id, kind, title, created_by)
    values (p_business, conversation_kind, left(nullif(btrim(coalesce(p_title, '')), ''), 160), actor)
    returning id into conversation;
    insert into public.team_conversation_members (conversation_id, user_id, last_read_at)
    values (conversation, actor, now());
    foreach person in array people loop
      insert into public.team_conversation_members (conversation_id, user_id)
      values (conversation, person);
    end loop;
  end if;
  return jsonb_build_object('conversationId', conversation, 'kind', conversation_kind);
end;
$$;

create or replace function public.team_chat_list(p_business uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.is_business_team_member(p_business, auth.uid()) then
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'conversationId', c.id,
    'businessId', c.business_id,
    'kind', c.kind,
    'title', c.title,
    'lastMessageAt', c.last_message_at,
    'unread', (select count(*) from public.team_chat_messages m
      where m.conversation_id = c.id and m.sender_id <> auth.uid()
        and (mine.last_read_at is null or m.created_at > mine.last_read_at)),
    'lastMessage', (select m.body from public.team_chat_messages m where m.conversation_id = c.id order by m.created_at desc limit 1)
  ) order by c.last_message_at desc), '[]'::jsonb)
  into result
  from public.team_conversations c
  join public.team_conversation_members mine on mine.conversation_id = c.id and mine.user_id = auth.uid()
  where c.business_id = p_business and public.is_business_team_member(c.business_id, auth.uid());
  return result;
end;
$$;

create or replace function public.team_chat_thread(p_conversation uuid, p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  conversation public.team_conversations%rowtype;
  result jsonb;
begin
  select * into conversation from public.team_conversations c where c.id = p_conversation;
  if conversation.id is null or actor is null
     or not public.is_business_team_member(conversation.business_id, actor)
     or not exists (select 1 from public.team_conversation_members m where m.conversation_id = p_conversation and m.user_id = actor) then
    raise exception 'Not a member of this conversation.' using errcode = '42501';
  end if;
  update public.team_conversation_members set last_read_at = now()
   where conversation_id = p_conversation and user_id = actor;
  select jsonb_build_object(
    'conversationId', conversation.id,
    'businessId', conversation.business_id,
    'kind', conversation.kind,
    'title', conversation.title,
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
      'userId', m.user_id,
      'name', coalesce(nullif(p.full_name, ''), split_part(coalesce(p.email, ''), '@', 1)),
      'email', p.email,
      'memberType', coalesce(p.member_type, bm.member_type, 'freelancer')
    ) order by p.full_name) from public.team_conversation_members m
      left join public.profiles p on p.id = m.user_id
      left join public.business_team_members bm on bm.business_id = conversation.business_id and bm.user_id = m.user_id
     where m.conversation_id = p_conversation), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
      'id', q.id, 'senderId', q.sender_id, 'body', q.body,
      'attachments', q.attachments, 'createdAt', q.created_at
    ) order by q.created_at) from (
      select m.* from public.team_chat_messages m
       where m.conversation_id = p_conversation order by m.created_at desc
       limit greatest(1, least(coalesce(p_limit, 100), 200))
    ) q), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

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
     or not public.is_business_team_member(conversation.business_id, actor)
     or not exists (select 1 from public.team_conversation_members m where m.conversation_id = p_conversation and m.user_id = actor) then
    raise exception 'Not a member of this conversation.' using errcode = '42501';
  end if;
  if jsonb_typeof(attachment_list) <> 'array' or jsonb_array_length(attachment_list) > 10 then
    raise exception 'Attachments must be a list of up to ten files.' using errcode = '22023';
  end if;
  if char_length(body_text) > 4000 or (body_text = '' and jsonb_array_length(attachment_list) = 0) then
    raise exception 'Write a message or attach a file.' using errcode = '22023';
  end if;
  for attachment in select value from jsonb_array_elements(attachment_list) loop
    if coalesce(attachment->>'mime', '') not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
       or coalesce((attachment->>'size')::bigint, 0) < 1
       or (attachment->>'size')::bigint > 20971520
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

create or replace function public.team_revoke_member(p_business uuid, p_invite uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  invited public.business_team_invites%rowtype;
begin
  if actor is null or not exists (select 1 from public.businesses b where b.id = p_business and (b.owner_id = actor or public.is_admin(actor))) then
    raise exception 'Only the business owner can revoke a team member.' using errcode = '42501';
  end if;
  select * into invited from public.business_team_invites i where i.id = p_invite and i.business_id = p_business for update;
  if invited.id is null then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  update public.business_team_invites set revoked_at = now() where id = invited.id;
  if invited.invited_user_id is not null then
    delete from public.business_team_members where business_id = p_business and user_id = invited.invited_user_id;
  end if;
  return jsonb_build_object('ok', true, 'revokedUserId', invited.invited_user_id);
end;
$$;

-- Only authenticated callers can use the user-facing team RPCs; all direct
-- table writes remain denied by RLS. Service role is included for server-side
-- jobs and tests, never for browser credentials.
revoke all on function public.team_invite_user(uuid, text, text) from public, anon;
revoke all on function public.team_search_by_email(uuid, text) from public, anon;
revoke all on function public.team_my_invitations() from public, anon;
revoke all on function public.team_accept_invite(uuid) from public, anon;
revoke all on function public.team_accessible_businesses() from public, anon;
revoke all on function public.team_update_my_profile(text, text) from public, anon;
revoke all on function public.team_chat_start(uuid, uuid[], text) from public, anon;
revoke all on function public.team_chat_list(uuid) from public, anon;
revoke all on function public.team_chat_thread(uuid, integer) from public, anon;
revoke all on function public.team_chat_send(uuid, text, jsonb) from public, anon;
revoke all on function public.team_revoke_member(uuid, uuid) from public, anon;
grant execute on function public.team_invite_user(uuid, text, text) to authenticated, service_role;
grant execute on function public.team_search_by_email(uuid, text) to authenticated, service_role;
grant execute on function public.team_my_invitations() to authenticated, service_role;
grant execute on function public.team_accept_invite(uuid) to authenticated, service_role;
grant execute on function public.team_accessible_businesses() to authenticated, service_role;
grant execute on function public.team_update_my_profile(text, text) to authenticated, service_role;
grant execute on function public.team_chat_start(uuid, uuid[], text) to authenticated, service_role;
grant execute on function public.team_chat_list(uuid) to authenticated, service_role;
grant execute on function public.team_chat_thread(uuid, integer) to authenticated, service_role;
grant execute on function public.team_chat_send(uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.team_revoke_member(uuid, uuid) to authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-chat-files', 'team-chat-files', false, 20971520,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage keys are conversation/user/filename; a signed-in member can only
-- upload into their own prefix for a conversation they currently belong to.
drop policy if exists team_chat_files_read on storage.objects;
create policy team_chat_files_read on storage.objects
  for select to authenticated
  using (bucket_id = 'team-chat-files'
    and name ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/'
    and public.is_team_conversation_member(split_part(name, '/', 1)::uuid));
drop policy if exists team_chat_files_insert on storage.objects;
create policy team_chat_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'team-chat-files'
    and name ~ ('^[0-9a-fA-F-]{36}/' || auth.uid()::text || '/')
    and public.is_team_conversation_member(split_part(name, '/', 1)::uuid));
-- No update/delete storage policy: uploaded chat files cannot be overwritten
-- or removed by a browser session; retention is handled by an administrator.
