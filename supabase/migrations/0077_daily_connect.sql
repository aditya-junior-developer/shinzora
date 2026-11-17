-- ============================================================================
-- 0077 — SHINZORA CONNECT: Daily.co meetings
--
-- New meetings run in a Daily room (provider = 'daily'). Older meetings keep
-- the in-app WebRTC mesh (provider = 'mesh') and are untouched.
--
-- Rules this migration enforces in the database, not only in the app:
--   - a meeting that has ended keeps a link for 24 hours; expires_at is set by
--     a trigger from ended_at, so no code path can leave it unset or wrong
--   - reopening a meeting clears ended_at and expires_at together
--   - the new tables are unreadable and unwritable by browsers; only the
--     `daily` Edge Function (service role) reads and writes them, and it
--     checks the caller on every request
--
-- Daily's API key never reaches the database or the browser. It is an Edge
-- Function secret (DAILY_API_KEY).
-- ============================================================================

-- ------------------------------------------------------------ meetings: Daily
alter table public.meetings
  add column if not exists provider          text not null default 'mesh',
  add column if not exists daily_room_name   text,
  add column if not exists daily_room_url    text,
  add column if not exists session_no        integer not null default 0,
  add column if not exists expires_at        timestamptz,
  add column if not exists create_request_id uuid,
  add column if not exists scheduled_for     timestamptz;

alter table public.meetings drop constraint if exists meetings_provider_check;
alter table public.meetings add constraint meetings_provider_check
  check (provider in ('mesh', 'daily'));

alter table public.meetings drop constraint if exists meetings_session_no_check;
alter table public.meetings add constraint meetings_session_no_check
  check (session_no >= 0);

alter table public.meetings drop constraint if exists meetings_expiry_check;
alter table public.meetings add constraint meetings_expiry_check
  check (expires_at is null or (ended_at is not null and expires_at > ended_at));

-- One live Daily room per meeting, and one room name per session.
create unique index if not exists meetings_daily_room_name_key
  on public.meetings (daily_room_name) where daily_room_name is not null;

-- A double-clicked "Create" returns the same meeting, never a second one.
create unique index if not exists meetings_create_request_key
  on public.meetings (host_id, create_request_id) where create_request_id is not null;

create index if not exists meetings_expires_idx
  on public.meetings (expires_at) where expires_at is not null;

-- The 24-hour rule. Ending a meeting sets its expiry; reopening clears it.
create or replace function public.meetings_expiry_guard()
returns trigger
language plpgsql
set search_path to public
as $$
begin
  if new.ended_at is null then
    new.expires_at := null;
  elsif tg_op = 'INSERT' or old.ended_at is distinct from new.ended_at then
    new.expires_at := new.ended_at + interval '24 hours';
  end if;
  return new;
end $$;

drop trigger if exists meetings_expiry_guard on public.meetings;
create trigger meetings_expiry_guard
  before insert or update of ended_at on public.meetings
  for each row execute function public.meetings_expiry_guard();

-- Existing ended meetings get the same rule, so nothing is left open-ended.
update public.meetings
   set expires_at = ended_at + interval '24 hours'
 where ended_at is not null and expires_at is null;

-- ------------------------------------------------- meeting managers (grants)
-- A manager may host any meeting: end it, lock it, remove people, see the
-- activity. Granted by an administrator only.
create table if not exists public.meeting_managers (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now()
);

-- ------------------------------------------------------- activity (events)
create table if not exists public.meeting_events (
  id         bigint generated always as identity primary key,
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  kind       text not null check (kind in (
    'created', 'session_started', 'joined', 'left', 'refused',
    'locked', 'unlocked', 'ended', 'removed', 'room_cleaned',
    'screen_share_started', 'screen_share_stopped',
    'manager_granted', 'manager_revoked'
  )),
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists meeting_events_meeting_idx
  on public.meeting_events (meeting_id, created_at desc);

-- ------------------------------------------------------- in-meeting chat
create table if not exists public.meeting_chat_messages (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings(id) on delete cascade,
  session_no   integer not null default 0,
  author_id    uuid references public.profiles(id) on delete set null,
  author_name  text not null check (char_length(btrim(author_name)) between 1 and 120),
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at   timestamptz not null default now()
);

create index if not exists meeting_chat_meeting_idx
  on public.meeting_chat_messages (meeting_id, created_at);

-- ----------------------------------------------------------- access lock
alter table public.meeting_managers       enable row level security;
alter table public.meeting_events         enable row level security;
alter table public.meeting_chat_messages  enable row level security;

revoke all on public.meeting_managers, public.meeting_events, public.meeting_chat_messages
  from anon, authenticated;

-- No policies on purpose: with RLS on and no policy, browsers can read or
-- write none of these rows. The `daily` function uses the service role and
-- applies its own checks.
