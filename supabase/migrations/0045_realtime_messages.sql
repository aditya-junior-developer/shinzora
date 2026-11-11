-- ============================================================================
-- 0045 · Direct messages were never live
-- ----------------------------------------------------------------------------
-- Supabase Realtime only carries a table that has been added to the
-- `supabase_realtime` publication. `community_messages` and `notifications` were
-- in it; `team_chat_messages` never was, so a direct message could not arrive in
-- an open conversation until the page was reloaded — the other person's reply
-- simply sat in the database. This adds it.
--
-- Nothing about who may listen changes: Realtime still applies the table's RLS
-- policies, and `team_chat_messages` is readable only by members of the
-- conversation (`is_team_conversation_member`). The publication decides *which*
-- tables can stream, not who is allowed to hear them.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'team_chat_messages'
     )
  then
    alter publication supabase_realtime add table public.team_chat_messages;
  end if;
end $$;

comment on table public.team_chat_messages is
  'Direct messages. On the realtime publication since 0045, so an open conversation receives them live.';
