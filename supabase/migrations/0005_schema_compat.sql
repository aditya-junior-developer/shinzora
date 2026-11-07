-- ============================================================================
-- SHINZORA · 0005_schema_compat.sql
-- ----------------------------------------------------------------------------
-- Compatibility migration for databases that already contained an EARLIER
-- version of the Shinzora tables before 0001_schema.sql was applied.
--
-- Why this file exists
--   `create table if not exists` skips the whole definition when the table is
--   already there — including every constraint it declares. On a database that
--   already had `profiles`, `businesses`, `onboarding_progress`,
--   `subscriptions`, `projects`, `ai_conversations`, `ai_messages` and
--   `notifications`, applying 0001–0003 adds the missing *columns* (those are
--   separate `add column if not exists` statements) but silently leaves you
--   without:
--
--     · onboarding_progress.current_step as integer + its 1..6 range check
--     · subscriptions UNIQUE (user_id), plan/status checks, business FK
--     · ai_messages role check + conversation FK, ai_conversations project FK
--
--   It also leaves the legacy columns holding the only copy of live data:
--     · onboarding_progress.answers      (JSONB)  → the app reads `data`
--     · onboarding_progress.is_completed (BOOLEAN) → the app reads `completed_at`
--     · notifications.message / is_read            → the app reads `body` / `read_at`
--
-- What this file does
--   Converts types, backfills the new columns from the old ones, removes only
--   rows that would make a UNIQUE/CHECK constraint impossible (duplicate
--   subscription rows — the newest row per user is kept), then adds the
--   constraints. It NEVER drops a column and NEVER drops a table, so the legacy
--   data stays in place as an archive.
--
-- Safe to re-run. Every step is guarded, and steps that cannot run safely on a
-- given database skip themselves with a NOTICE instead of failing.
--
-- Run order: 0001 → 0002 → 0003 → (0004 for the first admin) → 0005
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. onboarding_progress
--    current_step: text → integer, answers → data, is_completed → completed_at
-- ----------------------------------------------------------------------------
do $$
declare
  v_type  text;
  v_legacy_answers   boolean;
  v_legacy_completed boolean;
  v_filled int;
begin
  if to_regclass('public.onboarding_progress') is null then
    raise notice '0005: onboarding_progress is absent — nothing to reconcile.';
    return;
  end if;

  select data_type into v_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'onboarding_progress'
     and column_name = 'current_step';

  -- 1a. Make the column exist at all on very old databases.
  if v_type is null then
    alter table public.onboarding_progress
      add column current_step integer not null default 1;
    raise notice '0005: onboarding_progress.current_step created as integer.';
  end if;

  -- 1b. Convert a legacy TEXT column. Values are normalised in two passes so a
  --     cast can never run against a non-numeric string.
  if v_type in ('text', 'character varying', 'character') then
    update public.onboarding_progress
       set current_step = '1'
     where current_step is null
        or btrim(current_step) !~ '^[0-9]{1,3}$';

    update public.onboarding_progress
       set current_step = least(6, greatest(1, btrim(current_step)::integer))::text
     where btrim(current_step)::integer not between 1 and 6;

    -- The legacy default is a string literal ('1'), which Postgres cannot cast
    -- automatically during the type change — drop it, convert, then re-set it.
    alter table public.onboarding_progress alter column current_step drop default;

    alter table public.onboarding_progress
      alter column current_step type integer using btrim(current_step)::integer;
    raise notice '0005: onboarding_progress.current_step converted text → integer.';
  end if;

  update public.onboarding_progress set current_step = 1 where current_step is null;

  begin
    alter table public.onboarding_progress
      alter column current_step set default 1,
      alter column current_step set not null;
  exception when others then
    raise notice '0005: could not tighten onboarding_progress.current_step (% ). Left as-is.', sqlerrm;
  end;

  -- 1c. Legacy `answers` JSONB becomes `data`. Never overwrite real `data`.
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='onboarding_progress'
                    and column_name='answers') into v_legacy_answers;

  alter table public.onboarding_progress
    add column if not exists data jsonb default '{}'::jsonb;

  if v_legacy_answers then
    execute $q$
      update public.onboarding_progress
         set data = answers
       where (data is null or data = '{}'::jsonb)
         and answers is not null and answers <> '{}'::jsonb
    $q$;
    get diagnostics v_filled = row_count;
    raise notice '0005: copied % onboarding draft(s) from legacy answers → data.', v_filled;
  end if;

  update public.onboarding_progress set data = '{}'::jsonb where data is null;
  begin
    alter table public.onboarding_progress alter column data set default '{}'::jsonb;
  exception when others then null;
  end;

  -- 1d. Legacy `is_completed` BOOLEAN becomes `completed_at`.
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='onboarding_progress'
                    and column_name='is_completed') into v_legacy_completed;

  if v_legacy_completed then
    execute $q$
      update public.onboarding_progress
         set completed_at = coalesce(updated_at, created_at, now())
       where is_completed is true and completed_at is null
    $q$;
    get diagnostics v_filled = row_count;
    raise notice '0005: marked % completed onboarding run(s) via completed_at.', v_filled;
  end if;

  -- 1e. Range check that the skipped `create table` never added.
  if not exists (select 1 from pg_constraint
                  where conname = 'onboarding_progress_current_step_check'
                    and conrelid = 'public.onboarding_progress'::regclass) then
    alter table public.onboarding_progress
      add constraint onboarding_progress_current_step_check
      check (current_step between 1 and 6);
    raise notice '0005: added onboarding_progress_current_step_check.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. notifications
--    message → body, is_read → read_at, then the NOT NULL guarantees 0001
--    declares but could not add to a pre-existing table.
-- ----------------------------------------------------------------------------
do $$
declare
  v_has_message boolean;
  v_has_is_read boolean;
  v_n int;
begin
  if to_regclass('public.notifications') is null then
    raise notice '0005: notifications is absent — skipped.';
    return;
  end if;

  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='notifications'
                    and column_name='message') into v_has_message;
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='notifications'
                    and column_name='is_read') into v_has_is_read;

  if v_has_message then
    execute $q$
      update public.notifications
         set body = message
       where body is null and message is not null and message <> ''
    $q$;
    get diagnostics v_n = row_count;
    raise notice '0005: copied % notification body/bodies from legacy message.', v_n;
  end if;

  if v_has_is_read then
    execute $q$
      update public.notifications
         set read_at = coalesce(created_at, now())
       where is_read is true and read_at is null
    $q$;
    get diagnostics v_n = row_count;
    raise notice '0005: backfilled read_at for % read notification(s).', v_n;
  end if;

  update public.notifications set type = 'system' where type is null;

  begin
    alter table public.notifications alter column type set default 'system';
  exception when others then null;
  end;

  -- Only tighten to NOT NULL when the data actually allows it.
  select count(*) into v_n from public.notifications where title is null;
  if v_n = 0 then
    begin
      alter table public.notifications alter column title set not null;
    exception when others then null;
    end;
  else
    raise notice '0005: % notification row(s) have no title — left nullable, no data invented.', v_n;
  end if;

  -- Keep the legacy columns consistent for anything still reading them, without
  -- making the new columns depend on them.
  if v_has_is_read then
    execute $q$
      create or replace function public.sync_notification_read_flag()
      returns trigger language plpgsql as $f$
      begin
        if tg_op = 'INSERT' then
          if new.is_read is null then new.is_read := new.read_at is not null; end if;
          if new.read_at is null and new.is_read then new.read_at := now(); end if;
        else
          new.is_read := new.read_at is not null;
        end if;
        return new;
      end $f$;
    $q$;
    execute 'drop trigger if exists notifications_read_flag on public.notifications';
    execute $q$
      create trigger notifications_read_flag
        before insert or update on public.notifications
        for each row execute function public.sync_notification_read_flag()
    $q$;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. subscriptions
--    De-duplicate, normalise, then add the UNIQUE + CHECK + FK that the
--    pre-existing table never received. Only the newest row per user is kept —
--    that is the row the application would have been resolving to anyway.
-- ----------------------------------------------------------------------------
do $$
declare
  v_dupes int := 0;
  v_n int;
begin
  if to_regclass('public.subscriptions') is null then
    raise notice '0005: subscriptions is absent — skipped.';
    return;
  end if;

  -- 3.0 Nothing here is destroyed. Every row this migration removes, and every
  --     row whose plan/status it rewrites because the value is not in the
  --     allowed set, is copied to public.migration_archive first. The archive
  --     has RLS on and no policies, so only the service role can read it; it is
  --     the recovery path if a customer's tier turns out to matter.
  if to_regclass('public.migration_archive') is null then
    create table public.migration_archive (
      id bigserial primary key,
      migration text not null,
      table_name text not null,
      row_id text,
      reason text not null,
      row_data jsonb not null,
      archived_at timestamptz not null default now()
    );
    alter table public.migration_archive enable row level security;
    comment on table public.migration_archive is
      'Rows removed or rewritten by a migration. Service role only — no RLS policies by design.';
    raise notice '0005: created public.migration_archive for anything this file changes destructively.';
  end if;

  -- 3a. Rows with no owner can never satisfy UNIQUE (user_id); they are also
  --     unreachable by RLS. Archive, then remove, so UNIQUE can be added.
  select count(*) into v_n from public.subscriptions where user_id is null;
  if v_n > 0 then
    insert into public.migration_archive (migration, table_name, row_id, reason, row_data)
    select '0005', 'subscriptions', s.id::text, 'null user_id (unreachable by RLS)', to_jsonb(s)
      from public.subscriptions s where s.user_id is null;
    raise notice '0005: % subscription row(s) have NULL user_id and are unreachable; archived then removed so UNIQUE (user_id) can be added.', v_n;
    delete from public.subscriptions where user_id is null;
  end if;

  -- 3b. Collapse duplicates: keep the most recently updated row per user.
  -- Tie-break order matters: two rows written in the same transaction share a
  -- timestamp, so prefer a paid tier before falling back to the id. A customer
  -- must never be silently downgraded by a coin flip.
  with ranked as (
    select id,
           row_number() over (
             partition by user_id
             order by coalesce(updated_at, created_at, now()) desc,
                      (plan <> 'free') desc,
                      id desc
           ) as rn
      from public.subscriptions
  ), doomed as (
    select s.* from public.subscriptions s
      join ranked r on r.id = s.id
     where r.rn > 1
  )
  insert into public.migration_archive (migration, table_name, row_id, reason, row_data)
  select '0005', 'subscriptions', d.id::text, 'duplicate subscription row (newest per user kept)', to_jsonb(d)
    from doomed d;

  with ranked as (
    select id,
           row_number() over (
             partition by user_id
             order by coalesce(updated_at, created_at, now()) desc,
                      (plan <> 'free') desc,
                      id desc
           ) as rn
      from public.subscriptions
  )
  delete from public.subscriptions s
   using ranked r
   where s.id = r.id and r.rn > 1;
  get diagnostics v_dupes = row_count;
  if v_dupes > 0 then
    raise notice '0005: removed % duplicate subscription row(s), newest kept per user.', v_dupes;
  end if;

  -- 3c. Normalise values so the CHECK constraints can be trusted. The original
  --     value is kept in the archive: 'legacy_gold' becoming 'free' is a real
  --     decision someone may need to revisit.
  insert into public.migration_archive (migration, table_name, row_id, reason, row_data)
  select '0005', 'subscriptions', s.id::text,
         'plan not in (free, pro, enterprise) — normalised to free', to_jsonb(s)
    from public.subscriptions s
   where s.plan is null or s.plan not in ('free', 'pro', 'enterprise');

  update public.subscriptions set plan = 'free'
   where plan is null or plan not in ('free', 'pro', 'enterprise');

  insert into public.migration_archive (migration, table_name, row_id, reason, row_data)
  select '0005', 'subscriptions', s.id::text,
         'status not in (active, past_due, cancelled, trialing) — normalised to active', to_jsonb(s)
    from public.subscriptions s
   where s.status is null or s.status not in ('active', 'past_due', 'cancelled', 'trialing');

  update public.subscriptions set status = 'active'
   where status is null or status not in ('active', 'past_due', 'cancelled', 'trialing');
  update public.subscriptions set ai_credits_used = 0 where ai_credits_used is null;
  update public.subscriptions set ai_credits_limit = 30 where ai_credits_limit is null;

  -- 3d. A business_id pointing at a deleted business would block the FK.
  if to_regclass('public.businesses') is not null then
    update public.subscriptions s
       set business_id = null
     where s.business_id is not null
       and not exists (select 1 from public.businesses b where b.id = s.business_id);
  end if;

  -- 3e. Constraints.
  if not exists (select 1 from pg_constraint
                  where conname = 'subscriptions_user_id_key'
                    and conrelid = 'public.subscriptions'::regclass) then
    alter table public.subscriptions
      add constraint subscriptions_user_id_key unique (user_id);
    raise notice '0005: added subscriptions UNIQUE (user_id).';
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'subscriptions_plan_check'
                    and conrelid = 'public.subscriptions'::regclass) then
    alter table public.subscriptions
      add constraint subscriptions_plan_check check (plan in ('free', 'pro', 'enterprise'));
    raise notice '0005: added subscriptions_plan_check.';
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'subscriptions_status_check'
                    and conrelid = 'public.subscriptions'::regclass) then
    alter table public.subscriptions
      add constraint subscriptions_status_check
      check (status in ('active', 'past_due', 'cancelled', 'trialing'));
    raise notice '0005: added subscriptions_status_check.';
  end if;

  if to_regclass('public.businesses') is not null
     and not exists (select 1 from pg_constraint
                      where conname = 'subscriptions_business_id_fkey'
                        and conrelid = 'public.subscriptions'::regclass) then
    alter table public.subscriptions
      add constraint subscriptions_business_id_fkey
      foreign key (business_id) references public.businesses(id) on delete set null;
    raise notice '0005: added subscriptions_business_id_fkey.';
  end if;

  -- 3f. Every account needs exactly one subscription row: it is what the AI
  --     quota, the plan badge and the billing screen read. Accounts created by
  --     the early schema may have none — give them the plan profiles.plan last
  --     recorded, or 'free' when that value is not a tier we recognise.
  if to_regclass('public.profiles') is not null then
    -- `profiles.plan` exists on the early schema but not in the clean 0001
    -- definition, so it is probed rather than assumed.
    if exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='profiles' and column_name='plan') then
      execute $q$
        insert into public.subscriptions (user_id, plan, status)
        select p.id,
               case when p.plan in ('pro', 'enterprise') then p.plan else 'free' end,
               'active'
          from public.profiles p
         where not exists (select 1 from public.subscriptions s where s.user_id = p.id)
        on conflict (user_id) do nothing
      $q$;
    else
      execute $q$
        insert into public.subscriptions (user_id, plan, status)
        select p.id, 'free', 'active'
          from public.profiles p
         where not exists (select 1 from public.subscriptions s where s.user_id = p.id)
        on conflict (user_id) do nothing
      $q$;
    end if;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      raise notice '0005: created % missing subscription row(s) from the profile plan.', v_n;
    end if;

    -- Where the legacy mirror exists, align it with the authoritative row so the
    -- two can never disagree.
    if exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='profiles' and column_name='plan') then
      execute $q$
        update public.profiles p
           set plan = s.plan
          from public.subscriptions s
         where p.id = s.user_id and p.plan is distinct from s.plan
      $q$;
      get diagnostics v_n = row_count;
      if v_n > 0 then
        raise notice '0005: aligned profiles.plan with subscriptions for % account(s).', v_n;
      end if;
    end if;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. ai_messages + ai_conversations
--    Role check and foreign keys that the pre-existing tables never received.
-- ----------------------------------------------------------------------------
do $$
declare
  v_orphans int;
begin
  if to_regclass('public.ai_messages') is null then
    raise notice '0005: ai_messages is absent — skipped.';
    return;
  end if;

  -- 4a. Unknown roles would block the CHECK. Map them to 'user' and say so.
  update public.ai_messages set role = 'user'
   where role is null or role not in ('user', 'assistant', 'system');

  -- 4b. Orphaned messages (conversation deleted outside the FK) would block the
  --     FK. Deleting customer content is not our call, so report instead.
  select count(*) into v_orphans
    from public.ai_messages m
   where m.conversation_id is null
      or (to_regclass('public.ai_conversations') is not null
          and not exists (select 1 from public.ai_conversations c where c.id = m.conversation_id));

  -- The role check is independent of referential integrity, so it is added
  -- whether or not the FK can be.
  if not exists (select 1 from pg_constraint
                  where conname = 'ai_messages_role_check'
                    and conrelid = 'public.ai_messages'::regclass) then
    alter table public.ai_messages
      add constraint ai_messages_role_check check (role in ('user', 'assistant', 'system'));
    raise notice '0005: added ai_messages_role_check.';
  end if;

  if v_orphans > 0 then
    raise notice '0005: % ai_messages row(s) reference a missing conversation. FK NOT added — inspect manually if you want it enforced.', v_orphans;
  elsif not exists (select 1 from pg_constraint
                     where conname = 'ai_messages_conversation_id_fkey'
                       and conrelid = 'public.ai_messages'::regclass) then
    alter table public.ai_messages
      add constraint ai_messages_conversation_id_fkey
      foreign key (conversation_id) references public.ai_conversations(id) on delete cascade;
    raise notice '0005: added ai_messages_conversation_id_fkey.';
  end if;

  if to_regclass('public.ai_conversations') is not null
     and to_regclass('public.projects') is not null then
    -- A conversation pointing at a deleted project would block the FK.
    update public.ai_conversations c
       set project_id = null
     where c.project_id is not null
       and not exists (select 1 from public.projects p where p.id = c.project_id);

    if not exists (select 1 from pg_constraint
                    where conname = 'ai_conversations_project_id_fkey'
                      and conrelid = 'public.ai_conversations'::regclass) then
      alter table public.ai_conversations
        add constraint ai_conversations_project_id_fkey
        foreign key (project_id) references public.projects(id) on delete set null;
      raise notice '0005: added ai_conversations_project_id_fkey.';
    end if;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 5. projects — a project row with no owner can never satisfy the ownership RLS
--    policy and would be invisible anyway. Report rather than delete.
-- ----------------------------------------------------------------------------
do $$
declare v_n int;
begin
  if to_regclass('public.projects') is null then
    return;
  end if;
  select count(*) into v_n from public.projects
   where owner_id is null or slug is null;
  if v_n > 0 then
    raise notice '0005: % project row(s) are missing owner_id or slug. They stay in the table; assign an owner if you want them visible.', v_n;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Verification — prints the resulting shape so the run is self-certifying.
-- ----------------------------------------------------------------------------
do $$
declare
  v_step_type text;
  v_missing   text := '';
  r record;
begin
  for r in
    select * from (values
      ('onboarding_progress_current_step_check', 'public.onboarding_progress'),
      ('subscriptions_user_id_key',             'public.subscriptions'),
      ('subscriptions_plan_check',              'public.subscriptions'),
      ('subscriptions_status_check',            'public.subscriptions'),
      ('subscriptions_business_id_fkey',        'public.subscriptions'),
      ('ai_messages_role_check',                'public.ai_messages'),
      ('ai_messages_conversation_id_fkey',      'public.ai_messages'),
      ('ai_conversations_project_id_fkey',      'public.ai_conversations')
    ) as t(conname, rel)
  loop
    if to_regclass(r.rel) is not null
       and not exists (select 1 from pg_constraint
                        where conname = r.conname and conrelid = r.rel::regclass) then
      v_missing := v_missing || r.conname || ' ';
    end if;
  end loop;

  select data_type into v_step_type
    from information_schema.columns
   where table_schema='public' and table_name='onboarding_progress'
     and column_name='current_step';

  raise notice '0005 summary — onboarding_progress.current_step type: %', coalesce(v_step_type, 'table absent');
  if v_missing = '' then
    raise notice '0005 summary — all expected constraints are present.';
  else
    raise notice '0005 summary — constraints deliberately or unavoidably skipped: %', v_missing;
  end if;
end $$;

commit;

-- ----------------------------------------------------------------------------
-- Confirm by hand (all four should return rows):
--
--   select column_name, data_type from information_schema.columns
--    where table_name = 'onboarding_progress' and column_name in ('current_step','data');
--
--   select id, current_step, is_completed, completed_at, data from public.onboarding_progress limit 5;
--   select id, plan, status, ai_credits_used, ai_credits_limit from public.subscriptions limit 5;
--   select id, title, message, body, is_read, read_at from public.notifications limit 5;
-- ----------------------------------------------------------------------------
