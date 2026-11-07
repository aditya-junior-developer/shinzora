-- ============================================================================
-- SHINZORA · 0001_schema.sql
-- ----------------------------------------------------------------------------
-- Core schema. Safe to run more than once:
--   • CREATE TABLE IF NOT EXISTS for new tables
--   • ALTER TABLE ... ADD COLUMN IF NOT EXISTS for tables that already exist
--   • CREATE INDEX IF NOT EXISTS, triggers dropped and recreated
--
-- Run order: 0001 → 0002 → 0003 → (0004 for the first administrator)
-- Every statement is idempotent, so a partially applied run can simply be
-- executed again.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth.users row, created by trigger (0002)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  phone text,
  avatar_url text,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists role text default 'owner';
alter table public.profiles add column if not exists last_sign_in_at timestamptz;
alter table public.profiles add column if not exists created_at timestamptz default now();
alter table public.profiles add column if not exists updated_at timestamptz default now();

create index if not exists profiles_email_idx on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- businesses — the profile the AI reads before generating anything
-- ---------------------------------------------------------------------------
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text,
  category text,
  description text,
  logo_url text,
  location text,
  website_url text,
  phone text,
  email text,
  stage text,
  brand_colors jsonb default '[]'::jsonb,
  website_style text,
  target_audience text,
  domain_preference text,
  goals jsonb default '[]'::jsonb,
  goal_note text,
  socials jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.businesses add column if not exists name text;
alter table public.businesses add column if not exists category text;
alter table public.businesses add column if not exists description text;
alter table public.businesses add column if not exists logo_url text;
alter table public.businesses add column if not exists location text;
alter table public.businesses add column if not exists website_url text;
alter table public.businesses add column if not exists phone text;
alter table public.businesses add column if not exists email text;
alter table public.businesses add column if not exists stage text;
alter table public.businesses add column if not exists brand_colors jsonb default '[]'::jsonb;
alter table public.businesses add column if not exists website_style text;
alter table public.businesses add column if not exists target_audience text;
alter table public.businesses add column if not exists domain_preference text;
alter table public.businesses add column if not exists goals jsonb default '[]'::jsonb;
alter table public.businesses add column if not exists goal_note text;
alter table public.businesses add column if not exists socials jsonb default '{}'::jsonb;
alter table public.businesses add column if not exists created_at timestamptz default now();
alter table public.businesses add column if not exists updated_at timestamptz default now();

create index if not exists businesses_owner_idx on public.businesses (owner_id);

-- ---------------------------------------------------------------------------
-- onboarding_progress — resumable wizard state
-- ---------------------------------------------------------------------------
create table if not exists public.onboarding_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current_step int not null default 1 check (current_step between 1 and 6),
  data jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.onboarding_progress add column if not exists current_step int default 1;
alter table public.onboarding_progress add column if not exists data jsonb default '{}'::jsonb;
alter table public.onboarding_progress add column if not exists completed_at timestamptz;
alter table public.onboarding_progress add column if not exists created_at timestamptz default now();
alter table public.onboarding_progress add column if not exists updated_at timestamptz default now();

-- ---------------------------------------------------------------------------
-- subscriptions — plan state; written by the payments function, not the client
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro', 'enterprise')),
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled', 'trialing')),
  business_id uuid references public.businesses(id) on delete set null,
  ai_credits_used int not null default 0,
  ai_credits_limit int not null default 30,
  ai_period_start timestamptz not null default date_trunc('month', now()),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.subscriptions add column if not exists plan text default 'free';
alter table public.subscriptions add column if not exists status text default 'active';
alter table public.subscriptions add column if not exists business_id uuid;
alter table public.subscriptions add column if not exists ai_credits_used int default 0;
alter table public.subscriptions add column if not exists ai_credits_limit int default 30;
alter table public.subscriptions add column if not exists ai_period_start timestamptz default date_trunc('month', now());
alter table public.subscriptions add column if not exists current_period_end timestamptz;
alter table public.subscriptions add column if not exists created_at timestamptz default now();
alter table public.subscriptions add column if not exists updated_at timestamptz default now();

create index if not exists subscriptions_user_idx on public.subscriptions (user_id);

-- ---------------------------------------------------------------------------
-- projects — websites, apps and stores
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  name text not null default 'Untitled project',
  description text,
  type text not null default 'website',
  status text not null default 'draft',
  slug text,
  framework text default 'html',
  preview_data jsonb,
  version_count int not null default 0,
  published_version_id uuid,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects add column if not exists business_id uuid;
alter table public.projects add column if not exists name text;
alter table public.projects add column if not exists description text;
alter table public.projects add column if not exists type text default 'website';
alter table public.projects add column if not exists status text default 'draft';
alter table public.projects add column if not exists slug text;
alter table public.projects add column if not exists framework text default 'html';
alter table public.projects add column if not exists preview_data jsonb;
alter table public.projects add column if not exists version_count int default 0;
alter table public.projects add column if not exists published_version_id uuid;
alter table public.projects add column if not exists published_at timestamptz;
alter table public.projects add column if not exists created_at timestamptz default now();
alter table public.projects add column if not exists updated_at timestamptz default now();

create index if not exists projects_owner_idx on public.projects (owner_id, updated_at desc);
create index if not exists projects_status_idx on public.projects (status);
create unique index if not exists projects_slug_unique on public.projects (lower(slug)) where slug is not null;

-- ---------------------------------------------------------------------------
-- project_versions — immutable generations of a project
-- ---------------------------------------------------------------------------
create table if not exists public.project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version_number int not null default 1,
  prompt text,
  files jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, version_number)
);

alter table public.project_versions add column if not exists version_number int default 1;
alter table public.project_versions add column if not exists prompt text;
alter table public.project_versions add column if not exists files jsonb default '{}'::jsonb;
alter table public.project_versions add column if not exists meta jsonb default '{}'::jsonb;
alter table public.project_versions add column if not exists created_by uuid;
alter table public.project_versions add column if not exists created_at timestamptz default now();

create index if not exists project_versions_project_idx on public.project_versions (project_id, version_number desc);

-- ---------------------------------------------------------------------------
-- ai_conversations / ai_messages — assistant history
-- ---------------------------------------------------------------------------
create table if not exists public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text default 'New conversation',
  kind text not null default 'assistant',
  project_id uuid references public.projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_conversations add column if not exists title text;
alter table public.ai_conversations add column if not exists kind text default 'assistant';
alter table public.ai_conversations add column if not exists project_id uuid;
alter table public.ai_conversations add column if not exists created_at timestamptz default now();
alter table public.ai_conversations add column if not exists updated_at timestamptz default now();

create index if not exists ai_conversations_user_idx on public.ai_conversations (user_id, updated_at desc);

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  tokens int,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.ai_messages add column if not exists role text;
alter table public.ai_messages add column if not exists content text;
alter table public.ai_messages add column if not exists tokens int;
alter table public.ai_messages add column if not exists meta jsonb default '{}'::jsonb;
alter table public.ai_messages add column if not exists created_at timestamptz default now();

create index if not exists ai_messages_conversation_idx on public.ai_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- domains / domain_orders — registrar-agnostic
-- ---------------------------------------------------------------------------
create table if not exists public.domains (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  fqdn text not null,
  name text,
  tld text,
  provider text default 'manual',
  provider_domain_id text,
  status text not null default 'pending',
  auto_renew boolean default false,
  dns_records jsonb default '[]'::jsonb,
  registered_at timestamptz,
  expires_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists domains_owner_idx on public.domains (owner_id);
create unique index if not exists domains_fqdn_unique on public.domains (lower(fqdn));

create table if not exists public.domain_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  domain_name text not null,
  tld text,
  price numeric(12, 2) not null default 0,
  currency text not null default 'INR',
  years int not null default 1,
  provider text,
  status text not null default 'pending_payment',
  payment_id uuid,
  registrar_order_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists domain_orders_owner_idx on public.domain_orders (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- payments — manual UPI QR first, Razorpay-ready
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  reference text not null default ('SZ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  purpose text not null,
  label text,
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null default 'INR',
  method text not null default 'upi_qr',
  status text not null default 'pending'
    check (status in ('pending', 'awaiting_verification', 'verified', 'rejected', 'refunded', 'cancelled')),
  plan text,
  utr text,
  paid_at timestamptz,
  proof_url text,
  note text,
  admin_note text,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  provider text,
  provider_payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payments_owner_idx on public.payments (owner_id, created_at desc);
create index if not exists payments_status_idx on public.payments (status);
create unique index if not exists payments_reference_unique on public.payments (reference);

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text,
  type text not null default 'system',
  link text,
  meta jsonb default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.notifications add column if not exists title text;
alter table public.notifications add column if not exists body text;
alter table public.notifications add column if not exists type text default 'system';
alter table public.notifications add column if not exists link text;
alter table public.notifications add column if not exists meta jsonb default '{}'::jsonb;
alter table public.notifications add column if not exists read_at timestamptz;
alter table public.notifications add column if not exists created_at timestamptz default now();

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- admin_announcements — broadcast messages
-- ---------------------------------------------------------------------------
create table if not exists public.admin_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  audience text not null default 'all',
  created_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.admin_announcements add column if not exists title text;
alter table public.admin_announcements add column if not exists body text;
alter table public.admin_announcements add column if not exists audience text default 'all';
alter table public.admin_announcements add column if not exists created_by uuid;
alter table public.admin_announcements add column if not exists published_at timestamptz default now();
alter table public.admin_announcements add column if not exists created_at timestamptz default now();

-- ---------------------------------------------------------------------------
-- support_tickets / support_replies
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  message text not null,
  ticket_type text not null default 'customer',
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_owner_idx on public.support_tickets (owner_id, updated_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets (status);

create table if not exists public.support_replies (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_role text not null default 'owner' check (author_role in ('owner', 'admin', 'system')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists support_replies_ticket_idx on public.support_replies (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- service_requests — managed services & account actions
-- ---------------------------------------------------------------------------
create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  service_type text not null,
  title text,
  details text,
  amount numeric(12, 2) default 0,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'in_progress', 'completed', 'rejected', 'cancelled')),
  admin_note text,
  payment_id uuid references public.payments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists service_requests_owner_idx on public.service_requests (owner_id, created_at desc);
create index if not exists service_requests_status_idx on public.service_requests (status);

-- ---------------------------------------------------------------------------
-- customer_activity — audit trail shown in admin
-- ---------------------------------------------------------------------------
create table if not exists public.customer_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  entity_type text,
  entity_id text,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.customer_activity add column if not exists action text;
alter table public.customer_activity add column if not exists entity_type text;
alter table public.customer_activity add column if not exists entity_id text;
alter table public.customer_activity add column if not exists meta jsonb default '{}'::jsonb;
alter table public.customer_activity add column if not exists created_at timestamptz default now();

create index if not exists customer_activity_user_idx on public.customer_activity (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- store_* — commerce
-- ---------------------------------------------------------------------------
create table if not exists public.store_products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  sku text,
  price numeric(12, 2) not null default 0,
  currency text not null default 'INR',
  stock int not null default 0,
  status text not null default 'active' check (status in ('active', 'draft', 'archived')),
  image_url text,
  category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists store_products_owner_idx on public.store_products (owner_id, created_at desc);

create table if not exists public.store_customers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text,
  email text,
  phone text,
  city text,
  notes text,
  source text default 'store',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists store_customers_owner_idx on public.store_customers (owner_id, created_at desc);

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  order_number text,
  customer_name text,
  customer_email text,
  customer_id uuid references public.store_customers(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'fulfilled')),
  total_amount numeric(12, 2) not null default 0,
  currency text not null default 'INR',
  payment_method text,
  notes text,
  placed_at timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists store_orders_owner_idx on public.store_orders (owner_id, created_at desc);

create table if not exists public.store_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.store_orders(id) on delete cascade,
  product_id uuid references public.store_products(id) on delete set null,
  product_name text,
  quantity int not null default 1 check (quantity > 0),
  unit_price numeric(12, 2) not null default 0,
  currency text not null default 'INR',
  created_at timestamptz not null default now()
);

create index if not exists store_order_items_order_idx on public.store_order_items (order_id);

-- ---------------------------------------------------------------------------
-- campaigns — marketing
-- ---------------------------------------------------------------------------
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  channel text not null default 'instagram',
  status text not null default 'planned' check (status in ('planned', 'active', 'paused', 'completed', 'cancelled')),
  goal text,
  budget numeric(12, 2) default 0,
  currency text not null default 'INR',
  start_date date,
  end_date date,
  notes text,
  plan jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_owner_idx on public.campaigns (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- integration_tokens — provider access tokens. RLS is enabled with NO policies
-- (0002), so only the service role can ever read this table. Tokens are never
-- returned to a browser.
create table if not exists public.integration_tokens (
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('github', 'vercel')),
  access_token text not null,
  refresh_token text,
  scopes text[],
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider)
);

-- integrations / deployments — GitHub + Vercel connections
-- ---------------------------------------------------------------------------
create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('github', 'vercel')),
  account_name text,
  external_id text,
  scopes text[],
  token_ciphertext text,
  meta jsonb default '{}'::jsonb,
  connected_at timestamptz default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, provider)
);

create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  version_id uuid references public.project_versions(id) on delete set null,
  provider text not null default 'vercel' check (provider in ('vercel', 'github', 'shinzora')),
  repo_full_name text,
  commit_sha text,
  external_id text,
  url text,
  status text not null default 'queued'
    check (status in ('queued', 'building', 'ready', 'error', 'cancelled')),
  error text,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deployments_owner_idx on public.deployments (owner_id, created_at desc);
create index if not exists deployments_project_idx on public.deployments (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- admin_users — the only place administrator rights can live
-- ---------------------------------------------------------------------------
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'admin' check (role in ('admin', 'support', 'superadmin')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- contact_messages — landing page contact form
-- ---------------------------------------------------------------------------
create table if not exists public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  company text,
  topic text,
  message text not null,
  status text not null default 'new' check (status in ('new', 'read', 'replied', 'archived')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ai_usage_log — rate limiting and per-call accounting
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage_log (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null,
  model text,
  input_tokens int default 0,
  output_tokens int default 0,
  credits int not null default 1,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_log_user_idx on public.ai_usage_log (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'profiles', 'businesses', 'onboarding_progress', 'subscriptions', 'projects',
    'ai_conversations', 'domains', 'domain_orders', 'payments', 'support_tickets',
    'service_requests', 'store_products', 'store_customers', 'store_orders',
    'campaigns', 'integrations', 'deployments'
  ];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      t
    );
  end loop;
end;
$$;
