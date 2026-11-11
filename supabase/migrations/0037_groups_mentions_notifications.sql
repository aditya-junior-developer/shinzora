-- 0037 — Groups, roles, mentions, notification preferences and push
--
-- Shinzora already had two kinds of room:
--
--   community_channels + community_messages   public rooms (#general, #projects)
--   team_conversations + team_chat_messages   business rooms and direct messages
--
-- What it never had was a **group**: a room somebody creates, invites people
-- into, and owns. This migration adds groups as a third kind that shares the
-- *same* message table as the public rooms, rather than standing up a second
-- messaging system beside the first. `community_messages` grows a null-
-- `channel_id` (a public room) or a `group_id` (a group), never both, and every
-- existing row keeps working.
--
-- The rules the product asked for, and where each one is enforced:
--
--   • the creator is the owner                              community_groups.owner_id
--   • only owner/admin may change the picture and settings   group_can_manage()
--   • a site administrator gets nothing for free             no is_admin() anywhere
--   • owner promotes/demotes admins                          group_set_role()
--   • ownership only moves by an explicit transfer           group_transfer_owner()
--   • only members read a group's messages                   RLS + group_is_member()
--   • removing a member revokes access on the next statement  same function
--   • mentions are validated against real membership         group_send()
--   • no duplicate notifications for one mention             unique(message,user)
--
-- Idempotent: every object is `if not exists` / `create or replace`, and the
-- backfills are guarded.

begin;

-- ---------------------------------------------------------------------------
-- 1. Groups
-- ---------------------------------------------------------------------------
create table if not exists public.community_groups (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,48}$'),
  name        text not null check (char_length(btrim(name)) between 2 and 80),
  description text check (description is null or char_length(description) <= 500),
  avatar_url  text,
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  /* Group settings, all owner/admin editable. */
  allow_everyone_mentions   boolean not null default true,
  everyone_mentions_admins  boolean not null default false,
  allow_member_invites      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists community_groups_owner_idx on public.community_groups (owner_id);

create table if not exists public.community_group_members (
  group_id     uuid not null references public.community_groups(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member')),
  /* Per-member, per-group: muting the group is a personal choice, not a group
     setting, so it lives on the membership row. */
  muted        boolean not null default false,
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (group_id, user_id)
);

create index if not exists community_group_members_user_idx
  on public.community_group_members (user_id, group_id);

-- ---------------------------------------------------------------------------
-- 2. Membership helpers
--
--     Defined before the policies that call them: a policy's USING clause is
--     validated when it is created, so the function has to exist by then.
--
--     These are the only place the rule "who may do what in a group" is
--     written. Note what is deliberately absent: `is_admin()`. A site
--     administrator who is not a member of a group has no power over it.
-- ---------------------------------------------------------------------------
create or replace function public.group_role_of(p_group uuid, p_user uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.community_group_members m
  where m.group_id = p_group and m.user_id = p_user
  limit 1;
$$;

create or replace function public.group_is_member(p_group uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user is not null and exists (
    select 1 from public.community_group_members m
    where m.group_id = p_group and m.user_id = p_user
  );
$$;

/** Owner or admin — the two roles that may change the group itself. */
create or replace function public.group_can_manage(p_group uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.role in ('owner', 'admin')
       from public.community_group_members m
      where m.group_id = p_group and m.user_id = p_user
      limit 1),
    false
  );
$$;

create or replace function public.group_is_owner(p_group uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.community_groups g
    where g.id = p_group and g.owner_id = p_user
  );
$$;

revoke all on function public.group_role_of(uuid, uuid) from public, anon;
revoke all on function public.group_is_member(uuid, uuid) from public, anon;
revoke all on function public.group_can_manage(uuid, uuid) from public, anon;
revoke all on function public.group_is_owner(uuid, uuid) from public, anon;
grant execute on function public.group_role_of(uuid, uuid) to authenticated, service_role;
grant execute on function public.group_is_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.group_can_manage(uuid, uuid) to authenticated, service_role;
grant execute on function public.group_is_owner(uuid, uuid) to authenticated, service_role;

alter table public.community_groups enable row level security;
alter table public.community_group_members enable row level security;

/* A group's row is visible to its members. The name and picture also have to be
   visible to a non-member who is being invited by username, so the invitation
   RPC carries them explicitly — this policy stays strict. */
/* Both policies call group_is_member() rather than writing the membership
   EXISTS inline. That is not a style choice: a policy on community_group_members
   that selects from community_group_members re-enters itself and Postgres
   answers "infinite recursion detected in policy". The helper is SECURITY
   DEFINER, so it reads the membership table once, outside the policy. */
drop policy if exists community_groups_member_read on public.community_groups;
create policy community_groups_member_read on public.community_groups
  for select to authenticated
  using (public.group_is_member(id, auth.uid()));

drop policy if exists community_group_members_read on public.community_group_members;
create policy community_group_members_read on public.community_group_members
  for select to authenticated
  using (public.group_is_member(group_id, auth.uid()));

-- No direct write policy on either table: every change goes through a checked
-- security-definer function below. `with check (false)` is explicit about it.
drop policy if exists community_groups_no_direct_write on public.community_groups;
create policy community_groups_no_direct_write on public.community_groups
  for all to authenticated using (false) with check (false);

drop policy if exists community_group_members_no_direct_write on public.community_group_members;
create policy community_group_members_no_direct_write on public.community_group_members
  for all to authenticated using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 3. Messages: a public room OR a group, in one table
-- ---------------------------------------------------------------------------
alter table public.community_messages
  add column if not exists group_id uuid references public.community_groups(id) on delete cascade;

/* A group message has no channel. Public-room messages already have one, so the
   column keeps its meaning and the check below keeps the two kinds apart. */
alter table public.community_messages alter column channel_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'community_messages_one_room'
  ) then
    alter table public.community_messages
      add constraint community_messages_one_room
      check (num_nonnulls(channel_id, group_id) = 1);
  end if;
end $$;

create index if not exists community_messages_group_idx
  on public.community_messages (group_id, created_at desc);

/* The old policy let any signed-in visitor read every row. That is right for the
   public rooms and wrong for a group: a group's thread is readable only by its
   members, and removing a member takes effect on their very next query because
   the membership row is gone. */
drop policy if exists "messages readable" on public.community_messages;
create policy "messages readable" on public.community_messages
  for select to authenticated
  using (
    removed_at is null
    and (
      (channel_id is not null)
      or (group_id is not null and public.group_is_member(group_id, auth.uid()))
    )
  );

-- No insert/update/delete policies: writes go through community_send() and
-- group_send() so mentions, membership and notification rules live in one place.

-- ---------------------------------------------------------------------------
-- 4. Mentions
-- ---------------------------------------------------------------------------
create table if not exists public.community_mentions (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references public.community_messages(id) on delete cascade,
  group_id       uuid not null references public.community_groups(id) on delete cascade,
  mentioned_user uuid not null references public.profiles(id) on delete cascade,
  /* 'everyone' rows are the mass mention expanded to each member, which is what
     makes "notify each member exactly once" a unique-index problem. */
  kind           text not null default 'user' check (kind in ('user', 'everyone')),
  created_at     timestamptz not null default now(),
  unique (message_id, mentioned_user)
);

create index if not exists community_mentions_user_idx
  on public.community_mentions (mentioned_user, created_at desc);

alter table public.community_mentions enable row level security;

drop policy if exists community_mentions_read on public.community_mentions;
create policy community_mentions_read on public.community_mentions
  for select to authenticated
  using (
    mentioned_user = auth.uid() or public.group_is_member(group_id, auth.uid())
  );

drop policy if exists community_mentions_no_direct_write on public.community_mentions;
create policy community_mentions_no_direct_write on public.community_mentions
  for all to authenticated using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 5. Notification preferences and push subscriptions
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  group_messages       boolean not null default true,
  group_mentions       boolean not null default true,
  sounds               boolean not null default true,
  desktop_notifications boolean not null default true,
  push_enabled         boolean not null default false,
  updated_at           timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

/* One row per browser/device. `endpoint` is the push service URL and is unique
   across the whole table: the same browser re-subscribing updates its row rather
   than sending the same notification twice. */
create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  failures      integer not null default 0,
  last_success_at timestamptz,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id) where disabled_at is null;

alter table public.push_subscriptions enable row level security;

/* A subscription is a capability to notify somebody. Reading someone else's
   endpoint would let an attacker push to their browser, so the browser may only
   see, add and remove its own — and never the key material of another row. */
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select (id, endpoint, created_at, disabled_at, failures) on public.push_subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Group lifecycle
-- ---------------------------------------------------------------------------
/**
 * Create a group. The caller becomes its owner, in the same transaction as the
 * group row, so a group can never exist without an owner.
 */
create or replace function public.group_create(
  p_name text,
  p_description text default null,
  p_member_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  clean_name text := btrim(coalesce(p_name, ''));
  base_slug text;
  new_slug text;
  attempt int := 0;
  group_row public.community_groups;
  person uuid;
  added int := 0;
begin
  if actor is null then raise exception 'Sign in to create a group.' using errcode = '42501'; end if;
  if char_length(clean_name) < 2 then
    raise exception 'Give the group a name of at least 2 characters.' using errcode = '22023';
  end if;

  base_slug := lower(regexp_replace(clean_name, '[^a-zA-Z0-9]+', '-', 'g'));
  base_slug := btrim(base_slug, '-');
  if base_slug = '' then base_slug := 'group'; end if;
  base_slug := left(base_slug, 40);

  /* Slugs are unique and human-readable; collisions get a counter, not a uuid,
     because the slug appears in the URL of a shared message link. */
  loop
    attempt := attempt + 1;
    new_slug := case when attempt = 1 then base_slug else base_slug || '-' || attempt::text end;
    exit when not exists (select 1 from public.community_groups g where g.slug = new_slug);
    if attempt > 50 then
      new_slug := base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
      exit;
    end if;
  end loop;

  insert into public.community_groups (slug, name, description, owner_id)
  values (new_slug, left(clean_name, 80), nullif(left(btrim(coalesce(p_description, '')), 500), ''), actor)
  returning * into group_row;

  insert into public.community_group_members (group_id, user_id, role)
  values (group_row.id, actor, 'owner');

  /* Invited people must already exist as accounts; an unknown id is skipped and
     reported rather than failing the whole group. */
  foreach person in array coalesce(p_member_ids, '{}'::uuid[]) loop
    if person = actor then continue; end if;
    if not exists (select 1 from public.profiles pr where pr.id = person) then continue; end if;
    insert into public.community_group_members (group_id, user_id, role)
    values (group_row.id, person, 'member')
    on conflict (group_id, user_id) do nothing;
    get diagnostics added = row_count;
    if added > 0 then
      perform public.notify_user(
        person, 'group', 'Added to a group',
        left(clean_name, 120) || ' — you were added by the owner.',
        '/app/?view=messages&group=' || group_row.id::text,
        jsonb_build_object('groupId', group_row.id, 'groupName', clean_name)
      );
    end if;
  end loop;

  return jsonb_build_object(
    'id', group_row.id, 'slug', group_row.slug, 'name', group_row.name,
    'description', group_row.description, 'role', 'owner'
  );
end $$;

revoke all on function public.group_create(text, text, uuid[]) from public, anon;
grant execute on function public.group_create(text, text, uuid[]) to authenticated;

/**
 * The caller's groups, with the numbers a list needs: unread count, member count
 * and the last message. One query, not one per row.
 */
create or replace function public.group_my_groups()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  rows jsonb;
begin
  if actor is null then raise exception 'Sign in to see your groups.' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(item order by item->>'lastMessageAt' desc nulls last, item->>'name'), '[]'::jsonb)
    into rows
  from (
    select jsonb_build_object(
      'id', g.id,
      'slug', g.slug,
      'name', g.name,
      'description', g.description,
      'avatarUrl', g.avatar_url,
      'ownerId', g.owner_id,
      'role', me.role,
      'muted', me.muted,
      'memberCount', (select count(*) from public.community_group_members x where x.group_id = g.id),
      'unread', (
        select count(*) from public.community_messages m
        where m.group_id = g.id
          and m.removed_at is null
          and m.author_id <> actor
          and (me.last_read_at is null or m.created_at > me.last_read_at)
      ),
      'lastMessageAt', (select max(m.created_at) from public.community_messages m where m.group_id = g.id),
      'lastMessage', (
        select left(coalesce(nullif(btrim(m.body), ''), 'Attachment'), 120)
        from public.community_messages m
        where m.group_id = g.id and m.removed_at is null
        order by m.created_at desc limit 1
      ),
      'lastSender', (
        select p.full_name from public.community_messages m
        join public.profiles p on p.id = m.author_id
        where m.group_id = g.id and m.removed_at is null
        order by m.created_at desc limit 1
      )
    ) as item
    from public.community_groups g
    join public.community_group_members me on me.group_id = g.id and me.user_id = actor
  ) s;

  return rows;
end $$;

revoke all on function public.group_my_groups() from public, anon;
grant execute on function public.group_my_groups() to authenticated;

/** One group: its settings, the caller's own role, and every member with theirs. */
create or replace function public.group_get(p_group uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  group_row public.community_groups;
  my_role text;
begin
  if actor is null then raise exception 'Sign in to open a group.' using errcode = '42501'; end if;
  select * into group_row from public.community_groups g where g.id = p_group;
  if group_row.id is null then raise exception 'That group does not exist.' using errcode = 'P0002'; end if;

  my_role := public.group_role_of(p_group, actor);
  if my_role is null then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', group_row.id,
    'slug', group_row.slug,
    'name', group_row.name,
    'description', group_row.description,
    'avatarUrl', group_row.avatar_url,
    'ownerId', group_row.owner_id,
    'role', my_role,
    'canManage', my_role in ('owner', 'admin'),
    'isOwner', my_role = 'owner',
    'allowEveryoneMentions', group_row.allow_everyone_mentions,
    'everyoneMentionsAdmins', group_row.everyone_mentions_admins,
    'allowMemberInvites', group_row.allow_member_invites,
    'createdAt', group_row.created_at,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', m.user_id,
        'name', p.full_name,
        'username', p.username,
        'avatarUrl', p.avatar_url,
        'role', m.role,
        'joinedAt', m.joined_at,
        'muted', m.muted,
        'lastSeenAt', p.last_seen_at
      ) order by
        case m.role when 'owner' then 0 when 'admin' then 1 else 2 end,
        coalesce(p.full_name, p.username))
      from public.community_group_members m
      join public.profiles p on p.id = m.user_id
      where m.group_id = p_group
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.group_get(uuid) from public, anon;
grant execute on function public.group_get(uuid) to authenticated;

/**
 * Change the name, description, picture or settings.
 *
 * Owner and admins only — this is the function the "regular members must not be
 * able to change the group picture" requirement lands on. The check is here, in
 * the database, so hiding a button is not what protects the picture.
 */
create or replace function public.group_update(
  p_group uuid,
  p_name text default null,
  p_description text default null,
  p_avatar_url text default null,
  p_allow_everyone_mentions boolean default null,
  p_everyone_mentions_admins boolean default null,
  p_allow_member_invites boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  group_row public.community_groups;
begin
  if actor is null then raise exception 'Sign in to change a group.' using errcode = '42501'; end if;
  if not public.group_can_manage(p_group, actor) then
    raise exception 'Only the group owner or a group admin can change this group.' using errcode = '42501';
  end if;

  select * into group_row from public.community_groups g where g.id = p_group;
  if group_row.id is null then raise exception 'That group does not exist.' using errcode = 'P0002'; end if;

  if p_name is not null and char_length(btrim(p_name)) < 2 then
    raise exception 'A group name needs at least 2 characters.' using errcode = '22023';
  end if;

  /* Only http(s) or a same-origin path is accepted as a picture. A stored avatar
     URL is rendered into a src on several screens; `javascript:` must not get
     in through a settings form. */
  if p_avatar_url is not null and p_avatar_url <> ''
     and p_avatar_url !~ '^(https?://|/)' then
    raise exception 'That does not look like an image address.' using errcode = '22023';
  end if;

  update public.community_groups g
     set name = coalesce(nullif(btrim(p_name), ''), g.name),
         description = case when p_description is null then g.description
                            else nullif(left(btrim(p_description), 500), '') end,
         avatar_url = case when p_avatar_url is null then g.avatar_url
                           else nullif(btrim(p_avatar_url), '') end,
         allow_everyone_mentions = coalesce(p_allow_everyone_mentions, g.allow_everyone_mentions),
         everyone_mentions_admins = coalesce(p_everyone_mentions_admins, g.everyone_mentions_admins),
         allow_member_invites = coalesce(p_allow_member_invites, g.allow_member_invites),
         updated_at = now()
   where g.id = p_group;

  return public.group_get(p_group);
end $$;

revoke all on function public.group_update(uuid, text, text, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.group_update(uuid, text, text, text, boolean, boolean, boolean) to authenticated;

/**
 * Move ownership. Explicit, owner-only, and the only way the owner_id changes.
 * The old owner becomes an admin rather than being dropped from the group.
 */
create or replace function public.group_transfer_owner(p_group uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  if not public.group_is_owner(p_group, actor) then
    raise exception 'Only the owner can hand over a group.' using errcode = '42501';
  end if;
  if not public.group_is_member(p_group, p_user) then
    raise exception 'That person has to be in the group first.' using errcode = '22023';
  end if;
  if p_user = actor then return public.group_get(p_group); end if;

  update public.community_groups set owner_id = p_user, updated_at = now() where id = p_group;
  update public.community_group_members set role = 'admin' where group_id = p_group and user_id = actor;
  update public.community_group_members set role = 'owner' where group_id = p_group and user_id = p_user;

  perform public.notify_user(
    p_user, 'group', 'You now own a group',
    (select name from public.community_groups where id = p_group) || ' — ownership was handed to you.',
    '/app/?view=messages&group=' || p_group::text,
    jsonb_build_object('groupId', p_group)
  );

  return public.group_get(p_group);
end $$;

revoke all on function public.group_transfer_owner(uuid, uuid) from public, anon;
grant execute on function public.group_transfer_owner(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Member management
-- ---------------------------------------------------------------------------
create or replace function public.group_add_member(p_group uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  my_role text;
  group_name text;
  inserted int := 0;
begin
  if actor is null then raise exception 'Sign in to add somebody.' using errcode = '42501'; end if;
  my_role := public.group_role_of(p_group, actor);
  if my_role is null then raise exception 'You are not in that group.' using errcode = '42501'; end if;

  select name into group_name from public.community_groups where id = p_group;
  if group_name is null then raise exception 'That group does not exist.' using errcode = 'P0002'; end if;

  /* Owners and admins always may. A regular member may invite only when the group
     allows it — a setting, not an assumption. */
  if my_role = 'member' and not coalesce(
    (select allow_member_invites from public.community_groups where id = p_group), false
  ) then
    raise exception 'Only the owner or an admin can add members to this group.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user) then
    raise exception 'No account with that id.' using errcode = 'P0002';
  end if;

  insert into public.community_group_members (group_id, user_id, role)
  values (p_group, p_user, 'member')
  on conflict (group_id, user_id) do nothing;
  get diagnostics inserted = row_count;

  if inserted > 0 then
    perform public.notify_user(
      p_user, 'group', 'Added to a group',
      left(group_name, 120) || ' — added by a group admin.',
      '/app/?view=messages&group=' || p_group::text,
      jsonb_build_object('groupId', p_group)
    );
  end if;

  return jsonb_build_object('added', inserted > 0, 'role', 'member');
end $$;

revoke all on function public.group_add_member(uuid, uuid) from public, anon;
grant execute on function public.group_add_member(uuid, uuid) to authenticated;

/**
 * Remove somebody.
 *
 *   • the owner cannot be removed — hand ownership over first
 *   • an admin cannot remove another admin; only the owner can
 *   • an admin cannot remove the owner
 *   • anybody may remove themselves (that is group_leave)
 *
 * The membership row is the access: the next `select` on that group's messages
 * fails the policy, so revocation is immediate rather than eventual.
 */
create or replace function public.group_remove_member(p_group uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  my_role text := public.group_role_of(p_group, actor);
  their_role text := public.group_role_of(p_group, p_user);
  group_name text;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  if my_role is null then raise exception 'You are not in that group.' using errcode = '42501'; end if;
  if their_role is null then raise exception 'That person is not in this group.' using errcode = 'P0002'; end if;

  select name into group_name from public.community_groups where id = p_group;

  if their_role = 'owner' then
    raise exception 'The owner cannot be removed. Hand over ownership first.' using errcode = '42501';
  end if;

  if p_user <> actor then
    if my_role = 'member' then
      raise exception 'Only the owner or an admin can remove members.' using errcode = '42501';
    end if;
    if my_role = 'admin' and their_role = 'admin' then
      raise exception 'An admin cannot remove another admin.' using errcode = '42501';
    end if;
  end if;

  delete from public.community_group_members
   where group_id = p_group and user_id = p_user;

  if p_user <> actor then
    perform public.notify_user(
      p_user, 'group', 'Removed from a group',
      left(coalesce(group_name, 'A group'), 120) || ' — you no longer have access to its messages.',
      '/app/?view=messages',
      jsonb_build_object('groupId', p_group)
    );
  end if;

  return jsonb_build_object('removed', true);
end $$;

revoke all on function public.group_remove_member(uuid, uuid) from public, anon;
grant execute on function public.group_remove_member(uuid, uuid) to authenticated;

/**
 * Promote or demote an admin. Owner only: the requirement is that the *owner*
 * hands out and revokes admin rights, so an admin cannot grow the set of admins.
 */
create or replace function public.group_set_role(p_group uuid, p_user uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  target text := lower(btrim(coalesce(p_role, '')));
  their_role text := public.group_role_of(p_group, p_user);
  group_name text;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  if not public.group_is_owner(p_group, actor) then
    raise exception 'Only the group owner can change roles.' using errcode = '42501';
  end if;
  if target not in ('admin', 'member') then
    raise exception 'A role is either admin or member. Ownership moves with the transfer action.' using errcode = '22023';
  end if;
  if their_role is null then raise exception 'That person is not in this group.' using errcode = 'P0002'; end if;
  if their_role = 'owner' then
    raise exception 'The owner is already the owner.' using errcode = '22023';
  end if;

  select name into group_name from public.community_groups where id = p_group;

  update public.community_group_members
     set role = target
   where group_id = p_group and user_id = p_user;

  perform public.notify_user(
    p_user, 'group',
    case when target = 'admin' then 'You are now a group admin' else 'Group admin removed' end,
    left(coalesce(group_name, 'A group'), 120),
    '/app/?view=messages&group=' || p_group::text,
    jsonb_build_object('groupId', p_group, 'role', target)
  );

  return jsonb_build_object('userId', p_user, 'role', target);
end $$;

revoke all on function public.group_set_role(uuid, uuid, text) from public, anon;
grant execute on function public.group_set_role(uuid, uuid, text) to authenticated;

/** Leave. The owner may only leave an empty group; otherwise they sabotage it. */
create or replace function public.group_leave(p_group uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  others int;
begin
  if actor is null then raise exception 'Sign in to leave a group.' using errcode = '42501'; end if;
  if not public.group_is_member(p_group, actor) then
    raise exception 'You are not in that group.' using errcode = '42501';
  end if;

  if public.group_is_owner(p_group, actor) then
    select count(*) into others from public.community_group_members
     where group_id = p_group and user_id <> actor;
    if others > 0 then
      raise exception 'Hand over ownership before leaving — this group still has members.' using errcode = '22023';
    end if;
    delete from public.community_groups where id = p_group and owner_id = actor;
    return jsonb_build_object('left', true, 'deleted', true);
  end if;

  delete from public.community_group_members where group_id = p_group and user_id = actor;
  return jsonb_build_object('left', true, 'deleted', false);
end $$;

revoke all on function public.group_leave(uuid) from public, anon;
grant execute on function public.group_leave(uuid) to authenticated;

/** Per-member mute. Personal, so any member may set their own. */
create or replace function public.group_set_muted(p_group uuid, p_muted boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  if not public.group_is_member(p_group, actor) then
    raise exception 'You are not in that group.' using errcode = '42501';
  end if;
  update public.community_group_members
     set muted = coalesce(p_muted, false)
   where group_id = p_group and user_id = actor;
  return jsonb_build_object('muted', coalesce(p_muted, false));
end $$;

revoke all on function public.group_set_muted(uuid, boolean) from public, anon;
grant execute on function public.group_set_muted(uuid, boolean) to authenticated;

/* Mark everything up to now as read, for the unread badge. */
create or replace function public.group_mark_read(p_group uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then return; end if;
  update public.community_group_members
     set last_read_at = now()
   where group_id = p_group and user_id = actor;
end $$;

revoke all on function public.group_mark_read(uuid) from public, anon;
grant execute on function public.group_mark_read(uuid) to authenticated;

/**
 * The @autocomplete list: real members of *this* group, and nobody else.
 * A non-member gets nothing back, so the list cannot be used to enumerate a
 * group's membership from outside.
 */
create or replace function public.group_mention_candidates(p_group uuid, p_query text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  term text := lower(btrim(coalesce(p_query, '')));
begin
  if actor is null or not public.group_is_member(p_group, actor) then
    raise exception 'You are not in that group.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId', m.user_id,
      'name', p.full_name,
      'username', p.username,
      'avatarUrl', p.avatar_url,
      'role', m.role
    ) order by coalesce(p.full_name, p.username))
    from public.community_group_members m
    join public.profiles p on p.id = m.user_id
    where m.group_id = p_group
      and p.username is not null
      and (
        term = ''
        or lower(p.username) like term || '%'
        or lower(coalesce(p.full_name, '')) like '%' || term || '%'
      )
    limit 30
  ), '[]'::jsonb);
end $$;

revoke all on function public.group_mention_candidates(uuid, text) from public, anon;
grant execute on function public.group_mention_candidates(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Sending, with mentions
-- ---------------------------------------------------------------------------
/**
 * Post into a group and fan the mentions out.
 *
 * The mention rules, all enforced here rather than in the browser:
 *
 *   • `@username` is resolved against the *group's* members. A mention of
 *     somebody outside the group is ignored — it cannot notify them, and it
 *     cannot reveal that the group exists.
 *   • `@everyone` / `@all` requires the group setting, and optionally the owner
 *     or admin role; a regular member's mass mention is refused outright rather
 *     than silently dropped, so the UI can explain it.
 *   • Notification rows are keyed by (message, user): a mention of the same
 *     person twice in one message is one notification, not two.
 *   • A member who muted the group still receives *mention* notifications (the
 *     mute is about chatter, not about being called out) but not ordinary ones.
 */
create or replace function public.group_send(p_group uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  clean text := left(coalesce(p_body, ''), 4000);
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
  if char_length(btrim(clean)) = 0 then
    raise exception 'Write something first.' using errcode = '22023';
  end if;

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

  insert into public.community_messages (group_id, author_id, body)
  values (p_group, actor, clean)
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
          left(split_part(clean, E'\n', 1), 160),
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
          left(split_part(clean, E'\n', 1), 160),
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
      left(split_part(clean, E'\n', 1), 160),
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

  return jsonb_build_object('id', new_message_id, 'createdAt', now());
end $$;

revoke all on function public.group_send(uuid, text) from public, anon;
grant execute on function public.group_send(uuid, text) to authenticated;

/** The thread. Membership is checked before a single row is returned. */
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
      'mentions', x.mentions,
      'attachment', null
    ) order by x.created_at)
    from (
      select m.id, m.body, m.created_at, m.author_id,
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
-- 9. Preferences and push subscriptions
-- ---------------------------------------------------------------------------
create or replace function public.notification_prefs_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  row_pref public.notification_preferences;
begin
  if actor is null then raise exception 'Sign in to see your settings.' using errcode = '42501'; end if;
  select * into row_pref from public.notification_preferences where user_id = actor;
  return jsonb_build_object(
    'groupMessages', coalesce(row_pref.group_messages, true),
    'groupMentions', coalesce(row_pref.group_mentions, true),
    'sounds', coalesce(row_pref.sounds, true),
    'desktopNotifications', coalesce(row_pref.desktop_notifications, true),
    'pushEnabled', coalesce(row_pref.push_enabled, false),
    'mutedGroups', coalesce((
      select jsonb_agg(m.group_id) from public.community_group_members m
      where m.user_id = actor and m.muted
    ), '[]'::jsonb),
    'devices', coalesce((
      select count(*) from public.push_subscriptions s
      where s.user_id = actor and s.disabled_at is null
    ), 0)
  );
end $$;

revoke all on function public.notification_prefs_get() from public, anon;
grant execute on function public.notification_prefs_get() to authenticated;

create or replace function public.notification_prefs_set(
  p_group_messages boolean default null,
  p_group_mentions boolean default null,
  p_sounds boolean default null,
  p_desktop_notifications boolean default null,
  p_push_enabled boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to save your settings.' using errcode = '42501'; end if;

  insert into public.notification_preferences (user_id)
  values (actor)
  on conflict (user_id) do nothing;

  update public.notification_preferences
     set group_messages = coalesce(p_group_messages, group_messages),
         group_mentions = coalesce(p_group_mentions, group_mentions),
         sounds = coalesce(p_sounds, sounds),
         desktop_notifications = coalesce(p_desktop_notifications, desktop_notifications),
         push_enabled = coalesce(p_push_enabled, push_enabled),
         updated_at = now()
   where user_id = actor;

  return public.notification_prefs_get();
end $$;

revoke all on function public.notification_prefs_set(boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.notification_prefs_set(boolean, boolean, boolean, boolean, boolean) to authenticated;

/**
 * Store this browser's push subscription.
 *
 * Re-subscribing from the same browser replaces the row (endpoint is unique), so
 * a browser that rotates its keys is not notified twice. A previously disabled
 * subscription that comes back is re-enabled and its failure count cleared.
 */
create or replace function public.push_subscribe(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to subscribe.' using errcode = '42501'; end if;
  if coalesce(btrim(p_endpoint), '') = '' or coalesce(btrim(p_p256dh), '') = '' or coalesce(btrim(p_auth), '') = '' then
    raise exception 'That subscription is incomplete.' using errcode = '22023';
  end if;
  if p_endpoint !~ '^https://' then
    raise exception 'A push endpoint must be an https URL.' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (actor, p_endpoint, p_p256dh, p_auth, left(coalesce(p_user_agent, ''), 300))
  on conflict (endpoint) do update
    set user_id = actor,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        user_agent = excluded.user_agent,
        disabled_at = null,
        failures = 0;

  insert into public.notification_preferences (user_id, push_enabled)
  values (actor, true)
  on conflict (user_id) do update set push_enabled = true, updated_at = now();

  return jsonb_build_object('ok', true, 'devices', (
    select count(*) from public.push_subscriptions where user_id = actor and disabled_at is null
  ));
end $$;

revoke all on function public.push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.push_subscribe(text, text, text, text) to authenticated;

create or replace function public.push_unsubscribe(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  delete from public.push_subscriptions
   where endpoint = p_endpoint and user_id = actor;
  return jsonb_build_object('ok', true, 'devices', (
    select count(*) from public.push_subscriptions where user_id = actor and disabled_at is null
  ));
end $$;

revoke all on function public.push_unsubscribe(text) from public, anon;
grant execute on function public.push_unsubscribe(text) to authenticated;

/* The push sender (an Edge Function with the service role) records the outcome
   of each attempt here, so an endpoint the push service has retired is disabled
   instead of retried forever. Only the service role may call it. */
create or replace function public.push_mark_result(p_endpoint text, p_status integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status in (404, 410) then
    update public.push_subscriptions
       set disabled_at = now(), failures = failures + 1
     where endpoint = p_endpoint;
  elsif p_status >= 200 and p_status < 300 then
    update public.push_subscriptions
       set failures = 0, last_success_at = now()
     where endpoint = p_endpoint;
  else
    update public.push_subscriptions
       set failures = failures + 1
     where endpoint = p_endpoint;
  end if;
end $$;

revoke all on function public.push_mark_result(text, integer) from public, anon, authenticated;
grant execute on function public.push_mark_result(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Seed nothing, fake nothing
--
--     There is deliberately no INSERT into community_groups here. A group that
--     appears in somebody's list because a migration made it would be the exact
--     seeded-demo-data problem the product rules forbid.
-- ---------------------------------------------------------------------------

commit;
