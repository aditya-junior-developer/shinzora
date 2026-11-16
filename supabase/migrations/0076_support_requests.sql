-- ============================================================================
-- 0076 — Customer Support for Shinzora users
-- ----------------------------------------------------------------------------
-- Separate from the store-ticket queue (support_tickets, 0001/0035), which a
-- business owner uses for their own customers. This is the platform's own
-- support: a Shinzora user asks the team for help, by chat or by a callback.
--
--   support_requests            one request: channel 'chat' or 'call' (or 'ai'
--                               when the AI assistant hands a chat to a human)
--   support_request_messages    the chat thread on a request (user and admin)
--   support_ai_messages         the AI assistant's own history, per user
--   support_settings            key/value; 'response_time_note' is the text an
--                               admin may show users. Empty = show nothing.
--
-- Writes go through security-definer RPCs that check the caller, so a user can
-- only act on their own requests and only an administrator (is_admin()) can
-- change a status or reply as the team. No response time is promised by the
-- schema: the note is whatever an administrator typed, and it is optional.
-- ============================================================================

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('chat', 'call', 'ai')),
  subject text not null check (char_length(subject) between 1 and 160),
  message text not null check (char_length(message) between 1 and 4000),
  phone text check (phone is null or char_length(phone) between 7 and 20),
  best_time text check (best_time is null or char_length(best_time) between 1 and 120),
  status text not null default 'received'
    check (status in ('received', 'in_progress', 'resolved', 'closed')),
  admin_note text check (admin_note is null or char_length(admin_note) <= 2000),
  assigned_to uuid references auth.users(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_requests_user_idx on public.support_requests (user_id, created_at desc);
create index if not exists support_requests_status_idx on public.support_requests (status, created_at desc);

create table if not exists public.support_request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.support_requests(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_role text not null check (author_role in ('user', 'admin')),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists support_request_messages_idx on public.support_request_messages (request_id, created_at);

create table if not exists public.support_ai_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  body text not null check (char_length(body) between 1 and 6000),
  created_at timestamptz not null default now()
);

create index if not exists support_ai_messages_idx on public.support_ai_messages (user_id, created_at desc);

create table if not exists public.support_settings (
  key text primary key,
  value text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.support_settings (key, value) values ('response_time_note', '')
on conflict (key) do nothing;

alter table public.support_requests enable row level security;
alter table public.support_request_messages enable row level security;
alter table public.support_ai_messages enable row level security;
alter table public.support_settings enable row level security;

drop policy if exists support_requests_read on public.support_requests;
create policy support_requests_read on public.support_requests
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists support_request_messages_read on public.support_request_messages;
create policy support_request_messages_read on public.support_request_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.support_requests r
      where r.id = request_id and (r.user_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists support_ai_messages_read on public.support_ai_messages;
create policy support_ai_messages_read on public.support_ai_messages
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists support_settings_read on public.support_settings;
create policy support_settings_read on public.support_settings
  for select to authenticated
  using (true);

-- No direct writes from the browser: every change is an RPC below or, for the
-- AI history, a write by the support-ai function with the service role.
revoke all on public.support_requests from anon, authenticated;
revoke all on public.support_request_messages from anon, authenticated;
revoke all on public.support_ai_messages from anon, authenticated;
revoke all on public.support_settings from anon, authenticated;
grant select on public.support_requests to authenticated;
grant select on public.support_request_messages to authenticated;
grant select on public.support_ai_messages to authenticated;
grant select on public.support_settings to authenticated;

-- ---------------------------------------------------------------------------
-- support_request_create — a chat or callback request from a signed-in user.
-- A chat request keeps its first message as the opening entry in the thread.
-- ---------------------------------------------------------------------------
create or replace function public.support_request_create(
  p_channel text,
  p_subject text,
  p_message text,
  p_phone text default null,
  p_best_time text default null
)
returns public.support_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  channel text := lower(coalesce(p_channel, ''));
  subject text := btrim(coalesce(p_subject, ''));
  message text := btrim(coalesce(p_message, ''));
  phone text := nullif(btrim(coalesce(p_phone, '')), '');
  best_time text := nullif(btrim(coalesce(p_best_time, '')), '');
  row_out public.support_requests;
begin
  if actor is null then
    raise exception 'Sign in to contact support.' using errcode = '42501';
  end if;
  if channel not in ('chat', 'call') then
    raise exception 'Choose a call or a chat.' using errcode = '22023';
  end if;
  if char_length(subject) < 1 or char_length(subject) > 160 then
    raise exception 'Add a short subject (up to 160 characters).' using errcode = '22023';
  end if;
  if char_length(message) < 1 or char_length(message) > 4000 then
    raise exception 'Describe the problem (up to 4000 characters).' using errcode = '22023';
  end if;
  if channel = 'call' then
    if phone is null or phone !~ '^\+?[0-9 ()-]{7,20}$' then
      raise exception 'Enter a phone number we can call back on.' using errcode = '22023';
    end if;
  else
    phone := null;
    best_time := null;
  end if;

  insert into public.support_requests (user_id, channel, subject, message, phone, best_time)
  values (actor, channel, subject, message, phone, best_time)
  returning * into row_out;

  if channel = 'chat' then
    insert into public.support_request_messages (request_id, author_id, author_role, body)
    values (row_out.id, actor, 'user', message);
  end if;

  return row_out;
end $$;

-- ---------------------------------------------------------------------------
-- support_request_reply — a message in a request's thread. The owner writes as
-- 'user'; an administrator writes as 'admin'. Anyone else is refused.
-- ---------------------------------------------------------------------------
create or replace function public.support_request_reply(p_request uuid, p_body text)
returns public.support_request_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  req public.support_requests;
  body text := btrim(coalesce(p_body, ''));
  role_out text;
  row_out public.support_request_messages;
begin
  if actor is null then
    raise exception 'Sign in to reply.' using errcode = '42501';
  end if;
  if char_length(body) < 1 or char_length(body) > 4000 then
    raise exception 'Write a message (up to 4000 characters).' using errcode = '22023';
  end if;
  select * into req from public.support_requests where id = p_request;
  if not found then
    raise exception 'That request was not found.' using errcode = 'P0002';
  end if;
  if req.user_id = actor then
    role_out := 'user';
  elsif public.is_admin() then
    role_out := 'admin';
  else
    raise exception 'That request was not found.' using errcode = 'P0002';
  end if;
  if req.channel <> 'chat' then
    raise exception 'Call requests are handled by phone; they have no chat thread.' using errcode = '22023';
  end if;
  if req.status in ('resolved', 'closed') and role_out = 'user' then
    raise exception 'This request is closed. Open a new request if you still need help.' using errcode = '22023';
  end if;

  insert into public.support_request_messages (request_id, author_id, author_role, body)
  values (req.id, actor, role_out, body)
  returning * into row_out;

  update public.support_requests
     set last_message_at = now(), updated_at = now(),
         status = case when role_out = 'user' and status = 'resolved' then 'received' else status end
   where id = req.id;

  return row_out;
end $$;

-- ---------------------------------------------------------------------------
-- support_request_update — administrators only: status, note and assignee.
-- ---------------------------------------------------------------------------
create or replace function public.support_request_update(
  p_request uuid,
  p_status text,
  p_admin_note text default null
)
returns public.support_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  status_in text := lower(coalesce(p_status, ''));
  row_out public.support_requests;
begin
  if actor is null or not public.is_admin() then
    raise exception 'Only an administrator can change a support request.' using errcode = '42501';
  end if;
  if status_in not in ('received', 'in_progress', 'resolved', 'closed') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  update public.support_requests
     set status = status_in,
         admin_note = case when p_admin_note is null then admin_note else nullif(btrim(p_admin_note), '') end,
         assigned_to = actor,
         updated_at = now()
   where id = p_request
  returning * into row_out;
  if row_out.id is null then
    raise exception 'That request was not found.' using errcode = 'P0002';
  end if;
  return row_out;
end $$;

-- ---------------------------------------------------------------------------
-- support_settings_save — administrators only. The note is free text the team
-- chooses; it is shown to users as written, or not at all when empty.
-- ---------------------------------------------------------------------------
create or replace function public.support_settings_save(p_response_time_note text)
returns public.support_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  note text := btrim(coalesce(p_response_time_note, ''));
  row_out public.support_settings;
begin
  if actor is null or not public.is_admin() then
    raise exception 'Only an administrator can change support settings.' using errcode = '42501';
  end if;
  if char_length(note) > 300 then
    raise exception 'Keep the response-time note under 300 characters.' using errcode = '22023';
  end if;
  insert into public.support_settings (key, value, updated_by, updated_at)
  values ('response_time_note', note, actor, now())
  on conflict (key) do update
    set value = excluded.value, updated_by = actor, updated_at = now()
  returning * into row_out;
  return row_out;
end $$;

revoke all on function public.support_request_create(text, text, text, text, text) from public, anon;
revoke all on function public.support_request_reply(uuid, text) from public, anon;
revoke all on function public.support_request_update(uuid, text, text) from public, anon;
revoke all on function public.support_settings_save(text) from public, anon;
grant execute on function public.support_request_create(text, text, text, text, text) to authenticated;
grant execute on function public.support_request_reply(uuid, text) to authenticated;
grant execute on function public.support_request_update(uuid, text, text) to authenticated;
grant execute on function public.support_settings_save(text) to authenticated;
