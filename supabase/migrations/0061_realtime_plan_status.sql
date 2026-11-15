-- ============================================================================
-- 0061 — Plan and profile status reach the open dashboard in real time
--
-- The member's dashboard listens for changes to its own subscription and premium
-- entitlement, so an approved payment appears without a logout, a login or a
-- refresh. Realtime applies each table's row-level security, so a member only
-- receives their own rows (subscriptions_select_self, 0002; owner read, 0054).
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'subscriptions'
  ) then
    alter publication supabase_realtime add table public.subscriptions;
  end if;
end
$$;
