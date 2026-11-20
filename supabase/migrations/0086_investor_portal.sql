-- ============================================================================
-- 0086 — Investor portal, phase 1: data model, access rules, RPCs (DRAFT)
-- ----------------------------------------------------------------------------
-- Investors can:  browse businesses that opted in (investor_visible), read
--                 only the approved business fields, view investor profiles
--                 allowed by their visibility setting, send and answer
--                 connection requests, receive pitches, and message people
--                 they are connected to or have a pitch with.
-- Businesses:     opt in with investor_visible, and send pitches to public
--                 investor profiles.
-- Privacy:        base tables are readable only by their own parties. Anything
--                 an investor can see about someone else comes from a
--                 SECURITY DEFINER function that returns a fixed column list.
--                 Every write goes through a function that checks the caller.
-- Money:          all amounts are INR rupees (numeric), not paise.
-- ============================================================================

-- 1. Business opt-in and funding requirement -------------------------------
alter table public.businesses
  add column if not exists investor_visible boolean not null default false,
  add column if not exists funding_requirement_inr numeric(14,2)
    check (funding_requirement_inr is null or funding_requirement_inr >= 0);

-- 2. Investor profiles ------------------------------------------------------
create table if not exists public.investor_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 80),
  headline text check (char_length(headline) <= 140),
  bio text check (char_length(bio) <= 1200),
  interests text[] not null default '{}',
  preferred_industries text[] not null default '{}',
  portfolio text check (char_length(portfolio) <= 1200),
  visibility text not null default 'private' check (visibility in ('public', 'connections', 'private')),
  updated_at timestamptz not null default now()
);

alter table public.investor_profiles enable row level security;

drop policy if exists investor_profiles_own_select on public.investor_profiles;
create policy investor_profiles_own_select on public.investor_profiles
  for select to authenticated using (user_id = auth.uid());

drop policy if exists investor_profiles_own_write on public.investor_profiles;
create policy investor_profiles_own_write on public.investor_profiles
  for all to authenticated
  using (user_id = auth.uid() and public.is_account_type('investor'))
  with check (user_id = auth.uid() and public.is_account_type('investor'));

revoke all on public.investor_profiles from anon;

-- 3. Connection requests ---------------------------------------------------
create table if not exists public.investor_connections (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);

create unique index if not exists investor_connections_pair_idx
  on public.investor_connections (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

alter table public.investor_connections enable row level security;

drop policy if exists investor_connections_party_select on public.investor_connections;
create policy investor_connections_party_select on public.investor_connections
  for select to authenticated using (requester_id = auth.uid() or addressee_id = auth.uid());

revoke all on public.investor_connections from anon;

-- 4. Pitches ---------------------------------------------------------------
create table if not exists public.investment_pitches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  investor_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  summary text not null check (char_length(summary) between 10 and 2000),
  funding_requested_inr numeric(14,2) check (funding_requested_inr is null or funding_requested_inr >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'interested', 'info_requested', 'accepted', 'declined')),
  info_request text check (char_length(info_request) <= 1000),
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  responded_at timestamptz,
  check (owner_id <> investor_id)
);

create index if not exists investment_pitches_investor_idx on public.investment_pitches (investor_id, created_at desc);
create index if not exists investment_pitches_owner_idx on public.investment_pitches (owner_id, created_at desc);

alter table public.investment_pitches enable row level security;

drop policy if exists investment_pitches_party_select on public.investment_pitches;
create policy investment_pitches_party_select on public.investment_pitches
  for select to authenticated using (owner_id = auth.uid() or investor_id = auth.uid());

revoke all on public.investment_pitches from anon;

-- 5. Direct conversations and messages ------------------------------------
create table if not exists public.direct_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.direct_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists direct_messages_conv_idx on public.direct_messages (conversation_id, created_at);

create table if not exists public.direct_conversation_reads (
  conversation_id uuid not null references public.direct_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default to_timestamp(0),
  primary key (conversation_id, user_id)
);

alter table public.direct_conversations enable row level security;
alter table public.direct_messages enable row level security;
alter table public.direct_conversation_reads enable row level security;

drop policy if exists direct_conversations_member_select on public.direct_conversations;
create policy direct_conversations_member_select on public.direct_conversations
  for select to authenticated using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists direct_messages_member_select on public.direct_messages;
create policy direct_messages_member_select on public.direct_messages
  for select to authenticated using (
    exists (select 1 from public.direct_conversations c
             where c.id = conversation_id and (c.user_a = auth.uid() or c.user_b = auth.uid()))
  );

drop policy if exists direct_reads_own_select on public.direct_conversation_reads;
create policy direct_reads_own_select on public.direct_conversation_reads
  for select to authenticated using (user_id = auth.uid());

revoke all on public.direct_conversations from anon;
revoke all on public.direct_messages from anon;
revoke all on public.direct_conversation_reads from anon;

-- Realtime: members receive only the rows their RLS policy allows.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_messages'
  ) then
    alter publication supabase_realtime add table public.direct_messages;
  end if;
end $$;

-- Explicit privileges. Supabase grants broad table access by default, so the
-- tables clients may only read are narrowed here, and writes happen through
-- functions or the one profile policy.
revoke all on public.investor_profiles, public.investor_connections, public.investment_pitches,
  public.direct_conversations, public.direct_messages, public.direct_conversation_reads
  from anon, authenticated;
grant select, insert, update on public.investor_profiles to authenticated;
grant select on public.investor_connections, public.investment_pitches,
  public.direct_conversations, public.direct_messages, public.direct_conversation_reads
  to authenticated;

-- 6. Helpers ----------------------------------------------------------------
create or replace function public.investors_connected(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.investor_connections c
     where c.status = 'accepted'
       and least(c.requester_id, c.addressee_id) = least(a, b)
       and greatest(c.requester_id, c.addressee_id) = greatest(a, b)
  );
$$;

create or replace function public.pitch_linked(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.investment_pitches p
     where (p.owner_id = a and p.investor_id = b) or (p.owner_id = b and p.investor_id = a)
  );
$$;

create or replace function public.account_type_of(p_user uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select p.account_type from public.profiles p where p.id = p_user;
$$;

-- 7. Investor marketplace (only opted-in businesses, fixed column list) -----
create or replace function public.investor_marketplace(
  p_query text default null,
  p_industry text default null,
  p_stage text default null,
  p_min_funding numeric default null,
  p_max_funding numeric default null,
  p_location text default null
)
returns table (
  id uuid,
  name text,
  description text,
  category text,
  stage text,
  location text,
  goals jsonb,
  goal_note text,
  funding_requirement_inr numeric,
  logo_url text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_account_type('investor') then
    raise exception 'Only investor accounts can browse businesses.' using errcode = '42501';
  end if;

  return query
    select b.id, b.name, b.description, b.category, b.stage, b.location,
           b.goals, b.goal_note, b.funding_requirement_inr, b.logo_url, b.created_at
      from public.businesses b
     where b.investor_visible
       and (p_query is null or p_query = '' or b.name ilike '%' || p_query || '%'
            or b.description ilike '%' || p_query || '%')
       and (p_industry is null or p_industry = '' or b.category = p_industry)
       and (p_stage is null or p_stage = '' or b.stage = p_stage)
       and (p_min_funding is null or b.funding_requirement_inr >= p_min_funding)
       and (p_max_funding is null or b.funding_requirement_inr <= p_max_funding)
       and (p_location is null or p_location = '' or b.location ilike '%' || p_location || '%')
     order by b.created_at desc
     limit 200;
end;
$$;

create or replace function public.investor_business(p_business uuid)
returns table (
  id uuid,
  name text,
  description text,
  category text,
  stage text,
  location text,
  goals jsonb,
  goal_note text,
  funding_requirement_inr numeric,
  logo_url text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_account_type('investor') then
    raise exception 'Only investor accounts can view business profiles.' using errcode = '42501';
  end if;

  return query
    select b.id, b.name, b.description, b.category, b.stage, b.location,
           b.goals, b.goal_note, b.funding_requirement_inr, b.logo_url, b.created_at
      from public.businesses b
     where b.id = p_business and b.investor_visible;
end;
$$;

-- 8. Investor network --------------------------------------------------------
-- Visible to any signed-in user: public profiles. Connections-only profiles are
-- visible to accepted connections. Private profiles are visible only to self.
create or replace function public.investor_network_directory(
  p_query text default null,
  p_industry text default null
)
returns table (
  user_id uuid,
  display_name text,
  headline text,
  interests text[],
  preferred_industries text[],
  avatar_url text,
  visibility text,
  connection_status text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  return query
    select ip.user_id, ip.display_name, ip.headline, ip.interests, ip.preferred_industries,
           pr.avatar_url, ip.visibility,
           case
             when ip.user_id = uid then 'self'
             when exists (select 1 from public.investor_connections c
                           where c.status = 'accepted'
                             and least(c.requester_id, c.addressee_id) = least(uid, ip.user_id)
                             and greatest(c.requester_id, c.addressee_id) = greatest(uid, ip.user_id)) then 'connected'
             when exists (select 1 from public.investor_connections c
                           where c.status = 'pending' and c.requester_id = uid and c.addressee_id = ip.user_id) then 'request_sent'
             when exists (select 1 from public.investor_connections c
                           where c.status = 'pending' and c.requester_id = ip.user_id and c.addressee_id = uid) then 'request_received'
             else 'none'
           end
      from public.investor_profiles ip
      left join public.profiles pr on pr.id = ip.user_id
     where (ip.visibility = 'public'
            or ip.user_id = uid
            or (ip.visibility = 'connections' and public.investors_connected(uid, ip.user_id)))
       and (p_query is null or p_query = '' or ip.display_name ilike '%' || p_query || '%'
            or ip.headline ilike '%' || p_query || '%')
       and (p_industry is null or p_industry = '' or p_industry = any (ip.preferred_industries))
     order by ip.display_name
     limit 200;
end;
$$;

-- Bio and portfolio are returned only when the viewer may see the profile.
create or replace function public.investor_profile_detail(p_user uuid)
returns table (
  user_id uuid,
  display_name text,
  headline text,
  bio text,
  portfolio text,
  interests text[],
  preferred_industries text[],
  avatar_url text,
  visibility text
)
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  return query
    select ip.user_id, ip.display_name, ip.headline, ip.bio, ip.portfolio,
           ip.interests, ip.preferred_industries, pr.avatar_url, ip.visibility
      from public.investor_profiles ip
      left join public.profiles pr on pr.id = ip.user_id
     where ip.user_id = p_user
       and (ip.visibility = 'public'
            or ip.user_id = uid
            or (ip.visibility = 'connections' and public.investors_connected(uid, ip.user_id)));

  if not found then
    raise exception 'That profile is not available.' using errcode = 'P0002';
  end if;
end;
$$;

-- 9. Connection writes ---------------------------------------------------------
create or replace function public.request_connection(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_id uuid;
  v_status text;
  v_visibility text;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not public.is_account_type('investor') then
    raise exception 'Only investor accounts can send connection requests.' using errcode = '42501';
  end if;
  if p_user = uid then raise exception 'You cannot connect with yourself.' using errcode = '22023'; end if;

  select ip.visibility into v_visibility from public.investor_profiles ip where ip.user_id = p_user;
  if v_visibility is null or v_visibility = 'private' then
    raise exception 'That investor is not accepting connection requests.' using errcode = 'P0002';
  end if;

  select c.id, c.status into v_id, v_status
    from public.investor_connections c
   where least(c.requester_id, c.addressee_id) = least(uid, p_user)
     and greatest(c.requester_id, c.addressee_id) = greatest(uid, p_user);

  if v_id is null then
    insert into public.investor_connections (requester_id, addressee_id, status)
    values (uid, p_user, 'pending')
    returning id into v_id;
    return v_id;
  end if;

  if v_status = 'accepted' then raise exception 'You are already connected.' using errcode = '22023'; end if;
  if v_status = 'pending' then raise exception 'A request is already waiting.' using errcode = '22023'; end if;

  -- A declined request can be sent again, from either side.
  update public.investor_connections
     set requester_id = uid, addressee_id = p_user, status = 'pending',
         responded_at = null, created_at = now()
   where id = v_id;
  return v_id;
end;
$$;

create or replace function public.respond_connection(p_connection uuid, p_accept boolean)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_status text;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  select c.status into v_status
    from public.investor_connections c
   where c.id = p_connection and c.addressee_id = uid;
  if not found then raise exception 'That request was not found.' using errcode = 'P0002'; end if;
  if v_status <> 'pending' then raise exception 'That request has already been answered.' using errcode = '22023'; end if;

  update public.investor_connections
     set status = case when p_accept then 'accepted' else 'declined' end,
         responded_at = now()
   where id = p_connection;

  return case when p_accept then 'accepted' else 'declined' end;
end;
$$;

create or replace function public.my_connections()
returns table (
  connection_id uuid,
  user_id uuid,
  display_name text,
  headline text,
  avatar_url text,
  status text,
  direction text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  return query
    select c.id,
           case when c.requester_id = uid then c.addressee_id else c.requester_id end,
           ip.display_name, ip.headline, pr.avatar_url, c.status,
           case when c.requester_id = uid then 'sent' else 'received' end,
           c.created_at
      from public.investor_connections c
      left join public.investor_profiles ip
        on ip.user_id = (case when c.requester_id = uid then c.addressee_id else c.requester_id end)
      left join public.profiles pr
        on pr.id = (case when c.requester_id = uid then c.addressee_id else c.requester_id end)
     where c.requester_id = uid or c.addressee_id = uid
     order by c.created_at desc;
end;
$$;

-- 10. Pitches --------------------------------------------------------------------
create or replace function public.send_pitch(
  p_business uuid,
  p_investor uuid,
  p_title text,
  p_summary text,
  p_funding numeric default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_visibility text;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not public.is_account_type('owner') then
    raise exception 'Only business owners can send a pitch.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.businesses b where b.id = p_business and b.owner_id = uid) then
    raise exception 'That business was not found.' using errcode = 'P0002';
  end if;
  if public.account_type_of(p_investor) is distinct from 'investor' then
    raise exception 'That investor was not found.' using errcode = 'P0002';
  end if;

  select ip.visibility into v_visibility from public.investor_profiles ip where ip.user_id = p_investor;
  if v_visibility is distinct from 'public' then
    raise exception 'That investor is not open to pitches.' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.investment_pitches p
              where p.business_id = p_business and p.investor_id = p_investor
                and p.status in ('pending', 'interested', 'info_requested')) then
    raise exception 'You already have an open pitch with this investor.' using errcode = '22023';
  end if;

  insert into public.investment_pitches (id, business_id, owner_id, investor_id, title, summary, funding_requested_inr)
  values (v_id, p_business, uid, p_investor, trim(p_title), trim(p_summary), p_funding);

  return v_id;
end;
$$;

-- Files are uploaded under <pitch_id>/<file> after the pitch exists, then recorded here.
create or replace function public.add_pitch_attachment(
  p_pitch uuid,
  p_path text,
  p_name text,
  p_size integer,
  p_type text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_attachments jsonb;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  select p.attachments into v_attachments
    from public.investment_pitches p
   where p.id = p_pitch and p.owner_id = uid and p.status in ('pending', 'info_requested');
  if not found then raise exception 'That pitch cannot take new files.' using errcode = 'P0002'; end if;

  if jsonb_array_length(v_attachments) >= 5 then
    raise exception 'A pitch can have up to 5 files.' using errcode = '22023';
  end if;
  if p_path is null or left(p_path, 37) <> p_pitch::text || '/' then
    raise exception 'That file does not belong to this pitch.' using errcode = '42501';
  end if;
  if p_size is null or p_size <= 0 or p_size > 10485760 then
    raise exception 'Files must be 10 MB or smaller.' using errcode = '22023';
  end if;
  if p_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
    raise exception 'Only PDF and image files can be attached.' using errcode = '22023';
  end if;

  update public.investment_pitches
     set attachments = attachments || jsonb_build_array(jsonb_build_object(
           'path', p_path, 'name', left(coalesce(p_name, 'file'), 120), 'size', p_size, 'type', p_type)),
         updated_at = now()
   where id = p_pitch;
end;
$$;

-- The investor answers a pitch. Accepted and declined are final.
create or replace function public.investor_respond_pitch(p_pitch uuid, p_status text, p_info text default null)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_current text;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not public.is_account_type('investor') then
    raise exception 'Only investor accounts can answer a pitch.' using errcode = '42501';
  end if;
  if p_status not in ('interested', 'info_requested', 'accepted', 'declined') then
    raise exception 'Choose a valid response.' using errcode = '22023';
  end if;
  if p_status = 'info_requested' and (p_info is null or char_length(trim(p_info)) < 3) then
    raise exception 'Say what information you need.' using errcode = '22023';
  end if;

  select p.status into v_current from public.investment_pitches p
   where p.id = p_pitch and p.investor_id = uid;
  if not found then raise exception 'That pitch was not found.' using errcode = 'P0002'; end if;
  if v_current in ('accepted', 'declined') then
    raise exception 'This pitch has already been decided.' using errcode = '22023';
  end if;

  update public.investment_pitches
     set status = p_status,
         info_request = case when p_status = 'info_requested' then trim(p_info) else info_request end,
         responded_at = now(),
         updated_at = now()
   where id = p_pitch;

  return p_status;
end;
$$;

-- What the caller has sent or received, with the other party's public name.
create or replace function public.my_pitches()
returns table (
  id uuid,
  role text,
  business_id uuid,
  business_name text,
  counterpart_name text,
  counterpart_id uuid,
  title text,
  summary text,
  funding_requested_inr numeric,
  status text,
  info_request text,
  attachments jsonb,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  return query
    select p.id,
           case when p.owner_id = uid then 'sent' else 'received' end,
           p.business_id,
           b.name,
           case when p.owner_id = uid then ip.display_name else coalesce(bo.full_name, 'Business owner') end,
           case when p.owner_id = uid then p.investor_id else p.owner_id end,
           p.title, p.summary, p.funding_requested_inr, p.status, p.info_request,
           p.attachments, p.created_at, p.updated_at
      from public.investment_pitches p
      join public.businesses b on b.id = p.business_id
      left join public.investor_profiles ip on ip.user_id = p.investor_id
      left join public.profiles bo on bo.id = p.owner_id
     where p.owner_id = uid or p.investor_id = uid
     order by p.created_at desc;
end;
$$;

-- 11. Messaging ------------------------------------------------------------------
-- Investor and investor: must be connected. Owner and investor: must have a pitch
-- between them. Nobody else can open a conversation.
create or replace function public.open_direct_conversation(p_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_me text;
  v_them text;
  v_id uuid;
  v_lo uuid;
  v_hi uuid;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if p_user = uid then raise exception 'You cannot message yourself.' using errcode = '22023'; end if;

  v_me := public.account_type_of(uid);
  v_them := public.account_type_of(p_user);

  if not (
       (v_me = 'investor' and v_them = 'investor' and public.investors_connected(uid, p_user))
    or (v_me in ('investor', 'owner') and v_them in ('investor', 'owner') and v_me <> v_them
        and public.pitch_linked(uid, p_user))
  ) then
    raise exception 'You can message people you are connected with, or who have a pitch with you.' using errcode = '42501';
  end if;

  v_lo := least(uid, p_user);
  v_hi := greatest(uid, p_user);

  select c.id into v_id from public.direct_conversations c where c.user_a = v_lo and c.user_b = v_hi;
  if v_id is null then
    insert into public.direct_conversations (user_a, user_b) values (v_lo, v_hi) returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.send_direct_message(p_conversation uuid, p_body text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_id uuid;
  v_text text := trim(coalesce(p_body, ''));
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if char_length(v_text) < 1 or char_length(v_text) > 4000 then
    raise exception 'Messages must be between 1 and 4000 characters.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.direct_conversations c
                  where c.id = p_conversation and (c.user_a = uid or c.user_b = uid)) then
    raise exception 'That conversation was not found.' using errcode = 'P0002';
  end if;

  insert into public.direct_messages (conversation_id, sender_id, body)
  values (p_conversation, uid, v_text)
  returning id into v_id;

  update public.direct_conversations set last_message_at = now() where id = p_conversation;
  return v_id;
end;
$$;

create or replace function public.mark_conversation_read(p_conversation uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not exists (select 1 from public.direct_conversations c
                  where c.id = p_conversation and (c.user_a = uid or c.user_b = uid)) then
    raise exception 'That conversation was not found.' using errcode = 'P0002';
  end if;

  insert into public.direct_conversation_reads (conversation_id, user_id, last_read_at)
  values (p_conversation, uid, now())
  on conflict (conversation_id, user_id) do update set last_read_at = excluded.last_read_at;
end;
$$;

-- Inbox: each conversation with the other person's name and the unread count.
create or replace function public.my_conversations()
returns table (
  conversation_id uuid,
  other_user_id uuid,
  other_name text,
  other_avatar text,
  last_message_at timestamptz,
  last_body text,
  unread_count integer
)
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  return query
    select c.id,
           o.id,
           coalesce(ip.display_name, pr.full_name, 'Member'),
           pr.avatar_url,
           c.last_message_at,
           lm.body,
           (select count(*)::integer from public.direct_messages m
             where m.conversation_id = c.id and m.sender_id <> uid
               and m.created_at > coalesce(rd.last_read_at, to_timestamp(0)))
      from public.direct_conversations c
      join lateral (select case when c.user_a = uid then c.user_b else c.user_a end as id) o on true
      left join public.investor_profiles ip on ip.user_id = o.id
      left join public.profiles pr on pr.id = o.id
      left join public.direct_conversation_reads rd on rd.conversation_id = c.id and rd.user_id = uid
      left join lateral (
        select m.body from public.direct_messages m
         where m.conversation_id = c.id order by m.created_at desc limit 1
      ) lm on true
     where c.user_a = uid or c.user_b = uid
     order by c.last_message_at desc;
end;
$$;

-- 12. Dashboard numbers for the caller -----------------------------------------
create or replace function public.investor_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_result jsonb;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;

  select jsonb_build_object(
    'listed_businesses', (select count(*) from public.businesses b where b.investor_visible),
    'public_investors', (select count(*) from public.investor_profiles ip where ip.visibility = 'public'),
    'connections', (select count(*) from public.investor_connections c
                     where c.status = 'accepted' and (c.requester_id = uid or c.addressee_id = uid)),
    'pending_requests_in', (select count(*) from public.investor_connections c
                             where c.status = 'pending' and c.addressee_id = uid),
    'open_pitches', (select count(*) from public.investment_pitches p
                      where p.investor_id = uid and p.status in ('pending', 'interested', 'info_requested')),
    'unread_messages', (select count(*) from public.direct_messages m
                         join public.direct_conversations c on c.id = m.conversation_id
                         left join public.direct_conversation_reads rd
                           on rd.conversation_id = c.id and rd.user_id = uid
                        where (c.user_a = uid or c.user_b = uid) and m.sender_id <> uid
                          and m.created_at > coalesce(rd.last_read_at, to_timestamp(0)))
  ) into v_result;

  return v_result;
end;
$$;

-- 13. Notifications ----------------------------------------------------------------
create or replace function public.notify_investor_connection()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    if new.status = 'pending' then
      insert into public.notifications (user_id, title, message, type, link)
      values (new.addressee_id, 'New connection request', 'An investor wants to connect with you.',
              'investor', '/app/?view=investor-network');
    elsif new.status = 'accepted' then
      insert into public.notifications (user_id, title, message, type, link)
      values (new.requester_id, 'Connection accepted', 'Your connection request was accepted.',
              'investor', '/app/?view=investor-network');
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists investor_connections_notify on public.investor_connections;
create trigger investor_connections_notify
  after insert or update of status on public.investor_connections
  for each row execute function public.notify_investor_connection();

create or replace function public.notify_investor_pitch()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, title, message, type, link)
    values (new.investor_id, 'New business pitch', new.title, 'investor', '/app/?view=investor-requests');
  elsif new.status is distinct from old.status then
    insert into public.notifications (user_id, title, message, type, link)
    values (new.owner_id, 'Pitch update', 'Your pitch "' || new.title || '" is now ' || replace(new.status, '_', ' ') || '.',
            'investor', '/app/?view=investor-requests');
  end if;
  return null;
end;
$$;

drop trigger if exists investment_pitches_notify on public.investment_pitches;
create trigger investment_pitches_notify
  after insert or update of status on public.investment_pitches
  for each row execute function public.notify_investor_pitch();

create or replace function public.notify_direct_message()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_other uuid;
begin
  select case when c.user_a = new.sender_id then c.user_b else c.user_a end into v_other
    from public.direct_conversations c where c.id = new.conversation_id;
  if v_other is not null then
    insert into public.notifications (user_id, title, message, type, link)
    values (v_other, 'New message', left(new.body, 120), 'message', '/app/?view=messages');
  end if;
  return null;
end;
$$;

drop trigger if exists direct_messages_notify on public.direct_messages;
create trigger direct_messages_notify
  after insert on public.direct_messages
  for each row execute function public.notify_direct_message();

-- 14. Pitch attachment storage (private, 10 MB, PDF and images) ----------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pitch-attachments', 'pitch-attachments', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

drop policy if exists pitch_attachments_party_read on storage.objects;
create policy pitch_attachments_party_read on storage.objects
  for select to authenticated using (
    bucket_id = 'pitch-attachments'
    and exists (
      select 1 from public.investment_pitches p
       where p.id::text = (storage.foldername(name))[1]
         and (p.owner_id = auth.uid() or p.investor_id = auth.uid())
    )
  );

drop policy if exists pitch_attachments_owner_upload on storage.objects;
create policy pitch_attachments_owner_upload on storage.objects
  for insert to authenticated with check (
    bucket_id = 'pitch-attachments'
    and exists (
      select 1 from public.investment_pitches p
       where p.id::text = (storage.foldername(name))[1]
         and p.owner_id = auth.uid()
         and p.status in ('pending', 'info_requested')
    )
  );

-- 15. Grants: functions are callable by signed-in users only ------------------------
revoke all on function public.investors_connected(uuid, uuid) from public, anon;
revoke all on function public.pitch_linked(uuid, uuid) from public, anon;
revoke all on function public.account_type_of(uuid) from public, anon;
revoke all on function public.investor_marketplace(text, text, text, numeric, numeric, text) from public, anon;
revoke all on function public.investor_business(uuid) from public, anon;
revoke all on function public.investor_network_directory(text, text) from public, anon;
revoke all on function public.investor_profile_detail(uuid) from public, anon;
revoke all on function public.request_connection(uuid) from public, anon;
revoke all on function public.respond_connection(uuid, boolean) from public, anon;
revoke all on function public.my_connections() from public, anon;
revoke all on function public.send_pitch(uuid, uuid, text, text, numeric) from public, anon;
revoke all on function public.add_pitch_attachment(uuid, text, text, integer, text) from public, anon;
revoke all on function public.investor_respond_pitch(uuid, text, text) from public, anon;
revoke all on function public.my_pitches() from public, anon;
revoke all on function public.open_direct_conversation(uuid) from public, anon;
revoke all on function public.send_direct_message(uuid, text) from public, anon;
revoke all on function public.mark_conversation_read(uuid) from public, anon;
revoke all on function public.my_conversations() from public, anon;
revoke all on function public.investor_dashboard() from public, anon;

grant execute on function public.investors_connected(uuid, uuid) to authenticated, service_role;
grant execute on function public.pitch_linked(uuid, uuid) to authenticated, service_role;
grant execute on function public.account_type_of(uuid) to authenticated, service_role;
grant execute on function public.investor_marketplace(text, text, text, numeric, numeric, text) to authenticated, service_role;
grant execute on function public.investor_business(uuid) to authenticated, service_role;
grant execute on function public.investor_network_directory(text, text) to authenticated, service_role;
grant execute on function public.investor_profile_detail(uuid) to authenticated, service_role;
grant execute on function public.request_connection(uuid) to authenticated, service_role;
grant execute on function public.respond_connection(uuid, boolean) to authenticated, service_role;
grant execute on function public.my_connections() to authenticated, service_role;
grant execute on function public.send_pitch(uuid, uuid, text, text, numeric) to authenticated, service_role;
grant execute on function public.add_pitch_attachment(uuid, text, text, integer, text) to authenticated, service_role;
grant execute on function public.investor_respond_pitch(uuid, text, text) to authenticated, service_role;
grant execute on function public.my_pitches() to authenticated, service_role;
grant execute on function public.open_direct_conversation(uuid) to authenticated, service_role;
grant execute on function public.send_direct_message(uuid, text) to authenticated, service_role;
grant execute on function public.mark_conversation_read(uuid) to authenticated, service_role;
grant execute on function public.my_conversations() to authenticated, service_role;
grant execute on function public.investor_dashboard() to authenticated, service_role;
