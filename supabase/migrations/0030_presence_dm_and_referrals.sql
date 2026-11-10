-- ============================================================================
-- 0030 · Presence, direct messages between any two members, and referrals.
-- ----------------------------------------------------------------------------
-- Three additions, no rewrites:
--
--   1. Presence. `profiles.last_seen_at` is written by a heartbeat RPC the
--      dashboard calls while the tab is visible. Nothing reads it back except
--      the people who can already see that profile, so it is not a new
--      disclosure surface — it is the same "last active" the admin console
--      already shows from last_sign_in_at, but fresh.
--
--   2. Direct messages. Team conversations were business-scoped: you could only
--      message somebody you shared a business with. A conversation with
--      business_id NULL is now a personal one between exactly two members, and
--      membership of the conversation is the whole permission. Business
--      conversations keep their business check unchanged.
--
--   3. Referrals. A member's code invites another member; both sides get 10
--      bonus AI credits a month for three months. The first month is granted
--      at redemption, the following two by `referral_bonus_tick()`, which the
--      dashboard calls on load — the same pattern the AI quota rollover uses.
-- ============================================================================

/* ------------------------------------------------------------------ presence */

alter table public.profiles add column if not exists last_seen_at timestamptz;

create index if not exists profiles_last_seen_idx on public.profiles (last_seen_at desc);

/**
 * The heartbeat. Called by the dashboard every minute while the tab is visible.
 * Writes only the caller's own row, so there is nothing to authorise beyond
 * being signed in.
 */
create or replace function public.presence_touch()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  stamped timestamptz := now();
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  update public.profiles set last_seen_at = stamped where id = actor;
  return stamped;
end;
$$;

revoke all on function public.presence_touch() from public, anon;
grant execute on function public.presence_touch() to authenticated, service_role;

/**
 * Presence for a set of members, readable by anyone signed in — it returns a
 * timestamp and nothing else. Used by the team list and by message threads that
 * already expose the same people.
 */
create or replace function public.presence_for(p_users uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(p.id::text, p.last_seen_at), '{}'::jsonb)
    from public.profiles p
   where p.id = any(coalesce(p_users, array[]::uuid[]));
$$;

revoke all on function public.presence_for(uuid[]) from public, anon;
grant execute on function public.presence_for(uuid[]) to authenticated, service_role;

/* ------------------------------------------------------- direct messaging */

/* A personal conversation has no business. The column was NOT NULL, which is
   what made a message to a stranger impossible. */
alter table public.team_conversations alter column business_id drop not null;

create index if not exists team_conversations_personal_idx
  on public.team_conversations (last_message_at desc)
  where business_id is null;

/* Membership is the permission. For a business conversation the business check
   still applies on top, so removing somebody from a team still closes their
   access to that team's rooms. */
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
      and (c.business_id is null or public.is_business_team_member(c.business_id, p_user))
  );
$$;

revoke all on function public.is_team_conversation_member(uuid, uuid) from public, anon;
grant execute on function public.is_team_conversation_member(uuid, uuid) to authenticated, service_role;

/* ------------------------------------------------------------------ search
   By handle and by name. Never by email: an address is not a public
   identifier, and the owner chose the handle for exactly this. */
create or replace function public.dm_search_people(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  q text := lower(btrim(coalesce(p_query, '')));
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to search people.' using errcode = '42501'; end if;
  q := ltrim(q, '@');
  if char_length(q) < 2 then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.rank, x.full_name), '[]'::jsonb)
    into result
    from (
      select p.id as "userId",
             p.full_name as "fullName",
             p.username,
             p.avatar_url as "avatarUrl",
             coalesce(p.account_type, 'owner') as "accountType",
             p.last_seen_at as "lastSeenAt",
             case when lower(coalesce(p.username, '')) = q then 0
                  when lower(coalesce(p.username, '')) like q || '%' then 1
                  else 2 end as rank,
             p.full_name
        from public.profiles p
       where p.id <> actor
         and coalesce(p.username, '') <> ''
         and (lower(p.username) like q || '%'
              or lower(coalesce(p.full_name, '')) like '%' || q || '%')
       order by rank, p.full_name
       limit 8
    ) x;

  return result;
end;
$$;

revoke all on function public.dm_search_people(text) from public, anon;
grant execute on function public.dm_search_people(text) to authenticated, service_role;

/* --------------------------------------------------------------- open a DM
   Idempotent: the same two people always land in the same conversation, so a
   double click cannot create a second thread. */
create or replace function public.dm_start(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  handle text := ltrim(lower(btrim(coalesce(p_username, ''))), '@');
  peer public.profiles%rowtype;
  conversation uuid;
begin
  if actor is null then raise exception 'Sign in to send a message.' using errcode = '42501'; end if;
  if handle = '' then raise exception 'Enter a username.' using errcode = '22023'; end if;

  select * into peer from public.profiles p where lower(p.username) = handle limit 1;
  if peer.id is null then raise exception 'No member uses that username.' using errcode = 'P0002'; end if;
  if peer.id = actor then raise exception 'You cannot message yourself.' using errcode = '22023'; end if;

  select c.id into conversation
    from public.team_conversations c
    join public.team_conversation_members a on a.conversation_id = c.id and a.user_id = actor
    join public.team_conversation_members b on b.conversation_id = c.id and b.user_id = peer.id
   where c.business_id is null
     and (select count(*) from public.team_conversation_members x where x.conversation_id = c.id) = 2
   limit 1;

  if conversation is null then
    insert into public.team_conversations (business_id, kind, title, created_by)
    values (null, 'direct', null, actor)
    returning id into conversation;
    insert into public.team_conversation_members (conversation_id, user_id, last_read_at)
    values (conversation, actor, now()),
           (conversation, peer.id, null);
  end if;

  return jsonb_build_object(
    'conversationId', conversation,
    'peer', jsonb_build_object(
      'userId', peer.id,
      'username', peer.username,
      'fullName', peer.full_name,
      'avatarUrl', peer.avatar_url,
      'lastSeenAt', peer.last_seen_at
    )
  );
end;
$$;

revoke all on function public.dm_start(text) from public, anon;
grant execute on function public.dm_start(text) to authenticated, service_role;

/* -------------------------------------------------------------- the inbox
   Every conversation the caller is a member of — team rooms and personal
   threads together — newest first, with the other person's handle and presence
   so the list can show who is around. */
create or replace function public.dm_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to open your messages.' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'conversationId', c.id,
    'businessId', c.business_id,
    'kind', case when c.business_id is null then 'personal' else c.kind end,
    'title', case
               when c.business_id is null then coalesce(nullif(peer.full_name, ''), peer.username, 'Member')
               else c.title
             end,
    'peer', case when c.business_id is null then jsonb_build_object(
               'userId', peer.id, 'username', peer.username,
               'fullName', peer.full_name, 'avatarUrl', peer.avatar_url,
               'lastSeenAt', peer.last_seen_at) else null end,
    'lastMessageAt', c.last_message_at,
    'unread', (select count(*) from public.team_chat_messages m
                where m.conversation_id = c.id and m.sender_id <> actor
                  and (mine.last_read_at is null or m.created_at > mine.last_read_at)),
    'lastMessage', (select m.body from public.team_chat_messages m
                     where m.conversation_id = c.id order by m.created_at desc limit 1)
  ) order by c.last_message_at desc), '[]'::jsonb)
    into result
    from public.team_conversations c
    join public.team_conversation_members mine
      on mine.conversation_id = c.id and mine.user_id = actor
    left join lateral (
      select p.id, p.full_name, p.username, p.avatar_url, p.last_seen_at
        from public.team_conversation_members other
        join public.profiles p on p.id = other.user_id
       where other.conversation_id = c.id and other.user_id <> actor
       limit 1
    ) peer on true
   where c.business_id is null or public.is_business_team_member(c.business_id, actor);

  return result;
end;
$$;

revoke all on function public.dm_inbox() from public, anon;
grant execute on function public.dm_inbox() to authenticated, service_role;

/* -------------------------------------------------- thread / send, unblocked
   Both functions assumed a business. They now accept a personal thread, where
   membership of the conversation is sufficient, and keep the business check
   for business threads. */
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
     or not public.is_team_conversation_member(p_conversation, actor) then
    raise exception 'Not a member of this conversation.' using errcode = '42501';
  end if;
  update public.team_conversation_members set last_read_at = now()
   where conversation_id = p_conversation and user_id = actor;
  select jsonb_build_object(
    'conversationId', conversation.id,
    'businessId', conversation.business_id,
    'kind', case when conversation.business_id is null then 'personal' else conversation.kind end,
    'title', conversation.title,
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
      'userId', m.user_id,
      'name', coalesce(nullif(p.full_name, ''), p.username, split_part(coalesce(p.email, ''), '@', 1)),
      'username', p.username,
      'email', case when conversation.business_id is null then null else p.email end,
      'lastSeenAt', p.last_seen_at,
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

revoke all on function public.team_chat_thread(uuid, integer) from public, anon;
revoke all on function public.team_chat_send(uuid, text, jsonb) from public, anon;
grant execute on function public.team_chat_thread(uuid, integer) to authenticated, service_role;
grant execute on function public.team_chat_send(uuid, text, jsonb) to authenticated, service_role;

/* --------------------------------------------------------------- referrals */

alter table public.profiles add column if not exists referral_code text;

create unique index if not exists profiles_referral_code_idx
  on public.profiles (lower(referral_code))
  where referral_code is not null;

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users(id) on delete cascade,
  referee_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  bonus_credits int not null default 10,
  months_total int not null default 3,
  months_granted int not null default 0,
  next_grant_at timestamptz,
  created_at timestamptz not null default now(),
  unique (referee_id),
  check (referee_id <> referrer_id)
);

create index if not exists referrals_referrer_idx on public.referrals (referrer_id, created_at desc);
create index if not exists referrals_due_idx on public.referrals (next_grant_at)
  where months_granted < months_total;

alter table public.referrals enable row level security;

drop policy if exists referrals_read_own on public.referrals;
create policy referrals_read_own on public.referrals
  for select to authenticated
  using (referrer_id = auth.uid() or referee_id = auth.uid());

/* No write policies: both sides of a referral are decided by the RPCs below. */

alter table public.subscriptions add column if not exists bonus_credits int not null default 0;

/**
 * The caller's own code, created on first ask. Derived from the user id so two
 * people cannot end up with the same string by luck, and readable enough to
 * say out loud.
 */
create or replace function public.referral_my_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  existing text;
  candidate text;
begin
  if actor is null then raise exception 'Sign in to get your code.' using errcode = '42501'; end if;

  select referral_code into existing from public.profiles where id = actor;
  if existing is not null and existing <> '' then return existing; end if;

  for attempt in 1..8 loop
    /* No pgcrypto dependency: md5 of the clock and a random is enough for a
       six-character code, and the unique index catches the rare collision. */
    candidate := 'SHZ-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    begin
      update public.profiles set referral_code = candidate where id = actor and referral_code is null;
      select referral_code into existing from public.profiles where id = actor;
      exit when existing is not null;
    exception when unique_violation then
      continue;
    end;
  end loop;

  if existing is null then raise exception 'Could not create a code. Try again.' using errcode = 'P0001'; end if;
  return existing;
end;
$$;

revoke all on function public.referral_my_code() from public, anon;
grant execute on function public.referral_my_code() to authenticated, service_role;

/** Grant one month of bonus credits to whoever a referral row points at. */
create or replace function public.referral_grant_one(p_referral uuid, p_side text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  row_ref public.referrals%rowtype;
  target uuid;
begin
  select * into row_ref from public.referrals r where r.id = p_referral;
  if row_ref.id is null then return; end if;
  target := case when p_side = 'referrer' then row_ref.referrer_id else row_ref.referee_id end;

  update public.subscriptions
     set bonus_credits = coalesce(bonus_credits, 0) + row_ref.bonus_credits,
         ai_credits_limit = coalesce(ai_credits_limit, 30) + row_ref.bonus_credits
   where user_id = target;

  if not found then
    insert into public.subscriptions (user_id, plan, status, ai_credits_limit, bonus_credits)
    values (target, 'free', 'active', 30 + row_ref.bonus_credits, row_ref.bonus_credits)
    on conflict (user_id) do update
      set bonus_credits = coalesce(public.subscriptions.bonus_credits, 0) + row_ref.bonus_credits,
          ai_credits_limit = coalesce(public.subscriptions.ai_credits_limit, 30) + row_ref.bonus_credits;
  end if;
end;
$$;

revoke all on function public.referral_grant_one(uuid, text) from public, anon;
grant execute on function public.referral_grant_one(uuid, text) to service_role;

/**
 * Redeem somebody's code. Both sides get the first month immediately; the next
 * two are granted by referral_bonus_tick(). A member can be referred once, and
 * never by themselves.
 */
create or replace function public.referral_redeem(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  wanted text := upper(btrim(coalesce(p_code, '')));
  owner uuid;
  created public.referrals%rowtype;
begin
  if actor is null then raise exception 'Sign in to redeem a code.' using errcode = '42501'; end if;
  if wanted = '' then raise exception 'Enter a referral code.' using errcode = '22023'; end if;

  select id into owner from public.profiles p where upper(coalesce(p.referral_code, '')) = wanted limit 1;
  if owner is null then raise exception 'That code does not exist.' using errcode = 'P0002'; end if;
  if owner = actor then raise exception 'You cannot redeem your own code.' using errcode = '22023'; end if;
  if exists (select 1 from public.referrals r where r.referee_id = actor) then
    raise exception 'You have already redeemed a referral code.' using errcode = '23505';
  end if;

  insert into public.referrals (referrer_id, referee_id, code, months_granted, next_grant_at)
  values (owner, actor, wanted, 1, now() + interval '1 month')
  returning * into created;

  perform public.referral_grant_one(created.id, 'referee');
  perform public.referral_grant_one(created.id, 'referrer');

  return jsonb_build_object(
    'ok', true,
    'bonusCredits', created.bonus_credits,
    'monthsLeft', created.months_total - created.months_granted,
    'nextGrantAt', created.next_grant_at
  );
end;
$$;

revoke all on function public.referral_redeem(text) from public, anon;
grant execute on function public.referral_redeem(text) to authenticated, service_role;

/**
 * Grant any month that has come due. Safe to call often: it only touches rows
 * whose next_grant_at has passed, and closes the row when the months run out.
 */
create or replace function public.referral_bonus_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  due public.referrals%rowtype;
  granted int := 0;
begin
  for due in
    select * from public.referrals r
     where r.months_granted < r.months_total
       and (r.next_grant_at is null or r.next_grant_at <= now())
     for update skip locked
  loop
    perform public.referral_grant_one(due.id, 'referee');
    perform public.referral_grant_one(due.id, 'referrer');
    update public.referrals
       set months_granted = months_granted + 1,
           next_grant_at = case when months_granted + 1 >= months_total then null
                                else now() + interval '1 month' end
     where id = due.id;
    granted := granted + 1;
  end loop;
  return jsonb_build_object('granted', granted);
end;
$$;

revoke all on function public.referral_bonus_tick() from public, anon;
grant execute on function public.referral_bonus_tick() to authenticated, service_role;

/** What the settings screen shows: my code, my invites, my bonus. */
create or replace function public.referral_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  code text;
  invited int;
  redeemed jsonb;
  bonus int;
  names jsonb;
begin
  if actor is null then raise exception 'Sign in to see referrals.' using errcode = '42501'; end if;
  code := public.referral_my_code();

  select count(*) into invited from public.referrals r where r.referrer_id = actor;

  select to_jsonb(r) - 'id' into redeemed
    from public.referrals r where r.referee_id = actor limit 1;

  select coalesce(bonus_credits, 0) into bonus from public.subscriptions where user_id = actor;

  select coalesce(jsonb_agg(jsonb_build_object(
    'name', coalesce(nullif(p.full_name, ''), p.username, 'Member'),
    'username', p.username,
    'joinedAt', r.created_at,
    'monthsGranted', r.months_granted,
    'monthsTotal', r.months_total
  ) order by r.created_at desc), '[]'::jsonb)
    into names
    from public.referrals r
    join public.profiles p on p.id = r.referee_id
   where r.referrer_id = actor;

  return jsonb_build_object(
    'code', code,
    'invited', invited,
    'friends', names,
    'redeemed', redeemed,
    'bonusCredits', coalesce(bonus, 0)
  );
end;
$$;

revoke all on function public.referral_summary() from public, anon;
grant execute on function public.referral_summary() to authenticated, service_role;

/* ----------------------------------------------------------------- profiles
   The team list gains the heartbeat so the member row can show a status dot.
   Same shape as before, one field added — nothing that reads it can break. */
create or replace function public.team_members_list(p_business uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  result jsonb;
  owner uuid;
begin
  if actor is null then raise exception 'Sign in to view the team.' using errcode='42501'; end if;
  select owner_id into owner from public.businesses where id = p_business;
  if owner is null then raise exception 'That business does not exist.' using errcode='22023'; end if;
  if owner <> actor and not public.is_admin(actor)
     and not exists (select 1 from public.business_team_members m where m.business_id = p_business and m.user_id = actor) then
    raise exception 'You are not on this team.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', x.user_id, 'fullName', x.full_name, 'username', x.username, 'avatarUrl', x.avatar_url,
    'memberType', x.member_type, 'isOwner', x.is_owner, 'joinedAt', x.created_at,
    'lastSeenAt', x.last_seen_at
  ) order by x.is_owner desc, x.created_at), '[]'::jsonb) into result
  from (
    select pr.id as user_id, pr.full_name, pr.username, pr.avatar_url, m.member_type, m.created_at, false as is_owner, pr.last_seen_at
      from public.business_team_members m join public.profiles pr on pr.id = m.user_id
     where m.business_id = p_business and m.user_id <> owner
    union all
    select pr.id, pr.full_name, pr.username, pr.avatar_url, 'owner'::text, b.created_at, true, pr.last_seen_at
      from public.businesses b join public.profiles pr on pr.id = b.owner_id
     where b.id = p_business
  ) x;
  return result;
end;
$fn$;

revoke all on function public.team_members_list(uuid) from public, anon;
grant execute on function public.team_members_list(uuid) to authenticated, service_role;
