-- 0021 · Lock the marketplace skill helper to signed-in callers.
-- 0020 revoked anon EXECUTE on the eleven public RPCs, but left
-- marketplace_clean_skills open because it is only a pure text[] normaliser.
-- It still sits in the exposed public schema, so it is revoked here for the
-- same reason the rest were: nothing client-side should reach it directly.
revoke all on function public.marketplace_clean_skills(text[]) from public, anon;
grant execute on function public.marketplace_clean_skills(text[]) to authenticated, service_role;
