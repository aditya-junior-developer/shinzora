-- ============================================================================
-- 0088 behaviour checks (investor interest). Run after 00 stub, 0086 and 0087.
-- Same fixture ids as 01_investor_portal_test.sql (investor B public, owner O = a).
-- ============================================================================
\set ON_ERROR_STOP 1

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false);
  perform set_config('request.jwt.claim.sub', u::text, false);
  execute 'set role authenticated';
end $$;

create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok then raise notice 'PASS: %', label; else raise exception 'FAIL: %', label; end if;
end $$;

create or replace function pg_temp.expect_fail(q text, label text) returns void language plpgsql as $$
begin
  execute q;
  raise exception 'FAIL (expected a block): %', label;
exception when others then
  if sqlerrm like 'FAIL (expected%' then raise; end if;
  if sqlstate in ('42601', '42P01', '42703', '42883', '42804') then
    raise exception 'FAIL (test statement broken, %): % -> %', sqlstate, label, sqlerrm;
  end if;
  raise notice 'PASS blocked: % -> % [%]', label, sqlerrm, sqlstate;
end $$;

-- Business 1 (Bakery) is investor_visible; 'Hidden Ltd' (…002) is not.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check(public.express_investor_interest('10000000-0000-0000-0000-000000000001') = true, 'investor B expresses interest in a listed business');
select pg_temp.check(public.express_investor_interest('10000000-0000-0000-0000-000000000001') = false, 'a second expression of interest is not a duplicate');
select pg_temp.check((select count(*) from public.investor_interests) = 1, 'investor sees own interest row only');
select pg_temp.expect_fail($q$select public.express_investor_interest('10000000-0000-0000-0000-000000000002')$q$, 'interest in a business that did not opt in');
select pg_temp.expect_fail($q$select public.express_investor_interest('10000000-0000-0000-0000-0000000000ff')$q$, 'interest in a business that does not exist');
reset role;

-- The owner was told exactly once, and the message does not name the investor.
select pg_temp.check((select count(*) from public.notifications n where n.user_id = '00000000-0000-0000-0000-00000000000a' and n.title = 'Investor interest') = 1, 'owner notified once');
select pg_temp.check((select count(*) from public.notifications n where n.user_id = '00000000-0000-0000-0000-00000000000a' and n.message like '%Asha%') = 0, 'owner notice does not name the investor');

-- An owner cannot express interest, and cannot read other investors' interests.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_fail($q$select public.express_investor_interest('10000000-0000-0000-0000-000000000001')$q$, 'owner expresses interest');
select pg_temp.check((select count(*) from public.investor_interests) = 0, 'owner cannot read investor interests');
reset role;

-- A customer cannot express interest.
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f0');
select pg_temp.expect_fail($q$select public.express_investor_interest('10000000-0000-0000-0000-000000000001')$q$, 'customer expresses interest');
reset role;

-- Investor profile: an investor can save their own profile, and cannot write someone else's.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from public.investor_profiles) = 1, 'investor reads only own profile row');
update public.investor_profiles set headline = 'Seed-stage fintech' where user_id = '00000000-0000-0000-0000-00000000000b';
select pg_temp.check((select headline from public.investor_profiles where user_id = '00000000-0000-0000-0000-00000000000b') = 'Seed-stage fintech', 'investor updates own profile');
update public.investor_profiles set headline = 'hacked' where user_id = '00000000-0000-0000-0000-00000000000c';
reset role;
select pg_temp.check((select headline from public.investor_profiles where user_id = '00000000-0000-0000-0000-00000000000c') is distinct from 'hacked', 'investor cannot edit another investor profile');

select 'ALL INVESTOR INTEREST CHECKS PASSED' as result;
