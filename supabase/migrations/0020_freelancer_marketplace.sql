-- 0020 · Freelancer marketplace.
--
-- A business posts work, freelancers propose, the owner accepts one proposal,
-- which creates a contract. Both sides can leave one review when the contract
-- completes.
--
-- Security model, identical in spirit to 0018: every table has RLS enabled and
-- every write goes through a SECURITY DEFINER RPC. The browser is never trusted
-- for identity, ownership or status transitions — the caller is always
-- auth.uid() and the current row is re-read, locked, and checked inside the
-- function before it changes.
--
-- There are no policies that let a session INSERT, UPDATE or DELETE directly on
-- any of these tables, so a forged post body cannot create a contract or award
-- work to itself.

-- --------------------------------------------------------------- freelancers
create table if not exists public.freelancer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  headline text not null default '' check (char_length(headline) <= 120),
  bio text not null default '' check (char_length(bio) <= 2000),
  skills text[] not null default array[]::text[],
  hourly_rate numeric(12,2) check (hourly_rate is null or (hourly_rate >= 0 and hourly_rate <= 1000000)),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  availability text not null default 'available'
    check (availability in ('available', 'busy', 'unavailable')),
  portfolio_url text check (portfolio_url is null or portfolio_url ~* '^https?://'),
  years_experience integer check (years_experience is null or (years_experience >= 0 and years_experience <= 70)),
  is_published boolean not null default false,
  rating_avg numeric(3,2),
  rating_count integer not null default 0,
  completed_contracts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists freelancer_profiles_published_idx
  on public.freelancer_profiles (is_published, rating_avg desc nulls last)
  where is_published;
create index if not exists freelancer_profiles_skills_idx
  on public.freelancer_profiles using gin (skills);

-- --------------------------------------------------------------------- jobs
create table if not exists public.marketplace_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  title text not null check (char_length(btrim(title)) between 4 and 140),
  description text not null check (char_length(btrim(description)) between 20 and 6000),
  skills text[] not null default array[]::text[],
  budget_min numeric(12,2) check (budget_min is null or budget_min >= 0),
  budget_max numeric(12,2) check (budget_max is null or budget_max >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  delivery_days integer check (delivery_days is null or delivery_days between 1 and 730),
  status text not null default 'open' check (status in ('open', 'closed', 'filled', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_jobs_budget_order check (
    budget_min is null or budget_max is null or budget_max >= budget_min
  )
);
create index if not exists marketplace_jobs_open_idx
  on public.marketplace_jobs (created_at desc) where status = 'open';
create index if not exists marketplace_jobs_owner_idx
  on public.marketplace_jobs (owner_id, created_at desc);
create index if not exists marketplace_jobs_skills_idx
  on public.marketplace_jobs using gin (skills);

-- ---------------------------------------------------------------- proposals
create table if not exists public.marketplace_proposals (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.marketplace_jobs(id) on delete cascade,
  freelancer_id uuid not null references auth.users(id) on delete cascade,
  cover_note text not null default '' check (char_length(cover_note) <= 4000),
  bid_amount numeric(12,2) not null check (bid_amount > 0 and bid_amount <= 100000000),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  delivery_days integer not null check (delivery_days between 1 and 730),
  status text not null default 'submitted'
    check (status in ('submitted', 'withdrawn', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, freelancer_id)
);
create index if not exists marketplace_proposals_job_idx
  on public.marketplace_proposals (job_id, created_at desc);
create index if not exists marketplace_proposals_freelancer_idx
  on public.marketplace_proposals (freelancer_id, created_at desc);

-- ---------------------------------------------------------------- contracts
create table if not exists public.marketplace_contracts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.marketplace_jobs(id) on delete restrict,
  proposal_id uuid not null unique references public.marketplace_proposals(id) on delete restrict,
  client_id uuid not null references auth.users(id) on delete cascade,
  freelancer_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint marketplace_contracts_two_parties check (client_id <> freelancer_id)
);
create index if not exists marketplace_contracts_client_idx
  on public.marketplace_contracts (client_id, status);
create index if not exists marketplace_contracts_freelancer_idx
  on public.marketplace_contracts (freelancer_id, status);

-- ------------------------------------------------------------------ reviews
create table if not exists public.marketplace_reviews (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.marketplace_contracts(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  reviewee_id uuid not null references auth.users(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 2000),
  created_at timestamptz not null default now(),
  unique (contract_id, reviewer_id),
  constraint marketplace_reviews_not_self check (reviewer_id <> reviewee_id)
);
create index if not exists marketplace_reviews_reviewee_idx
  on public.marketplace_reviews (reviewee_id, created_at desc);

-- ---------------------------------------------------------------------- RLS
alter table public.freelancer_profiles enable row level security;
alter table public.marketplace_jobs enable row level security;
alter table public.marketplace_proposals enable row level security;
alter table public.marketplace_contracts enable row level security;
alter table public.marketplace_reviews enable row level security;

drop policy if exists freelancer_profiles_read on public.freelancer_profiles;
create policy freelancer_profiles_read on public.freelancer_profiles
  for select to authenticated
  using (is_published or user_id = auth.uid());

drop policy if exists marketplace_jobs_read on public.marketplace_jobs;
create policy marketplace_jobs_read on public.marketplace_jobs
  for select to authenticated
  using (status = 'open' or owner_id = auth.uid());

drop policy if exists marketplace_proposals_read on public.marketplace_proposals;
create policy marketplace_proposals_read on public.marketplace_proposals
  for select to authenticated
  using (
    freelancer_id = auth.uid()
    or exists (
      select 1 from public.marketplace_jobs j
       where j.id = job_id and j.owner_id = auth.uid()
    )
  );

drop policy if exists marketplace_contracts_read on public.marketplace_contracts;
create policy marketplace_contracts_read on public.marketplace_contracts
  for select to authenticated
  using (client_id = auth.uid() or freelancer_id = auth.uid());

/* Reviews are the public reputation of a freelancer, so any signed-in account
   may read them. They are written only through a SECURITY DEFINER RPC. */
drop policy if exists marketplace_reviews_read on public.marketplace_reviews;
create policy marketplace_reviews_read on public.marketplace_reviews
  for select to authenticated using (true);

-- No INSERT/UPDATE/DELETE policies exist on any marketplace table on purpose.

-- ------------------------------------------------------------------ helpers
create or replace function public.marketplace_clean_skills(p_skills text[])
returns text[]
language sql
immutable
as $$
  select coalesce(
    (select array_agg(distinct lower(btrim(skill)) order by lower(btrim(skill)))
       from unnest(coalesce(p_skills, array[]::text[])) as skill
      where length(btrim(skill)) between 1 and 40
      limit 20),
    array[]::text[]
  );
$$;

-- ------------------------------------------------------- freelancer profile
create or replace function public.marketplace_upsert_freelancer(
  p_headline text,
  p_bio text,
  p_skills text[],
  p_hourly_rate numeric,
  p_currency text,
  p_availability text,
  p_portfolio_url text,
  p_years_experience integer,
  p_publish boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  kind text := upper(btrim(coalesce(p_currency, 'INR')));
  saved public.freelancer_profiles%rowtype;
begin
  if actor is null then raise exception 'Sign in to manage a freelancer profile.' using errcode = '42501'; end if;
  if kind !~ '^[A-Z]{3}$' then raise exception 'Currency must be a three-letter code.' using errcode = '22023'; end if;
  if coalesce(p_availability, 'available') not in ('available', 'busy', 'unavailable') then
    raise exception 'Choose a valid availability.' using errcode = '22023';
  end if;
  if p_portfolio_url is not null and btrim(p_portfolio_url) <> '' and btrim(p_portfolio_url) !~* '^https?://' then
    raise exception 'Portfolio links must start with http:// or https://.' using errcode = '22023';
  end if;

  insert into public.freelancer_profiles as f
    (user_id, headline, bio, skills, hourly_rate, currency, availability,
     portfolio_url, years_experience, is_published, updated_at)
  values
    (actor, left(btrim(coalesce(p_headline, '')), 120), left(btrim(coalesce(p_bio, '')), 2000),
     marketplace_clean_skills(p_skills), p_hourly_rate, kind,
     coalesce(p_availability, 'available'), nullif(btrim(coalesce(p_portfolio_url, '')), ''),
     p_years_experience, coalesce(p_publish, false), now())
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
    updated_at = now()
  returning * into saved;

  return jsonb_build_object(
    'userId', saved.user_id,
    'headline', saved.headline,
    'skills', saved.skills,
    'hourlyRate', saved.hourly_rate,
    'currency', saved.currency,
    'availability', saved.availability,
    'isPublished', saved.is_published
  );
end;
$$;

-- ----------------------------------------------------------------- client
create or replace function public.marketplace_create_job(
  p_title text,
  p_description text,
  p_skills text[],
  p_budget_min numeric,
  p_budget_max numeric,
  p_currency text,
  p_delivery_days integer,
  p_business uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  kind text := upper(btrim(coalesce(p_currency, 'INR')));
  made public.marketplace_jobs%rowtype;
begin
  if actor is null then raise exception 'Sign in to post a job.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 4 and 140 then
    raise exception 'Give the job a title of at least 4 characters.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) < 20 then
    raise exception 'Describe the work in at least 20 characters.' using errcode = '22023';
  end if;
  if kind !~ '^[A-Z]{3}$' then raise exception 'Currency must be a three-letter code.' using errcode = '22023'; end if;
  if p_budget_min is not null and p_budget_max is not null and p_budget_max < p_budget_min then
    raise exception 'The maximum budget cannot be below the minimum.' using errcode = '22023';
  end if;
  if p_business is not null and not public.is_business_team_member(p_business, actor) then
    raise exception 'You are not a member of that business.' using errcode = '42501';
  end if;

  insert into public.marketplace_jobs
    (owner_id, business_id, title, description, skills, budget_min, budget_max,
     currency, delivery_days, status)
  values
    (actor, p_business, btrim(p_title), btrim(p_description),
     marketplace_clean_skills(p_skills), p_budget_min, p_budget_max, kind,
     p_delivery_days, 'open')
  returning * into made;

  return jsonb_build_object('jobId', made.id, 'status', made.status, 'title', made.title);
end;
$$;

create or replace function public.marketplace_close_job(p_job uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  job public.marketplace_jobs%rowtype;
begin
  select * into job from public.marketplace_jobs j where j.id = p_job for update;
  if job.id is null then raise exception 'Job not found.' using errcode = 'P0002'; end if;
  if actor is null or job.owner_id <> actor then
    raise exception 'Only the owner can close this job.' using errcode = '42501';
  end if;
  if job.status = 'filled' then raise exception 'This job already has a contract.' using errcode = '22023'; end if;

  update public.marketplace_jobs
     set status = 'closed', updated_at = now()
   where id = p_job
   returning * into job;

  update public.marketplace_proposals
     set status = 'rejected', updated_at = now()
   where job_id = p_job and status = 'submitted';

  return jsonb_build_object('jobId', job.id, 'status', job.status);
end;
$$;

-- ------------------------------------------------------------- freelancer
create or replace function public.marketplace_submit_proposal(
  p_job uuid,
  p_cover_note text,
  p_bid_amount numeric,
  p_delivery_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  job public.marketplace_jobs%rowtype;
  saved public.marketplace_proposals%rowtype;
begin
  if actor is null then raise exception 'Sign in to send a proposal.' using errcode = '42501'; end if;
  select * into job from public.marketplace_jobs j where j.id = p_job;
  if job.id is null then raise exception 'Job not found.' using errcode = 'P0002'; end if;
  if job.status <> 'open' then raise exception 'This job is no longer accepting proposals.' using errcode = '22023'; end if;
  if job.owner_id = actor then raise exception 'You cannot propose on your own job.' using errcode = '42501'; end if;
  if p_bid_amount is null or p_bid_amount <= 0 then raise exception 'Enter a bid above zero.' using errcode = '22023'; end if;
  if p_delivery_days is null or p_delivery_days < 1 or p_delivery_days > 730 then
    raise exception 'Delivery must be between 1 and 730 days.' using errcode = '22023';
  end if;

  insert into public.marketplace_proposals as p
    (job_id, freelancer_id, cover_note, bid_amount, currency, delivery_days, status, updated_at)
  values
    (p_job, actor, left(btrim(coalesce(p_cover_note, '')), 4000), p_bid_amount,
     job.currency, p_delivery_days, 'submitted', now())
  on conflict (job_id, freelancer_id) do update set
    cover_note = excluded.cover_note,
    bid_amount = excluded.bid_amount,
    delivery_days = excluded.delivery_days,
    updated_at = now()
  where p.status = 'submitted'
  returning * into saved;

  if saved.id is null then
    raise exception 'This proposal can no longer be changed.' using errcode = '22023';
  end if;

  insert into public.notifications (user_id, title, body, type, link, meta)
  values (job.owner_id, 'New proposal on your job',
          left(job.title, 120) || ' received a proposal.',
          'marketplace', '/app/?view=marketplace&tab=my-jobs',
          jsonb_build_object('jobId', job.id, 'proposalId', saved.id));

  return jsonb_build_object('proposalId', saved.id, 'status', saved.status, 'bidAmount', saved.bid_amount);
end;
$$;

create or replace function public.marketplace_withdraw_proposal(p_proposal uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  item public.marketplace_proposals%rowtype;
begin
  select * into item from public.marketplace_proposals p where p.id = p_proposal for update;
  if item.id is null then raise exception 'Proposal not found.' using errcode = 'P0002'; end if;
  if actor is null or item.freelancer_id <> actor then
    raise exception 'You can only withdraw your own proposal.' using errcode = '42501';
  end if;
  if item.status <> 'submitted' then
    raise exception 'Only a submitted proposal can be withdrawn.' using errcode = '22023';
  end if;
  update public.marketplace_proposals
     set status = 'withdrawn', updated_at = now()
   where id = p_proposal
   returning * into item;
  return jsonb_build_object('proposalId', item.id, 'status', item.status);
end;
$$;

-- ------------------------------------------------------------- acceptance
create or replace function public.marketplace_accept_proposal(p_proposal uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  item public.marketplace_proposals%rowtype;
  job public.marketplace_jobs%rowtype;
  contract public.marketplace_contracts%rowtype;
begin
  select * into item from public.marketplace_proposals p where p.id = p_proposal for update;
  if item.id is null then raise exception 'Proposal not found.' using errcode = 'P0002'; end if;
  select * into job from public.marketplace_jobs j where j.id = item.job_id for update;
  if actor is null or job.owner_id <> actor then
    raise exception 'Only the job owner can accept a proposal.' using errcode = '42501';
  end if;
  if item.status <> 'submitted' then
    raise exception 'This proposal is not open for acceptance.' using errcode = '22023';
  end if;
  if job.status <> 'open' then
    raise exception 'This job is no longer open.' using errcode = '22023';
  end if;

  update public.marketplace_proposals
     set status = 'accepted', updated_at = now()
   where id = p_proposal;

  update public.marketplace_proposals
     set status = 'rejected', updated_at = now()
   where job_id = item.job_id and id <> p_proposal and status = 'submitted';

  update public.marketplace_jobs
     set status = 'filled', updated_at = now()
   where id = item.job_id;

  insert into public.marketplace_contracts
    (job_id, proposal_id, client_id, freelancer_id, amount, currency, status)
  values
    (item.job_id, item.id, job.owner_id, item.freelancer_id, item.bid_amount, item.currency, 'active')
  returning * into contract;

  insert into public.notifications (user_id, title, body, type, link, meta)
  values
    (item.freelancer_id, 'Your proposal was accepted',
     left(job.title, 120) || ' is now a contract.',
     'marketplace', '/app/?view=marketplace&tab=contracts',
     jsonb_build_object('contractId', contract.id, 'jobId', job.id));

  return jsonb_build_object('contractId', contract.id, 'status', contract.status,
                            'amount', contract.amount, 'freelancerId', contract.freelancer_id);
end;
$$;

-- --------------------------------------------------------------- contract
create or replace function public.marketplace_set_contract_status(p_contract uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  wanted text := lower(btrim(coalesce(p_status, '')));
  contract public.marketplace_contracts%rowtype;
begin
  select * into contract from public.marketplace_contracts c where c.id = p_contract for update;
  if contract.id is null then raise exception 'Contract not found.' using errcode = 'P0002'; end if;
  if actor is null or (contract.client_id <> actor and contract.freelancer_id <> actor) then
    raise exception 'Only the two parties can change this contract.' using errcode = '42501';
  end if;
  if wanted not in ('completed', 'cancelled') then
    raise exception 'A contract can only be completed or cancelled.' using errcode = '22023';
  end if;
  if contract.status <> 'active' then
    raise exception 'This contract is already %.', contract.status using errcode = '22023';
  end if;

  update public.marketplace_contracts
     set status = wanted,
         completed_at = case when wanted = 'completed' then now() else null end
   where id = p_contract
   returning * into contract;

  if wanted = 'completed' then
    update public.freelancer_profiles
       set completed_contracts = completed_contracts + 1, updated_at = now()
     where user_id = contract.freelancer_id;
  end if;

  insert into public.notifications (user_id, title, body, type, link, meta)
  values (
    case when actor = contract.client_id then contract.freelancer_id else contract.client_id end,
    case when wanted = 'completed' then 'Contract completed' else 'Contract cancelled' end,
    'A marketplace contract you are part of was marked ' || wanted || '.',
    'marketplace', '/app/?view=marketplace&tab=contracts',
    jsonb_build_object('contractId', contract.id)
  );

  return jsonb_build_object('contractId', contract.id, 'status', contract.status);
end;
$$;

create or replace function public.marketplace_submit_review(p_contract uuid, p_rating integer, p_comment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  contract public.marketplace_contracts%rowtype;
  reviewee uuid;
  saved public.marketplace_reviews%rowtype;
  totals record;
begin
  select * into contract from public.marketplace_contracts c where c.id = p_contract;
  if contract.id is null then raise exception 'Contract not found.' using errcode = 'P0002'; end if;
  if actor is null or (contract.client_id <> actor and contract.freelancer_id <> actor) then
    raise exception 'Only the two parties can review this contract.' using errcode = '42501';
  end if;
  if contract.status <> 'completed' then
    raise exception 'Reviews open when the contract is completed.' using errcode = '22023';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Choose a rating from 1 to 5.' using errcode = '22023';
  end if;

  reviewee := case when actor = contract.client_id then contract.freelancer_id else contract.client_id end;

  insert into public.marketplace_reviews as r (contract_id, reviewer_id, reviewee_id, rating, comment)
  values (p_contract, actor, reviewee, p_rating, left(btrim(coalesce(p_comment, '')), 2000))
  on conflict (contract_id, reviewer_id) do update set
    rating = excluded.rating,
    comment = excluded.comment
  returning * into saved;

  /* A freelancer's public score covers the reviews left about them. */
  select round(avg(rating)::numeric, 2) as avg_rating, count(*)::integer as total
    into totals
    from public.marketplace_reviews
   where reviewee_id = reviewee;

  update public.freelancer_profiles
     set rating_avg = totals.avg_rating,
         rating_count = totals.total,
         updated_at = now()
   where user_id = reviewee;

  return jsonb_build_object('reviewId', saved.id, 'rating', saved.rating,
                            'revieweeId', saved.reviewee_id,
                            'ratingAvg', totals.avg_rating, 'ratingCount', totals.total);
end;
$$;

-- ----------------------------------------------------------------- reads
create or replace function public.marketplace_browse_jobs(
  p_search text default null,
  p_skill text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  needle text := nullif(lower(btrim(coalesce(p_search, ''))), '');
  skill text := nullif(lower(btrim(coalesce(p_skill, ''))), '');
begin
  if auth.uid() is null then raise exception 'Sign in to browse the marketplace.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', j.id,
    'title', j.title,
    'description', j.description,
    'skills', j.skills,
    'budgetMin', j.budget_min,
    'budgetMax', j.budget_max,
    'currency', j.currency,
    'deliveryDays', j.delivery_days,
    'status', j.status,
    'createdAt', j.created_at,
    'ownerId', j.owner_id,
    'businessName', b.name,
    'proposals', (select count(*) from public.marketplace_proposals p
                   where p.job_id = j.id and p.status <> 'withdrawn'),
    'mine', j.owner_id = auth.uid()
  ) order by j.created_at desc), '[]'::jsonb)
  into result
  from public.marketplace_jobs j
  left join public.businesses b on b.id = j.business_id
  where j.status = 'open'
    and (needle is null or lower(j.title) like '%' || needle || '%'
         or lower(j.description) like '%' || needle || '%')
    and (skill is null or skill = any (j.skills))
  limit greatest(1, least(coalesce(p_limit, 50), 100));
  return result;
end;
$$;

create or replace function public.marketplace_list_freelancers(
  p_skill text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
  skill text := nullif(lower(btrim(coalesce(p_skill, ''))), '');
begin
  if auth.uid() is null then raise exception 'Sign in to browse freelancers.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', f.user_id,
    'name', coalesce(nullif(p.full_name, ''), split_part(coalesce(p.email, ''), '@', 1)),
    'headline', f.headline,
    'bio', f.bio,
    'skills', f.skills,
    'hourlyRate', f.hourly_rate,
    'currency', f.currency,
    'availability', f.availability,
    'portfolioUrl', f.portfolio_url,
    'yearsExperience', f.years_experience,
    'ratingAvg', f.rating_avg,
    'ratingCount', f.rating_count,
    'completedContracts', f.completed_contracts
  ) order by f.rating_avg desc nulls last, f.completed_contracts desc), '[]'::jsonb)
  into result
  from public.freelancer_profiles f
  left join public.profiles p on p.id = f.user_id
  where f.is_published
    and (skill is null or skill = any (f.skills))
  limit greatest(1, least(coalesce(p_limit, 50), 100));
  return result;
end;
$$;

/* One call for the whole workspace screen: profile, my jobs with their
   proposals, my proposals with the job they belong to, and my contracts.
   Every branch is scoped to auth.uid(), so it cannot leak another account. */
create or replace function public.marketplace_my_workspace()
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
  if actor is null then raise exception 'Sign in to open the marketplace.' using errcode = '42501'; end if;

  select jsonb_build_object(
    'profile', (
      select to_jsonb(f) from public.freelancer_profiles f where f.user_id = actor
    ),
    'myJobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'jobId', j.id, 'title', j.title, 'status', j.status,
        'currency', j.currency, 'budgetMin', j.budget_min, 'budgetMax', j.budget_max,
        'createdAt', j.created_at,
        'proposals', coalesce((
          select jsonb_agg(jsonb_build_object(
            'proposalId', p.id, 'freelancerId', p.freelancer_id,
            'name', coalesce(nullif(pr.full_name, ''), split_part(coalesce(pr.email, ''), '@', 1)),
            'coverNote', p.cover_note, 'bidAmount', p.bid_amount,
            'currency', p.currency, 'deliveryDays', p.delivery_days,
            'status', p.status, 'createdAt', p.created_at,
            'ratingAvg', f.rating_avg, 'completedContracts', f.completed_contracts
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
        'proposalId', p.id, 'jobId', p.job_id, 'jobTitle', j.title,
        'jobStatus', j.status, 'coverNote', p.cover_note,
        'bidAmount', p.bid_amount, 'currency', p.currency,
        'deliveryDays', p.delivery_days, 'status', p.status, 'createdAt', p.created_at
      ) order by p.created_at desc)
      from public.marketplace_proposals p
      join public.marketplace_jobs j on j.id = p.job_id
      where p.freelancer_id = actor
    ), '[]'::jsonb),
    'contracts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contractId', c.id, 'jobId', c.job_id, 'jobTitle', j.title,
        'amount', c.amount, 'currency', c.currency, 'status', c.status,
        'role', case when c.client_id = actor then 'client' else 'freelancer' end,
        'counterparty', coalesce(nullif(pr.full_name, ''), split_part(coalesce(pr.email, ''), '@', 1)),
        'startedAt', c.started_at, 'completedAt', c.completed_at,
        'canReview', c.status = 'completed' and not exists (
          select 1 from public.marketplace_reviews r
           where r.contract_id = c.id and r.reviewer_id = actor
        )
      ) order by c.created_at desc)
      from public.marketplace_contracts c
      join public.marketplace_jobs j on j.id = c.job_id
      left join public.profiles pr on pr.id = case
        when c.client_id = actor then c.freelancer_id else c.client_id end
      where c.client_id = actor or c.freelancer_id = actor
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- ------------------------------------------------------------------ grants
revoke all on function public.marketplace_upsert_freelancer(text, text, text[], numeric, text, text, text, integer, boolean) from public, anon;
revoke all on function public.marketplace_create_job(text, text, text[], numeric, numeric, text, integer, uuid) from public, anon;
revoke all on function public.marketplace_close_job(uuid) from public, anon;
revoke all on function public.marketplace_submit_proposal(uuid, text, numeric, integer) from public, anon;
revoke all on function public.marketplace_withdraw_proposal(uuid) from public, anon;
revoke all on function public.marketplace_accept_proposal(uuid) from public, anon;
revoke all on function public.marketplace_set_contract_status(uuid, text) from public, anon;
revoke all on function public.marketplace_submit_review(uuid, integer, text) from public, anon;
revoke all on function public.marketplace_browse_jobs(text, text, integer) from public, anon;
revoke all on function public.marketplace_list_freelancers(text, integer) from public, anon;
revoke all on function public.marketplace_my_workspace() from public, anon;

grant execute on function public.marketplace_upsert_freelancer(text, text, text[], numeric, text, text, text, integer, boolean) to authenticated, service_role;
grant execute on function public.marketplace_create_job(text, text, text[], numeric, numeric, text, integer, uuid) to authenticated, service_role;
grant execute on function public.marketplace_close_job(uuid) to authenticated, service_role;
grant execute on function public.marketplace_submit_proposal(uuid, text, numeric, integer) to authenticated, service_role;
grant execute on function public.marketplace_withdraw_proposal(uuid) to authenticated, service_role;
grant execute on function public.marketplace_accept_proposal(uuid) to authenticated, service_role;
grant execute on function public.marketplace_set_contract_status(uuid, text) to authenticated, service_role;
grant execute on function public.marketplace_submit_review(uuid, integer, text) to authenticated, service_role;
grant execute on function public.marketplace_browse_jobs(text, text, integer) to authenticated, service_role;
grant execute on function public.marketplace_list_freelancers(text, integer) to authenticated, service_role;
grant execute on function public.marketplace_my_workspace() to authenticated, service_role;
