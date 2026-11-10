-- 0023 · Two kinds of account: owners and agents
-- ---------------------------------------------------------------------------
-- Until now every account was assumed to run a business, and the onboarding
-- wizard forced a business name before anyone could reach the dashboard. This
-- adds the other half of the platform:
--
--   owner   runs a business, posts projects, hires agents
--   agent   sells skills, browses businesses, pitches on projects
--
-- An "agent" is what the marketplace already called a freelancer. The tables
-- from 0020 are extended rather than duplicated, so there is one profile, one
-- proposal and one contract model rather than two that drift apart.
--
-- Also here: a unique handle per account (backfilled for everyone who already
-- exists), agent-specific terms (expected pay, hours, equity, ESOP), project
-- requirements with screening questions, and the two lookups the UI needs —
-- find a person by username, list discoverable businesses.

-- ===========================================================================
-- 1 · identity: username and account type
-- ===========================================================================

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists account_type text;

-- Existing rows predate the column. 'owner' is what every account was, so the
-- default keeps them working; onboarding now asks, and settings can change it.
update public.profiles set account_type = 'owner' where account_type is null;
alter table public.profiles alter column account_type set default 'owner';
alter table public.profiles alter column account_type set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass and conname = 'profiles_account_type_check'
  ) then
    alter table public.profiles
      add constraint profiles_account_type_check check (account_type in ('owner', 'agent'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass and conname = 'profiles_username_format'
  ) then
    alter table public.profiles
      add constraint profiles_username_format
      check (username is null or username ~ '^[a-z0-9][a-z0-9._]{2,29}$');
  end if;
end $$;

/* Handles are compared case-insensitively: "@Riya" and "@riya" are the same
   person, so a plain unique index on the raw text would let both exist. */
create unique index if not exists profiles_username_key
  on public.profiles (lower(username)) where username is not null;

/* ---------------------------------------------------------- backfill
   Everyone who registered before the column existed needs a handle now.
   Seeded from the email local part, stripped to the allowed alphabet, then
   given a numeric suffix until it is free. Deterministic and run once: rows
   that already have a username are skipped, so re-running the migration on
   production after new signups changes nothing for them. */
do $$
declare
  row_record record;
  base text;
  candidate text;
  suffix integer;
begin
  for row_record in
    select id,
           coalesce(
             nullif(regexp_replace(lower(split_part(coalesce(email, ''), '@', 1)), '[^a-z0-9._]', '', 'g'), ''),
             nullif(regexp_replace(lower(coalesce(full_name, '')), '[^a-z0-9._]', '', 'g'), ''),
             'member'
           ) as seed
      from public.profiles
     where username is null
     order by created_at nulls first
  loop
    base := left(row_record.seed, 24);
    /* The format constraint needs a leading letter or digit and 3 characters
       minimum; an email like "a_b@x.com" would otherwise produce a short or
       punctuation-leading handle. */
    base := regexp_replace(base, '^[^a-z0-9]+', '');
    if length(base) < 3 then
      base := 'member' || substr(replace(row_record.id::text, '-', ''), 1, 4);
    end if;

    candidate := base;
    suffix := 1;
    while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
      suffix := suffix + 1;
      candidate := left(base, 26) || suffix::text;
    end loop;

    update public.profiles set username = candidate where id = row_record.id;
  end loop;
end $$;

-- New signups get a provisional handle from the same generator, so a row is
-- never left without one. Onboarding lets the person choose their own.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  seed text;
  candidate text;
  suffix integer := 0;
begin
  seed := regexp_replace(lower(split_part(coalesce(new.email, ''), '@', 1)), '[^a-z0-9._]', '', 'g');
  seed := regexp_replace(seed, '^[^a-z0-9]+', '');
  if length(seed) < 3 then
    seed := 'member' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  seed := left(seed, 24);

  candidate := seed;
  while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
    suffix := suffix + 1;
    candidate := left(seed, 26) || suffix::text;
  end loop;

  insert into public.profiles (id, full_name, email, username, account_type)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
    new.email,
    candidate,
    case when new.raw_user_meta_data->>'account_type' = 'agent' then 'agent' else 'owner' end
  )
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id, plan, status, ai_credits_limit)
  values (new.id, 'free', 'active', 30)
  on conflict (user_id) do nothing;

  insert into public.onboarding_progress (user_id, current_step, data)
  values (new.id, 1, '{}'::jsonb)
  on conflict (user_id) do nothing;

  insert into public.notifications (user_id, title, body, type, link)
  values (
    new.id,
    'Welcome to Shinzora',
    'Finish onboarding so Shinzora knows whether you are hiring or looking for work.',
    'account',
    '/onboarding/'
  );

  return new;
end;
$$;

-- ===========================================================================
-- 2 · what an agent brings: the profile the pitch is built from
-- ===========================================================================

alter table public.freelancer_profiles
  add column if not exists seeking text,
  add column if not exists expected_rate numeric(12,2),
  add column if not exists expected_currency text default 'INR',
  add column if not exists hours_per_week integer,
  add column if not exists notice_period_days integer,
  add column if not exists location text,
  add column if not exists remote_ok boolean not null default true,
  add column if not exists equity_ok boolean not null default false,
  add column if not exists equity_min_pct numeric(5,2),
  add column if not exists equity_max_pct numeric(5,2),
  add column if not exists esop_ok boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.freelancer_profiles'::regclass and conname = 'freelancer_profiles_equity_range') then
    alter table public.freelancer_profiles
      add constraint freelancer_profiles_equity_range
      check (
        (equity_min_pct is null or (equity_min_pct >= 0 and equity_min_pct <= 100))
        and (equity_max_pct is null or (equity_max_pct >= 0 and equity_max_pct <= 100))
        and (equity_min_pct is null or equity_max_pct is null or equity_max_pct >= equity_min_pct)
      );
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.freelancer_profiles'::regclass and conname = 'freelancer_profiles_expected_rate') then
    alter table public.freelancer_profiles
      add constraint freelancer_profiles_expected_rate
      check (expected_rate is null or (expected_rate >= 0 and expected_rate <= 100000000));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.freelancer_profiles'::regclass and conname = 'freelancer_profiles_hours') then
    alter table public.freelancer_profiles
      add constraint freelancer_profiles_hours
      check (hours_per_week is null or (hours_per_week between 1 and 100));
  end if;
end $$;

-- ===========================================================================
-- 3 · projects: requirements, theme, website, screening questions
-- ===========================================================================

alter table public.marketplace_jobs
  add column if not exists requirements text,
  add column if not exists theme text,
  add column if not exists website_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketplace_jobs'::regclass and conname = 'marketplace_jobs_requirements_len') then
    alter table public.marketplace_jobs
      add constraint marketplace_jobs_requirements_len
      check (requirements is null or char_length(requirements) between 20 and 8000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.marketplace_jobs'::regclass and conname = 'marketplace_jobs_website_url') then
    alter table public.marketplace_jobs
      add constraint marketplace_jobs_website_url
      check (website_url is null or website_url ~* '^https?://');
  end if;
end $$;

/* The owner's screening questions. Kept in their own table so the ordering is
   explicit and a pitch can answer them by question id rather than by index. */
create table if not exists public.marketplace_job_questions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.marketplace_jobs(id) on delete cascade,
  position integer not null check (position between 1 and 20),
  prompt text not null check (char_length(btrim(prompt)) between 4 and 240),
  created_at timestamptz not null default now(),
  unique (job_id, position)
);
create index if not exists marketplace_job_questions_job_idx
  on public.marketplace_job_questions (job_id, position);

alter table public.marketplace_job_questions enable row level security;

drop policy if exists marketplace_job_questions_read on public.marketplace_job_questions;
create policy marketplace_job_questions_read on public.marketplace_job_questions
  for select to authenticated using (
    exists (
      select 1 from public.marketplace_jobs j
       where j.id = job_id
         and (j.status = 'open' or j.owner_id = auth.uid())
    )
  );

-- A pitch carries the answers with it.
alter table public.marketplace_proposals
  add column if not exists answers jsonb not null default '{}'::jsonb;

-- ===========================================================================
-- 4 · discoverability
-- ===========================================================================

/* Owners can keep a business out of the directory while they are still setting
   it up. The column is what marketplace_list_businesses filters on. */
alter table public.businesses add column if not exists discoverable boolean not null default true;

-- ===========================================================================
-- 5 · functions
-- ===========================================================================

/* ---------------------------------------------------------------- username */

create or replace function public.username_is_reserved(p_username text)
returns boolean language sql immutable as $$
  select lower(btrim(coalesce(p_username, ''))) in (
    'admin', 'administrator', 'root', 'shinzora', 'support', 'help', 'api', 'app',
    'www', 'mail', 'billing', 'payments', 'security', 'system', 'moderator', 'staff',
    'owner', 'agent', 'marketplace', 'settings', 'login', 'signup', 'null', 'undefined'
  );
$$;

create or replace function public.username_available(p_username text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  wanted text := lower(btrim(coalesce(p_username, '')));
  actor uuid := auth.uid();
begin
  if wanted !~ '^[a-z0-9][a-z0-9._]{2,29}$' then
    return jsonb_build_object(
      'available', false,
      'reason', 'invalid',
      'message', 'Use 3–30 characters: letters, numbers, dots or underscores, starting with a letter or number.'
    );
  end if;
  if public.username_is_reserved(wanted) then
    return jsonb_build_object('available', false, 'reason', 'reserved', 'message', 'That handle is reserved.');
  end if;
  if exists (
    select 1 from public.profiles p
     where lower(p.username) = wanted and p.id is distinct from actor
  ) then
    return jsonb_build_object('available', false, 'reason', 'taken', 'message', 'That handle is already taken.');
  end if;
  return jsonb_build_object('available', true, 'reason', 'ok', 'message', 'Available.');
end;
$$;

create or replace function public.set_username(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  wanted text := lower(btrim(coalesce(p_username, '')));
  verdict jsonb;
  saved text;
begin
  if actor is null then raise exception 'Sign in to change your handle.' using errcode = '42501'; end if;
  verdict := public.username_available(wanted);
  if not (verdict->>'available')::boolean then
    raise exception '%', verdict->>'message' using errcode = '22023';
  end if;
  update public.profiles set username = wanted, updated_at = now() where id = actor
  returning username into saved;
  if saved is null then raise exception 'Profile not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('username', saved);
end;
$$;

create or replace function public.set_account_type(p_type text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  wanted text := lower(btrim(coalesce(p_type, '')));
begin
  if actor is null then raise exception 'Sign in to change your account type.' using errcode = '42501'; end if;
  if wanted not in ('owner', 'agent') then
    raise exception 'Choose whether you run a business or work as an agent.' using errcode = '22023';
  end if;
  update public.profiles set account_type = wanted, updated_at = now() where id = actor;
  return jsonb_build_object('accountType', wanted);
end;
$$;

/* ------------------------------------------------------------ agent profile */
/* Supersedes marketplace_upsert_freelancer (0020), which stays in place so an
   older tab in the wild keeps working. Marking yourself an agent also flips the
   account type, because a published profile and an "owner" account are two
   different answers to the same question. */

create or replace function public.marketplace_save_agent(
  p_headline text,
  p_bio text,
  p_skills text[],
  p_expected_rate numeric,
  p_currency text,
  p_availability text,
  p_portfolio_url text,
  p_years_experience integer,
  p_seeking text,
  p_hours_per_week integer,
  p_notice_period_days integer,
  p_location text,
  p_remote_ok boolean,
  p_equity_ok boolean,
  p_equity_min_pct numeric,
  p_equity_max_pct numeric,
  p_esop_ok boolean,
  p_publish boolean
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  kind text := upper(btrim(coalesce(p_currency, 'INR')));
  saved public.freelancer_profiles%rowtype;
begin
  if actor is null then raise exception 'Sign in to manage an agent profile.' using errcode = '42501'; end if;
  if kind !~ '^[A-Z]{3}$' then raise exception 'Currency must be a three-letter code.' using errcode = '22023'; end if;
  if coalesce(p_availability, 'available') not in ('available', 'busy', 'unavailable') then
    raise exception 'Choose a valid availability.' using errcode = '22023';
  end if;
  if p_portfolio_url is not null and btrim(p_portfolio_url) <> '' and btrim(p_portfolio_url) !~* '^https?://' then
    raise exception 'Portfolio links must start with http:// or https://.' using errcode = '22023';
  end if;
  if coalesce(p_equity_ok, false) and p_equity_min_pct is null and p_equity_max_pct is null then
    raise exception 'Say how much equity you would consider, or turn equity off.' using errcode = '22023';
  end if;
  if p_equity_min_pct is not null and p_equity_max_pct is not null and p_equity_max_pct < p_equity_min_pct then
    raise exception 'The equity maximum cannot be below the minimum.' using errcode = '22023';
  end if;
  if not coalesce(p_equity_ok, false) then
    p_equity_min_pct := null;
    p_equity_max_pct := null;
  end if;

  insert into public.freelancer_profiles as f (
    user_id, headline, bio, skills, hourly_rate, currency, availability, portfolio_url,
    years_experience, is_published, seeking, expected_rate, expected_currency, hours_per_week,
    notice_period_days, location, remote_ok, equity_ok, equity_min_pct, equity_max_pct, esop_ok, updated_at
  )
  values (
    actor,
    left(btrim(coalesce(p_headline, '')), 120),
    left(btrim(coalesce(p_bio, '')), 2000),
    public.marketplace_clean_skills(p_skills),
    p_expected_rate,
    kind,
    coalesce(p_availability, 'available'),
    nullif(btrim(coalesce(p_portfolio_url, '')), ''),
    p_years_experience,
    coalesce(p_publish, false),
    left(btrim(coalesce(p_seeking, '')), 500),
    p_expected_rate,
    kind,
    p_hours_per_week,
    p_notice_period_days,
    left(btrim(coalesce(p_location, '')), 120),
    coalesce(p_remote_ok, true),
    coalesce(p_equity_ok, false),
    p_equity_min_pct,
    p_equity_max_pct,
    coalesce(p_esop_ok, false),
    now()
  )
  on conflict (user_id) do update set
    headline = excluded.headline,
    bio = excluded.bio,
    skills = excluded.skills,
    hourly_rate = excluded.hourly_rate,
    currency = excluded.currency,
    availability = excluded.availability,
    portfolio_url = excluded.portfolio_url,
    years_experience = excluded.years_experience,
    is_published = excluded.is_published,
    seeking = excluded.seeking,
    expected_rate = excluded.expected_rate,
    expected_currency = excluded.expected_currency,
    hours_per_week = excluded.hours_per_week,
    notice_period_days = excluded.notice_period_days,
    location = excluded.location,
    remote_ok = excluded.remote_ok,
    equity_ok = excluded.equity_ok,
    equity_min_pct = excluded.equity_min_pct,
    equity_max_pct = excluded.equity_max_pct,
    esop_ok = excluded.esop_ok,
    updated_at = now()
  returning * into saved;

  update public.profiles
     set account_type = 'agent', updated_at = now()
   where id = actor and account_type <> 'agent';

  return jsonb_build_object(
    'userId', saved.user_id,
    'headline', saved.headline,
    'skills', saved.skills,
    'expectedRate', saved.expected_rate,
    'currency', saved.currency,
    'availability', saved.availability,
    'equityOk', saved.equity_ok,
    'esopOk', saved.esop_ok,
    'isPublished', saved.is_published
  );
end;
$$;

/* ---------------------------------------------------------------- projects */

create or replace function public.marketplace_create_project(
  p_title text,
  p_description text,
  p_requirements text,
  p_skills text[],
  p_budget_min numeric,
  p_budget_max numeric,
  p_currency text,
  p_delivery_days integer,
  p_theme text,
  p_website text,
  p_questions text[]
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  kind text := upper(btrim(coalesce(p_currency, 'INR')));
  made public.marketplace_jobs%rowtype;
  question text;
  position integer := 0;
  asked integer := 0;
begin
  if actor is null then raise exception 'Sign in to post a project.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 4 and 140 then
    raise exception 'Give the project a title of at least 4 characters.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) < 20 then
    raise exception 'Describe the work in at least 20 characters.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_requirements, ''))) < 20 then
    raise exception 'Write the requirements in at least 20 characters — what the agent must actually do.' using errcode = '22023';
  end if;
  if kind !~ '^[A-Z]{3}$' then raise exception 'Currency must be a three-letter code.' using errcode = '22023'; end if;
  if p_budget_min is not null and p_budget_max is not null and p_budget_max < p_budget_min then
    raise exception 'The maximum budget cannot be below the minimum.' using errcode = '22023';
  end if;
  if p_website is not null and btrim(p_website) <> '' and btrim(p_website) !~* '^https?://' then
    raise exception 'Website links must start with http:// or https://.' using errcode = '22023';
  end if;
  if coalesce(array_length(p_questions, 1), 0) > 10 then
    raise exception 'Keep it to ten screening questions.' using errcode = '22023';
  end if;

  insert into public.marketplace_jobs (
    owner_id, business_id, title, description, requirements, skills,
    budget_min, budget_max, currency, delivery_days, theme, website_url, status
  )
  values (
    actor,
    (select id from public.businesses where owner_id = actor order by created_at limit 1),
    btrim(p_title),
    btrim(p_description),
    btrim(p_requirements),
    public.marketplace_clean_skills(p_skills),
    p_budget_min, p_budget_max, kind, p_delivery_days,
    nullif(btrim(coalesce(p_theme, '')), ''),
    nullif(btrim(coalesce(p_website, '')), ''),
    'open'
  )
  returning * into made;

  foreach question in array coalesce(p_questions, array[]::text[]) loop
    position := position + 1;
    if char_length(btrim(coalesce(question, ''))) < 4 then
      continue;
    end if;
    insert into public.marketplace_job_questions (job_id, position, prompt)
    values (made.id, position, left(btrim(question), 240));
    asked := asked + 1;
  end loop;

  return jsonb_build_object('jobId', made.id, 'status', made.status, 'title', made.title, 'questions', asked);
end;
$$;

/* ------------------------------------------------------------------ pitch */

create or replace function public.marketplace_pitch(
  p_job uuid,
  p_cover_note text,
  p_bid_amount numeric,
  p_delivery_days integer,
  p_answers jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  job public.marketplace_jobs%rowtype;
  saved public.marketplace_proposals%rowtype;
  clean_answers jsonb := '{}'::jsonb;
  answer_record record;
  asked integer := 0;
  answered integer := 0;
begin
  if actor is null then raise exception 'Sign in to pitch.' using errcode = '42501'; end if;

  select * into job from public.marketplace_jobs j where j.id = p_job;
  if job.id is null then raise exception 'Project not found.' using errcode = 'P0002'; end if;
  if job.status <> 'open' then raise exception 'This project is no longer accepting pitches.' using errcode = '22023'; end if;
  if job.owner_id = actor then raise exception 'You cannot pitch on your own project.' using errcode = '42501'; end if;
  if p_bid_amount is null or p_bid_amount <= 0 then raise exception 'Enter a bid above zero.' using errcode = '22023'; end if;
  if p_delivery_days is null or p_delivery_days < 1 or p_delivery_days > 730 then
    raise exception 'Delivery must be between 1 and 730 days.' using errcode = '22023';
  end if;

  /* Answers are keyed by question id. Anything the owner did not ask is
     dropped, and every asked question must have an answer: the owner cannot
     compare pitches that answer different questions. */
  select count(*) into asked from public.marketplace_job_questions q where q.job_id = p_job;
  if asked > 0 then
    for answer_record in
      select q.id, q.prompt
        from public.marketplace_job_questions q
       where q.job_id = p_job
       order by q.position
    loop
      if coalesce(btrim(p_answers->>answer_record.id::text), '') = '' then
        raise exception 'Answer every question the client asked before pitching.' using errcode = '22023';
      end if;
      clean_answers := clean_answers
        || jsonb_build_object(answer_record.id::text, left(btrim(p_answers->>answer_record.id::text), 2000));
      answered := answered + 1;
    end loop;
  end if;

  insert into public.marketplace_proposals as p (
    job_id, freelancer_id, cover_note, bid_amount, currency, delivery_days, status, answers, updated_at
  )
  values (
    p_job, actor, left(btrim(coalesce(p_cover_note, '')), 4000), p_bid_amount, job.currency,
    p_delivery_days, 'submitted', clean_answers, now()
  )
  on conflict (job_id, freelancer_id) do update set
    cover_note = excluded.cover_note,
    bid_amount = excluded.bid_amount,
    delivery_days = excluded.delivery_days,
    answers = excluded.answers,
    updated_at = now()
  where p.status = 'submitted'
  returning * into saved;

  if saved.id is null then raise exception 'This pitch can no longer be changed.' using errcode = '22023'; end if;

  insert into public.notifications (user_id, title, body, type, link, meta)
  values (
    job.owner_id,
    'New pitch on your project',
    left(job.title, 120) || ' received a pitch.',
    'marketplace',
    '/app/?view=marketplace&tab=hire',
    jsonb_build_object('jobId', job.id, 'proposalId', saved.id, 'answers', answered)
  );

  return jsonb_build_object('proposalId', saved.id, 'status', saved.status, 'bidAmount', saved.bid_amount, 'answers', answered);
end;
$$;

/* -------------------------------------------------------------- discovery */

create or replace function public.marketplace_list_businesses(p_search text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
  needle text := nullif(lower(btrim(coalesce(p_search, ''))), '');
begin
  if auth.uid() is null then raise exception 'Sign in to browse businesses.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'businessId', b.id,
      'name', b.name,
      'category', b.category,
      'description', b.description,
      'location', b.location,
      'websiteUrl', b.website_url,
      'logoUrl', b.logo_url,
      'ownerName', coalesce(nullif(p.full_name, ''), p.username),
      'ownerUsername', p.username,
      'openProjects', (select count(*) from public.marketplace_jobs j where j.business_id = b.id and j.status = 'open'),
      'createdAt', b.created_at
    ) order by b.created_at desc), '[]'::jsonb)
  into result
  from public.businesses b
  left join public.profiles p on p.id = b.owner_id
  where b.discoverable
    and b.owner_id <> auth.uid()
    and (needle is null or lower(b.name) like '%' || needle || '%' or lower(coalesce(b.description, '')) like '%' || needle || '%' or lower(coalesce(b.category, '')) like '%' || needle || '%')
  limit greatest(1, least(coalesce(p_limit, 50), 100));
  return result;
end;
$$;

/* One lookup, used by both sides of "connect by username". Returns only what a
   stranger may see: the handle, the display name, which side of the market they
   are on, and the public headline or business name. */
create or replace function public.marketplace_find_user(p_username text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  wanted text := lower(btrim(coalesce(p_username, '')));
  found jsonb;
begin
  if actor is null then raise exception 'Sign in to search.' using errcode = '42501'; end if;
  if wanted = '' then raise exception 'Type a username.' using errcode = '22023'; end if;

  select jsonb_build_object(
      'userId', p.id,
      'username', p.username,
      'name', coalesce(nullif(p.full_name, ''), p.username),
      'accountType', p.account_type,
      'headline', f.headline,
      'skills', f.skills,
      'availability', f.availability,
      'isPublished', coalesce(f.is_published, false),
      'businessName', (select b.name from public.businesses b where b.owner_id = p.id order by b.created_at limit 1),
      'isSelf', p.id = actor
    )
  into found
  from public.profiles p
  left join public.freelancer_profiles f on f.user_id = p.id
  where lower(p.username) = wanted;

  if found is null then
    raise exception 'No account uses @%.', wanted using errcode = 'P0002';
  end if;
  return found;
end;
$$;

/* --------------------------------------------------------- workspace shape */
/* Replaces the 0020 version: projects now carry their questions, and a pitch
   carries the answers, so the client can read both without a second round of
   requests. */

create or replace function public.marketplace_my_workspace()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to open the marketplace.' using errcode = '42501'; end if;
  select jsonb_build_object(
    'accountType', (select account_type from public.profiles where id = actor),
    'username', (select username from public.profiles where id = actor),
    'profile', (select to_jsonb(f) from public.freelancer_profiles f where f.user_id = actor),
    'myJobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'jobId', j.id, 'title', j.title, 'status', j.status, 'currency', j.currency,
        'budgetMin', j.budget_min, 'budgetMax', j.budget_max, 'createdAt', j.created_at,
        'requirements', j.requirements, 'theme', j.theme, 'websiteUrl', j.website_url,
        'questions', coalesce((
          select jsonb_agg(jsonb_build_object('questionId', q.id, 'prompt', q.prompt) order by q.position)
            from public.marketplace_job_questions q where q.job_id = j.id
        ), '[]'::jsonb),
        'proposals', coalesce((
          select jsonb_agg(jsonb_build_object(
            'proposalId', p.id, 'freelancerId', p.freelancer_id,
            'name', coalesce(nullif(pr.full_name, ''), pr.username),
            'username', pr.username,
            'coverNote', p.cover_note, 'bidAmount', p.bid_amount, 'currency', p.currency,
            'deliveryDays', p.delivery_days, 'status', p.status, 'createdAt', p.created_at,
            'answers', p.answers,
            'ratingAvg', f.rating_avg, 'completedContracts', f.completed_contracts,
            'skills', f.skills, 'equityOk', f.equity_ok, 'esopOk', f.esop_ok,
            'expectedRate', f.expected_rate
          ) order by p.created_at desc)
            from public.marketplace_proposals p
            left join public.profiles pr on pr.id = p.freelancer_id
            left join public.freelancer_profiles f on f.user_id = p.freelancer_id
           where p.job_id = j.id
        ), '[]'::jsonb)
      ) order by j.created_at desc)
      from public.marketplace_jobs j where j.owner_id = actor
    ), '[]'::jsonb),
    'myProposals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'proposalId', p.id, 'jobId', p.job_id, 'jobTitle', j.title, 'jobStatus', j.status,
        'coverNote', p.cover_note, 'bidAmount', p.bid_amount, 'currency', p.currency,
        'deliveryDays', p.delivery_days, 'status', p.status, 'createdAt', p.created_at,
        'answers', p.answers
      ) order by p.created_at desc)
        from public.marketplace_proposals p join public.marketplace_jobs j on j.id = p.job_id
       where p.freelancer_id = actor
    ), '[]'::jsonb),
    'contracts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contractId', c.id, 'jobId', c.job_id, 'jobTitle', j.title, 'amount', c.amount,
        'currency', c.currency, 'status', c.status,
        'role', case when c.client_id = actor then 'client' else 'agent' end,
        'counterparty', coalesce(nullif(pr.full_name, ''), pr.username),
        'counterpartyUsername', pr.username,
        'startedAt', c.started_at, 'completedAt', c.completed_at,
        'canReview', c.status = 'completed' and not exists (
          select 1 from public.marketplace_reviews r where r.contract_id = c.id and r.reviewer_id = actor
        )
      ) order by c.created_at desc)
        from public.marketplace_contracts c
        join public.marketplace_jobs j on j.id = c.job_id
        left join public.profiles pr on pr.id = case when c.client_id = actor then c.freelancer_id else c.client_id end
       where c.client_id = actor or c.freelancer_id = actor
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

/* browse_jobs gains the project fields an agent needs to judge the work before
   pitching, without changing its existing keys. */
create or replace function public.marketplace_browse_jobs(p_search text default null, p_skill text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
  needle text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  skill text := nullif(lower(btrim(coalesce(p_skill, ''))), '');
begin
  if auth.uid() is null then raise exception 'Sign in to browse the marketplace.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'jobId', j.id, 'title', j.title, 'description', j.description,
      'requirements', j.requirements, 'theme', j.theme, 'websiteUrl', j.website_url,
      'skills', j.skills, 'budgetMin', j.budget_min, 'budgetMax', j.budget_max,
      'currency', j.currency, 'deliveryDays', j.delivery_days, 'status', j.status,
      'createdAt', j.created_at, 'ownerId', j.owner_id, 'businessName', b.name,
      'ownerUsername', pr.username,
      'proposals', (select count(*) from public.marketplace_proposals p where p.job_id = j.id and p.status <> 'withdrawn'),
      'mine', j.owner_id = auth.uid(),
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object('questionId', q.id, 'prompt', q.prompt) order by q.position)
          from public.marketplace_job_questions q where q.job_id = j.id
      ), '[]'::jsonb),
      'myProposal', (
        select jsonb_build_object('proposalId', p.id, 'status', p.status)
          from public.marketplace_proposals p
         where p.job_id = j.id and p.freelancer_id = auth.uid()
         limit 1
      )
    ) order by j.created_at desc), '[]'::jsonb)
  into result
  from public.marketplace_jobs j
  left join public.businesses b on b.id = j.business_id
  left join public.profiles pr on pr.id = j.owner_id
  where j.status = 'open'
    and (needle is null or lower(j.title) like '%' || needle || '%' or lower(j.description) like '%' || needle || '%')
    and (skill is null or skill = any (j.skills))
  limit greatest(1, least(coalesce(p_limit, 50), 100));
  return result;
end;
$$;

/* list_freelancers gains the agent terms, so a client can filter on them. */
create or replace function public.marketplace_list_freelancers(p_skill text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
  skill text := nullif(lower(btrim(coalesce(p_skill, ''))), '');
begin
  if auth.uid() is null then raise exception 'Sign in to browse agents.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'userId', f.user_id,
      'name', coalesce(nullif(p.full_name, ''), p.username),
      'username', p.username,
      'headline', f.headline, 'bio', f.bio, 'skills', f.skills,
      'hourlyRate', f.hourly_rate, 'expectedRate', f.expected_rate,
      'currency', coalesce(f.expected_currency, f.currency),
      'availability', f.availability, 'portfolioUrl', f.portfolio_url,
      'yearsExperience', f.years_experience, 'ratingAvg', f.rating_avg,
      'ratingCount', f.rating_count, 'completedContracts', f.completed_contracts,
      'seeking', f.seeking, 'hoursPerWeek', f.hours_per_week,
      'equityOk', f.equity_ok, 'equityMinPct', f.equity_min_pct, 'equityMaxPct', f.equity_max_pct,
      'esopOk', f.esop_ok, 'remoteOk', f.remote_ok, 'location', f.location
    ) order by f.rating_avg desc nulls last, f.completed_contracts desc), '[]'::jsonb)
  into result
  from public.freelancer_profiles f
  left join public.profiles p on p.id = f.user_id
  where f.is_published and (skill is null or skill = any (f.skills))
  limit greatest(1, least(coalesce(p_limit, 50), 100));
  return result;
end;
$$;

/* ===========================================================================
-- 6 · grants — signed-in only, same shape as 0020/0021
-- =========================================================================== */

revoke all on function public.username_is_reserved(text) from public, anon;
revoke all on function public.username_available(text) from public, anon;
revoke all on function public.set_username(text) from public, anon;
revoke all on function public.set_account_type(text) from public, anon;
revoke all on function public.marketplace_save_agent(text, text, text[], numeric, text, text, text, integer, text, integer, integer, text, boolean, boolean, numeric, numeric, boolean, boolean) from public, anon;
revoke all on function public.marketplace_create_project(text, text, text, text[], numeric, numeric, text, integer, text, text, text[]) from public, anon;
revoke all on function public.marketplace_pitch(uuid, text, numeric, integer, jsonb) from public, anon;
revoke all on function public.marketplace_list_businesses(text, integer) from public, anon;
revoke all on function public.marketplace_find_user(text) from public, anon;

grant execute on function public.username_is_reserved(text) to authenticated, service_role;
grant execute on function public.username_available(text) to authenticated, service_role;
grant execute on function public.set_username(text) to authenticated, service_role;
grant execute on function public.set_account_type(text) to authenticated, service_role;
grant execute on function public.marketplace_save_agent(text, text, text[], numeric, text, text, text, integer, text, integer, integer, text, boolean, boolean, numeric, numeric, boolean, boolean) to authenticated, service_role;
grant execute on function public.marketplace_create_project(text, text, text, text[], numeric, numeric, text, integer, text, text, text[]) to authenticated, service_role;
grant execute on function public.marketplace_pitch(uuid, text, numeric, integer, jsonb) to authenticated, service_role;
grant execute on function public.marketplace_list_businesses(text, integer) to authenticated, service_role;
grant execute on function public.marketplace_find_user(text) to authenticated, service_role;
