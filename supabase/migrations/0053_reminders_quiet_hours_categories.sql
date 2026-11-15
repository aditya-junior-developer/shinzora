-- ============================================================================
-- 0053 · Notification reminders, quiet hours and category preferences (P5)
-- ----------------------------------------------------------------------------
-- What this adds
--   * Four-hour reminders for members who have been active before and have been
--     away for four hours. At most one reminder per four hours per member, and
--     never a second one inside the same window. The claim is one atomic upsert
--     on notification_reminder_log, so two runs cannot both send.
--   * Opt-out for reminders (on by default, as the owner chose).
--   * Quiet hours, off by default. Local time comes from the member's own IANA
--     timezone, which the app saves from the browser. An unknown timezone falls
--     back to UTC, so quiet hours never silently turn off.
--   * Per-category push preferences for the existing categories: account,
--     message, call, group, payment, website, team, admin. In-app notices are
--     always stored; a category only controls whether it is also pushed.
--   * Reminders go out as ordinary `notifications` rows with meta.kind =
--     'reminder', so they reach the open tab over Realtime and the closed tab
--     through the existing push path. The push trigger is widened to carry them.
--   * A pg_cron job runs notification_reminders_run() every 15 minutes, when the
--     extension is available. Without it the function still exists and can be
--     called by hand; nothing is sent automatically.
--
-- What this does NOT do
--   * It never sends email or SMS.
--   * It does not read the operating system's notification settings. The browser
--     permission is the only permission this code can see, and it is respected
--     as it is: a denied permission is never asked again.
-- ============================================================================

-- ---------------------------------------------------------------- preferences
alter table public.notification_preferences
  add column if not exists reminders_enabled     boolean  not null default true,
  add column if not exists quiet_hours_enabled   boolean  not null default false,
  add column if not exists quiet_start           smallint not null default 22,
  add column if not exists quiet_end             smallint not null default 8,
  add column if not exists timezone              text     not null default 'UTC',
  add column if not exists categories            jsonb    not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notification_preferences_quiet_hours_range') then
    alter table public.notification_preferences
      add constraint notification_preferences_quiet_hours_range
      check (quiet_start between 0 and 23 and quiet_end between 0 and 23);
  end if;
end $$;

-- ---------------------------------------------------- the reminder claim log
create table if not exists public.notification_reminder_log (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  sent_at  timestamptz not null default now()
);

alter table public.notification_reminder_log enable row level security;
-- No policies: members cannot read or write this table. Only the security
-- definer functions below and the service role touch it.
revoke all on public.notification_reminder_log from public, anon, authenticated;

-- ------------------------------------------------------------- quiet hours
/* True when `p_at` falls inside the member's quiet window, in their timezone.
   The window wraps midnight when start > end (22 to 8 means 22:00 to 08:00).
   Equal start and end means no window. */
create or replace function public.sz_in_quiet_hours(
  p_tz text, p_start smallint, p_end smallint, p_at timestamptz default now()
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  h integer;
begin
  if p_start is null or p_end is null or p_start = p_end then
    return false;
  end if;
  begin
    h := extract(hour from (p_at at time zone coalesce(nullif(btrim(p_tz), ''), 'UTC')))::integer;
  exception when others then
    /* An unknown timezone must not switch quiet hours off. Use UTC. */
    h := extract(hour from (p_at at time zone 'UTC'))::integer;
  end;
  if p_start < p_end then
    return h >= p_start and h < p_end;
  end if;
  return h >= p_start or h < p_end;
end;
$$;

revoke all on function public.sz_in_quiet_hours(text, smallint, smallint, timestamptz) from public, anon, authenticated;
grant execute on function public.sz_in_quiet_hours(text, smallint, smallint, timestamptz) to service_role;

-- ----------------------------------------------------------- the reminder job
/* Sends the due four-hour reminders and returns how many were sent.

   Due means: the member has been active before (last_seen_at, or the account's
   creation when it is missing, is never null for an active member), has been
   away for at least four hours, has reminders on, is not inside quiet hours,
   and has not been reminded in the last four hours. */
create or replace function public.notification_reminders_run(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
  cutoff timestamptz := p_now - interval '4 hours';
begin
  for r in
    select p.id as user_id,
           coalesce(pr.reminders_enabled, true)   as reminders_enabled,
           coalesce(pr.quiet_hours_enabled, false) as quiet_on,
           coalesce(pr.quiet_start, 22::smallint) as quiet_start,
           coalesce(pr.quiet_end, 8::smallint)    as quiet_end,
           coalesce(pr.timezone, 'UTC')           as tz
      from public.profiles p
      left join public.notification_preferences pr on pr.user_id = p.id
     where p.last_seen_at is not null          -- only members who have used the app
       and p.last_seen_at <= cutoff            -- away for four hours or more
  loop
    continue when not r.reminders_enabled;
    continue when r.quiet_on and public.sz_in_quiet_hours(r.tz, r.quiet_start, r.quiet_end, p_now);

    /* Claim the slot first. The insert and the update condition are one
       statement, so a concurrent run either wins the row or sees it already
       claimed in this window. FOUND is true only for the run that claimed it. */
    insert into public.notification_reminder_log (user_id, sent_at)
    values (r.user_id, p_now)
    on conflict (user_id) do update set sent_at = excluded.sent_at
      where public.notification_reminder_log.sent_at <= cutoff;

    if found then
      insert into public.notifications (user_id, title, body, type, link, meta)
      values (
        r.user_id,
        'Shinzora is waiting for you',
        'Open Shinzora to see what has changed since your last visit.',
        'account',
        '/app/',
        jsonb_build_object('kind', 'reminder', 'reminderAt', p_now)
      );
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

revoke all on function public.notification_reminders_run(timestamptz) from public, anon, authenticated;
grant execute on function public.notification_reminders_run(timestamptz) to service_role;

-- --------------------------------------------------- settings read and write
create or replace function public.notification_settings_get()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'remindersEnabled',  coalesce(pr.reminders_enabled, true),
    'quietHoursEnabled', coalesce(pr.quiet_hours_enabled, false),
    'quietStart',        coalesce(pr.quiet_start, 22),
    'quietEnd',          coalesce(pr.quiet_end, 8),
    'timezone',          coalesce(pr.timezone, 'UTC'),
    'categories', jsonb_build_object(
      'account',  coalesce((pr.categories ->> 'account')::boolean, true),
      'message',  coalesce((pr.categories ->> 'message')::boolean, true),
      'call',     coalesce((pr.categories ->> 'call')::boolean, true),
      'group',    coalesce((pr.categories ->> 'group')::boolean, true),
      'payment',  coalesce((pr.categories ->> 'payment')::boolean, true),
      'website',  coalesce((pr.categories ->> 'website')::boolean, true),
      'team',     coalesce((pr.categories ->> 'team')::boolean, true),
      'admin',    coalesce((pr.categories ->> 'admin')::boolean, true)
    )
  )
  from (select 1) as one
  left join public.notification_preferences pr on pr.user_id = auth.uid();
$$;

revoke all on function public.notification_settings_get() from public, anon;
grant execute on function public.notification_settings_get() to authenticated;

/* Writes only the keys it is given. Unknown keys are ignored; a bad hour, a bad
   timezone or a non-boolean category is refused with a message the settings card
   can show. */
create or replace function public.notification_settings_set(p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  allowed constant text[] := array['account','message','call','group','payment','website','team','admin'];
  cat text;
  v jsonb;
  tz text;
begin
  if actor is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Settings must be an object.' using errcode = '22023';
  end if;

  insert into public.notification_preferences (user_id) values (actor)
    on conflict (user_id) do nothing;

  if p_patch ? 'remindersEnabled' then
    if jsonb_typeof(p_patch -> 'remindersEnabled') <> 'boolean' then
      raise exception 'remindersEnabled must be true or false.' using errcode = '22023';
    end if;
    update public.notification_preferences set reminders_enabled = (p_patch ->> 'remindersEnabled')::boolean
     where user_id = actor;
  end if;

  if p_patch ? 'quietHoursEnabled' then
    if jsonb_typeof(p_patch -> 'quietHoursEnabled') <> 'boolean' then
      raise exception 'quietHoursEnabled must be true or false.' using errcode = '22023';
    end if;
    update public.notification_preferences set quiet_hours_enabled = (p_patch ->> 'quietHoursEnabled')::boolean
     where user_id = actor;
  end if;

  if p_patch ? 'quietStart' or p_patch ? 'quietEnd' then
    update public.notification_preferences set
      quiet_start = coalesce((p_patch ->> 'quietStart')::smallint, quiet_start),
      quiet_end   = coalesce((p_patch ->> 'quietEnd')::smallint, quiet_end)
     where user_id = actor;
  end if;

  if p_patch ? 'timezone' then
    tz := btrim(p_patch ->> 'timezone');
    if not exists (select 1 from pg_timezone_names where name = tz) then
      raise exception 'That timezone is not recognised.' using errcode = '22023';
    end if;
    update public.notification_preferences set timezone = tz where user_id = actor;
  end if;

  if p_patch ? 'categories' then
    if jsonb_typeof(p_patch -> 'categories') <> 'object' then
      raise exception 'categories must be an object.' using errcode = '22023';
    end if;
    for cat, v in select key, value from jsonb_each(p_patch -> 'categories') loop
      if cat = any(allowed) then
        if jsonb_typeof(v) <> 'boolean' then
          raise exception 'Each category must be true or false.' using errcode = '22023';
        end if;
        update public.notification_preferences
           set categories = categories || jsonb_build_object(cat, v)
         where user_id = actor;
      end if;
    end loop;
  end if;

  return public.notification_settings_get();
end;
$$;

revoke all on function public.notification_settings_set(jsonb) from public, anon;
grant execute on function public.notification_settings_set(jsonb) to authenticated;

-- ------------------------------------------------- the push trigger carries reminders
/* 0038 pushed only group notifications. A reminder is pushed too, so a member who
   granted permission hears about it with the app closed. */
create or replace function public.notify_push_fanout()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  hook text;
  fn_url text := coalesce(
    nullif(current_setting('shinzora.push_url', true), ''),
    'https://zmkgfmlcpzjfgxdmbtvi.supabase.co/functions/v1/push'
  );
begin
  if new.meta is null then
    return new;
  end if;
  if coalesce(new.meta->>'groupId', '') = '' and coalesce(new.meta->>'kind', '') <> 'reminder' then
    return new;
  end if;

  select decrypted_secret into hook
    from vault.decrypted_secrets
   where name = 'push_hook_secret'
   limit 1;

  if coalesce(hook, '') = '' then
    return new;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-key', hook
    ),
    body := jsonb_build_object('notification_id', new.id),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

revoke all on function public.notify_push_fanout() from public, anon, authenticated;

-- ------------------------------------------------- the schedule
/* pg_cron is optional. Where it is present, the job runs every 15 minutes, so a
   reminder goes out within 15 minutes of the four-hour mark. Where it is absent,
   the migration still succeeds and nothing is scheduled. */
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule(
      'shinzora-notification-reminders',
      '*/15 * * * *',
      'select public.notification_reminders_run();'
    );
  end if;
exception when others then
  raise notice 'pg_cron not scheduled: %', sqlerrm;
end $$;
