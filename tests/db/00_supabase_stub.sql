-- Minimal stand-in for the Supabase pieces that the migrations rely on.
-- Used only for local tests (tests/db). Not applied to the live project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema if not exists storage;
create table storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

create publication supabase_realtime;

create schema if not exists public;
grant usage on schema public, auth, storage to anon, authenticated, service_role;

create table public.profiles (
  id uuid primary key references auth.users(id),
  full_name text, email text, phone text, avatar_url text,
  role text default 'customer', account_type text default 'customer',
  username text
);
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null, description text, category text, stage text,
  location text, goals jsonb, goal_note text, logo_url text, status text,
  phone text, email text, socials jsonb, discoverable boolean default false,
  created_at timestamptz default now()
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text, message text, is_read boolean default false, created_at timestamptz default now(),
  body text, type text, link text, meta jsonb, read_at timestamptz
);
create or replace function public.is_admin() returns boolean language sql stable as $$ select false $$;

-- Same definition as the live project.
create or replace function public.is_account_type(p_type text)
returns boolean language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from public.profiles where id = auth.uid() and account_type = p_type); $$;

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.notifications enable row level security;
create policy profiles_select_self on public.profiles for select to public using (id = auth.uid() or is_admin());
create policy businesses_owner_all on public.businesses for all to public using (owner_id = auth.uid() or is_admin());
create policy notifications_owner_select on public.notifications for select to public using (user_id = auth.uid());
grant select, insert, update, delete on all tables in schema public to authenticated, anon;
grant select, insert, update on storage.objects, storage.buckets to authenticated;
grant all on all tables in schema public to service_role;
grant all on all tables in schema storage to service_role;
-- Supabase default privileges: new tables are fully granted to clients (RLS is the guard).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
