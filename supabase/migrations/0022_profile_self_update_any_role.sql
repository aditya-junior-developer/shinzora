-- 0022 · Let every account edit its own profile, without letting anyone edit its role
-- ---------------------------------------------------------------------------
-- Symptom: "Finish setup" on the last onboarding step failed with
--
--   You do not have access to this resource.
--   Row Level Security blocked the request.
--
-- Cause: two RESTRICTIVE policies on public.profiles, added by the original
-- production bundle, hard-code `role = 'customer'`:
--
--   profiles_customer_insert_only  INSERT  with check (id = auth.uid() and role = 'customer')
--   profiles_customer_update_only  UPDATE  using/with check (id = auth.uid() and role = 'customer')
--
-- A restrictive policy is ANDed with every permissive one, so the permissive
-- profiles_update_self policy could not save a row whose role is anything else.
-- The account that hit this is the owner's, whose profile carries role 'admin';
-- PostgreSQL reports it from the DO UPDATE half of the onboarding upsert as
--   42501 new row violates row-level security policy "profiles_customer_update_only".
-- Any admin — and any account whose role is 'owner', which is the default in
-- migrations 0001 — cannot update its own profile anywhere in the app, not just
-- in onboarding.
--
-- The fix states the intent instead of guessing the role value: you may write
-- your own profile row, and the role column must come out unchanged. That is
-- true for customers, owners and admins alike, and it still makes privilege
-- escalation impossible: a customer that puts 'admin' in the role column fails
-- the WITH CHECK, because the stored role is compared against the new one.
--
-- helper: read a role without re-entering the profile policy
-- A policy may not select from the table it protects (infinite recursion), so
-- the comparison goes through a SECURITY DEFINER function, which reads the row
-- unscoped.

create or replace function public.profile_role_of(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = p_user;
$$;

revoke all on function public.profile_role_of(uuid) from public, anon;
grant execute on function public.profile_role_of(uuid) to authenticated, service_role;

-- update: own row yes, own role change no
drop policy if exists profiles_customer_update_only on public.profiles;
create policy profiles_customer_update_only on public.profiles
  as restrictive
  for update
  to authenticated
  using (id = auth.uid() and role is not distinct from public.profile_role_of(auth.uid()))
  with check (id = auth.uid() and role is not distinct from public.profile_role_of(auth.uid()));

-- insert: own row yes, elevated role no
-- The signup trigger normally creates the row first, so this is the rare path.
-- It no longer demands one particular role name — only that a self-inserted row
-- is not an administrator row.
drop policy if exists profiles_customer_insert_only on public.profiles;
create policy profiles_customer_insert_only on public.profiles
  as restrictive
  for insert
  to authenticated
  with check (id = auth.uid() and coalesce(role, 'customer') <> 'admin');
