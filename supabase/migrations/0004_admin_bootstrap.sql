-- ============================================================================
-- SHINZORA · 0004_admin_bootstrap.sql
-- ----------------------------------------------------------------------------
-- Creates the FIRST administrator. This is the only supported way to grant
-- administrator rights, and it has to be run deliberately in the SQL editor.
--
--   1. Register the account normally through /auth/signup/ and verify the email.
--   2. Replace the address below with that account's email.
--   3. Run this file in the Supabase SQL editor.
--
-- There is no client-side path to this table: RLS allows a user to read their
-- own row only, and no INSERT/UPDATE/DELETE policy exists for any client role.
-- Additional administrators are added by editing the VALUES list, never
-- through the application UI.
-- ============================================================================

do $$
declare
  admin_email text := 'mext.aditya@gmail.com';
  target_id uuid;
begin
  if admin_email = 'REPLACE-WITH-YOUR-ADMIN-EMAIL@example.com' then
    raise notice 'No administrator created — set admin_email in 0004_admin_bootstrap.sql first.';
    return;
  end if;

  select id into target_id from auth.users where lower(email) = lower(admin_email) limit 1;

  if target_id is null then
    raise exception 'No auth user found for % — register through /auth/signup/ first.', admin_email;
  end if;

  insert into public.admin_users (user_id, email, role)
  values (target_id, admin_email, 'superadmin')
  on conflict (user_id) do update set role = 'superadmin', email = excluded.email;

  update public.profiles set role = 'admin' where id = target_id;

  raise notice 'Administrator granted to % (%).', admin_email, target_id;
end;
$$;

-- Confirm the result:
--   select a.email, a.role, a.created_at from public.admin_users a;
