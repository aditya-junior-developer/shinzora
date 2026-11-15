-- ============================================================================
-- 0057 — Meeting scheduling (P8)
--
-- A meeting can now be booked for a later time. The host gets the same code
-- and link as an instant meeting. Joining is still governed by meeting_join:
-- a scheduled meeting can be joined early, because the host decides when
-- people are let in, and a locked or ended meeting still refuses everyone.
--
-- Scheduling is refused in the database, not only in the browser:
--   - the time must be at least one minute from now
--   - and no more than 366 days ahead
-- ============================================================================

alter table public.meetings add column if not exists scheduled_for timestamptz;

comment on column public.meetings.scheduled_for is
  'When the host planned the meeting. Null for an instant meeting. Joining is not restricted by it.';

create index if not exists meetings_scheduled_idx
  on public.meetings (host_id, scheduled_for)
  where scheduled_for is not null;

create or replace function public.meeting_schedule(
  p_title text,
  p_kind text,
  p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to public
as $$
declare
  actor uuid := auth.uid();
  clean_title text := coalesce(nullif(btrim(p_title), ''), 'Meeting');
  clean_kind text := case when lower(coalesce(p_kind, 'video')) = 'voice' then 'voice' else 'video' end;
  new_code text;
  attempt integer := 0;
  meeting public.meetings%rowtype;
begin
  if actor is null then raise exception 'Sign in to schedule a meeting.' using errcode = '42501'; end if;
  if p_at is null then raise exception 'Choose a date and time for the meeting.' using errcode = '22023'; end if;
  if p_at < now() + interval '1 minute' then
    raise exception 'Choose a time at least a minute from now.' using errcode = '22023';
  end if;
  if p_at > now() + interval '366 days' then
    raise exception 'Choose a time within the next year.' using errcode = '22023';
  end if;

  loop
    attempt := attempt + 1;
    new_code := public.meeting_code();
    exit when not exists (select 1 from public.meetings where code = new_code);
    if attempt > 12 then raise exception 'Could not allocate a meeting code. Try again.' using errcode = 'P0001'; end if;
  end loop;

  insert into public.meetings (code, title, kind, host_id, scheduled_for)
  values (new_code, left(clean_title, 120), clean_kind, actor, p_at)
  returning * into meeting;

  insert into public.meeting_attendees (meeting_id, user_id, role)
  values (meeting.id, actor, 'host')
  on conflict (meeting_id, user_id) do update set left_at = null, role = 'host';

  return jsonb_build_object(
    'id', meeting.id,
    'code', meeting.code,
    'title', meeting.title,
    'kind', meeting.kind,
    'scheduledFor', meeting.scheduled_for,
    'joinUrl', '/app/?view=meeting&code=' || meeting.code
  );
end $$;

revoke all on function public.meeting_schedule(text, text, timestamptz) from public, anon;
grant execute on function public.meeting_schedule(text, text, timestamptz) to authenticated, service_role;

/**
 * The host's upcoming scheduled meetings: booked, not ended, and not more than
 * a day past their time. Only the host sees their own bookings.
 */
create or replace function public.meeting_upcoming(p_limit integer default 20)
returns setof jsonb
language sql
stable
security definer
set search_path to public
as $$
  select jsonb_build_object(
           'id', m.id,
           'code', m.code,
           'title', m.title,
           'kind', m.kind,
           'scheduledFor', m.scheduled_for,
           'isLocked', m.is_locked
         )
  from public.meetings m
  where m.host_id = auth.uid()
    and m.scheduled_for is not null
    and m.ended_at is null
    and m.scheduled_for > now() - interval '1 day'
  order by m.scheduled_for asc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

revoke all on function public.meeting_upcoming(integer) from public, anon;
grant execute on function public.meeting_upcoming(integer) to authenticated, service_role;
