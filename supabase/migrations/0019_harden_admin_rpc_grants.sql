-- 0019 · Harden EXECUTE grants on SECURITY DEFINER functions.
--
-- Every public.admin_* function already verifies the caller with
-- public.is_admin()/is_superadmin() internally, so this is defence in depth
-- rather than a live hole: an anonymous request could reach the function body
-- and would be rejected there. The grant itself is unnecessary, and the fewer
-- privileged entry points a browser session can reach, the smaller the blast
-- radius of a future mistake in one of them.
--
-- Nothing here changes behaviour for signed-in users: these RPCs are called
-- from the admin console as an authenticated administrator.

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and (p.proname like 'admin\_%' or p.proname = 'open_payment_reference')
  loop
    execute format('revoke execute on function %s from public, anon', fn.signature);
    execute format('grant execute on function %s to authenticated, service_role', fn.signature);
  end loop;
end $$;

-- `set_admin_role` and `write_admin_audit` are part of the same privileged
-- surface even though their names do not start with admin_.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and p.proname in ('set_admin_role', 'write_admin_audit')
  loop
    execute format('revoke execute on function %s from public, anon', fn.signature);
    execute format('grant execute on function %s to authenticated, service_role', fn.signature);
  end loop;
end $$;
