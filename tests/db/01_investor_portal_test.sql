-- Behaviour tests for migration 0086. Runs as real roles with RLS on.
-- Any failed assertion raises and stops the run (ON_ERROR_STOP).
\set ON_ERROR_STOP on

create or replace function pg_temp.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  execute 'set role authenticated';
end $$;

create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set role anon';
end $$;

create or replace function pg_temp.as_super() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'reset role';
end $$;

create or replace function pg_temp.expect_fail(q text, label text) returns void language plpgsql as $$
begin
  execute q;
  raise exception 'FAIL (expected a block): %', label;
exception when others then
  if sqlerrm like 'FAIL (expected%' then raise; end if;
  -- A broken test statement is not a pass.
  if sqlstate in ('42601', '42P01', '42703', '42883', '42P10', '42804') then
    raise exception 'FAIL (test statement broken, %): % -> %', sqlstate, label, sqlerrm;
  end if;
  raise notice 'PASS blocked: % -> % [%]', label, sqlerrm, sqlstate;
end $$;

create or replace function pg_temp.check(ok boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;

-- ---------------------------------------------------------------- fixtures
select pg_temp.as_super();
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'), -- owner O
  ('00000000-0000-0000-0000-00000000000b'), -- investor A (public)
  ('00000000-0000-0000-0000-00000000000c'), -- investor B (connections only)
  ('00000000-0000-0000-0000-00000000000d'), -- investor C (private)
  ('00000000-0000-0000-0000-00000000000e'), -- investor D (public, not connected)
  ('00000000-0000-0000-0000-0000000000f0'), -- stranger, customer account
  ('00000000-0000-0000-0000-0000000000f1'); -- owner P (a different business owner)

insert into public.profiles (id, full_name, email, phone, avatar_url, account_type) values
  ('00000000-0000-0000-0000-00000000000a', 'Owner Oscar', 'o@x.test', '+910000000001', 'https://img/o.png', 'owner'),
  ('00000000-0000-0000-0000-00000000000b', 'Investor Asha', 'a@x.test', '+910000000002', 'https://img/a.png', 'investor'),
  ('00000000-0000-0000-0000-00000000000c', 'Investor Bilal', 'b@x.test', '+910000000003', null, 'investor'),
  ('00000000-0000-0000-0000-00000000000d', 'Investor Chandra', 'c@x.test', '+910000000004', null, 'investor'),
  ('00000000-0000-0000-0000-00000000000e', 'Investor Dev', 'd@x.test', '+910000000005', null, 'investor'),
  ('00000000-0000-0000-0000-0000000000f0', 'Stranger', 's@x.test', '+910000000006', null, 'customer'),
  ('00000000-0000-0000-0000-0000000000f1', 'Owner Priya', 'p@x.test', '+910000000007', null, 'owner');

insert into public.businesses (id, owner_id, name, description, category, stage, location, goals, goal_note,
                               phone, email, socials, investor_visible, funding_requirement_inr)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Bakery Co',
   'Artisan bread for Faridabad', 'Food', 'mvp', 'Faridabad', '["growth"]', 'Open a second shop',
   '+910000009999', 'secret@bakery.test', '{"instagram":"x"}', true, 5000000),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000f1', 'Priya Textiles',
   'Other owner business', 'Retail', 'mvp', 'Pune', '[]', null, '+910000007777', 'p@t.test', '{}', true, 3000000),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Hidden Ltd',
   'Not for investors', 'Retail', 'scaling', 'Delhi', '[]', null,
   '+910000008888', 'hidden@x.test', '{}', false, 90000000);

insert into public.investor_profiles (user_id, display_name, headline, bio, interests, preferred_industries, portfolio, visibility) values
  ('00000000-0000-0000-0000-00000000000b', 'Asha Rao', 'Early-stage food investor', 'Backs food startups', '{food}', '{Food}', 'Bakery Ltd', 'public'),
  ('00000000-0000-0000-0000-00000000000c', 'Bilal Khan', 'Growth capital', 'Growth rounds', '{saas}', '{Software}', 'SaaS Inc', 'connections'),
  ('00000000-0000-0000-0000-00000000000d', 'Chandra Das', 'Private investor', 'Quiet', '{}', '{}', null, 'private'),
  ('00000000-0000-0000-0000-00000000000e', 'Dev Malhotra', 'Angel', 'Angel cheques', '{retail}', '{Retail}', null, 'public');

-- ------------------------------------------------------- direct table access
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from public.businesses) = 0, 'investor cannot read businesses directly (RLS)');
select pg_temp.check((select count(*) from public.profiles) = 1, 'investor sees only own profile row directly');
select pg_temp.check((select count(*) from public.investor_profiles) = 1, 'investor sees only own investor profile directly');

-- ------------------------------------------------------------ marketplace
select pg_temp.check((select count(*) from public.investor_marketplace()) = 2, 'marketplace shows only investor_visible businesses (Bakery and Priya Textiles)');
select pg_temp.check((select count(*) from public.investor_marketplace() where name = 'Hidden Ltd') = 0, 'marketplace never returns a business that has not opted in');
select pg_temp.check((select count(*) from public.investor_marketplace(p_industry => 'Food')) = 1, 'industry filter keeps matching industry only');
select pg_temp.check((select count(*) from public.investor_marketplace(p_min_funding => 6000000)) = 0, 'funding filter excludes below minimum');
select pg_temp.check((select count(*) from public.investor_marketplace(p_query => 'bakery')) = 1, 'search matches name and description');
select pg_temp.check((select count(*) from public.investor_marketplace(p_location => 'Pune')) = 1, 'location filter keeps matching place only');
select pg_temp.check((select count(*) from public.investor_business('10000000-0000-0000-0000-000000000002')) = 0, 'business profile hidden when not opted in');
select pg_temp.check((select count(*) from public.investor_business('10000000-0000-0000-0000-000000000001')) = 1, 'business profile visible when opted in');

-- Returned columns must not include contact or social fields.
select pg_temp.check(
  (select count(*) from information_schema.routines r
    where r.routine_schema = 'public' and r.routine_name = 'investor_marketplace') = 1, 'marketplace function present once');

-- Owner and customer cannot use investor functions.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_fail($q$select * from public.investor_marketplace()$q$, 'owner calls investor marketplace');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f0');
select pg_temp.expect_fail($q$select * from public.investor_marketplace()$q$, 'customer calls investor marketplace');
select pg_temp.check((select count(*) from public.my_conversations()) = 0, 'customer inbox is empty, not an error');

-- ----------------------------------------------------------------- directory
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from public.investor_network_directory()) = 2, 'directory: A sees self + public D; not B (connections) or C (private)');
select pg_temp.check((select count(*) from public.investor_network_directory(p_query => 'chandra')) = 0, 'directory hides private investor even by name');
select pg_temp.expect_fail($q$select * from public.investor_profile_detail('00000000-0000-0000-0000-00000000000c')$q$, 'detail of connections-only profile, not connected');
select pg_temp.expect_fail($q$select * from public.investor_profile_detail('00000000-0000-0000-0000-00000000000d')$q$, 'detail of private profile');
select pg_temp.check((select bio from public.investor_profile_detail('00000000-0000-0000-0000-00000000000e')) = 'Angel cheques', 'detail of public profile shows bio');

-- ------------------------------------------------------------- connections
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check(public.request_connection('00000000-0000-0000-0000-00000000000c') is not null, 'A requests B');
select pg_temp.expect_fail($q$select public.request_connection('00000000-0000-0000-0000-00000000000c')$q$, 'A requests B twice');
select pg_temp.expect_fail($q$select public.request_connection('00000000-0000-0000-0000-00000000000d')$q$, 'A requests private C');
select pg_temp.expect_fail($q$select public.request_connection('00000000-0000-0000-0000-00000000000b')$q$, 'A requests self');
select pg_temp.expect_fail($q$select public.request_connection('00000000-0000-0000-0000-0000000000f0')$q$, 'investor requests a customer');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check((select count(*) from public.my_connections() where status = 'pending' and direction = 'received') = 1, 'B sees the pending request received');
select pg_temp.check((select count(*) from public.investor_network_directory() where user_id = '00000000-0000-0000-0000-00000000000b' and connection_status = 'request_received') = 1, 'directory shows request_received to B');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.expect_fail($q$select public.respond_connection((select id from public.investor_connections where addressee_id = '00000000-0000-0000-0000-00000000000c' limit 1), true)$q$, 'D answers a request addressed to B');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
select pg_temp.check(public.respond_connection((select id from public.investor_connections where addressee_id = '00000000-0000-0000-0000-00000000000c'), true) = 'accepted', 'B accepts A');
select pg_temp.expect_fail($q$select public.respond_connection((select id from public.investor_connections where addressee_id = '00000000-0000-0000-0000-00000000000c'), false)$q$, 'B answers the same request twice');

-- Connected now: B can see A's details because A is public; the connections-only
-- profile of B is visible to A.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select bio from public.investor_profile_detail('00000000-0000-0000-0000-00000000000c')) = 'Growth rounds', 'after accepting, A sees B connections-only profile');
select pg_temp.check((select count(*) from public.my_connections() where status = 'accepted') = 1, 'A sees the accepted connection');
select pg_temp.check((select connection_status from public.investor_network_directory() where user_id = '00000000-0000-0000-0000-00000000000c') = 'connected', 'directory shows connected');

-- Decline then re-request: D declines A, A asks again.
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check(public.request_connection('00000000-0000-0000-0000-00000000000e') is not null, 'A requests D (public)');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check(public.respond_connection((select id from public.investor_connections where addressee_id = '00000000-0000-0000-0000-00000000000e' and status='pending'), false) = 'declined', 'D declines A');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check(public.request_connection('00000000-0000-0000-0000-00000000000e') is not null, 'A may send again after decline');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from public.my_connections() where status = 'pending') = 1, 'D sees the re-sent request');

-- Notifications from connection events.
select pg_temp.as_super();
select pg_temp.check((select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-00000000000c' and title = 'New connection request') = 1, 'B notified of request');
select pg_temp.check((select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-00000000000b' and title = 'Connection accepted') = 1, 'A notified of acceptance');

-- ----------------------------------------------------------------- pitches
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_fail($q$select public.send_pitch('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000c', 'Round', 'We need funds to open a second shop.', 1000000)$q$, 'owner pitches B (connections-only, not public)');
select pg_temp.expect_fail($q$select public.send_pitch('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000d', 'Round', 'We need funds to open a second shop.', 1000000)$q$, 'owner pitches private C');
select pg_temp.expect_fail($q$select public.send_pitch('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f0', 'Round', 'We need funds to open a second shop.', 1000000)$q$, 'owner pitches a customer');
select pg_temp.expect_fail($q$select public.send_pitch('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000b', 'Round', 'Pitch for a business I do not own.', 1000000)$q$, 'owner O pitches with business owned by P');
select pg_temp.check(public.send_pitch('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'Second shop round', 'We need funds to open a second shop in Faridabad.', 2500000) is not null, 'owner pitches A (public)');
select pg_temp.expect_fail($q$select public.send_pitch('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'Again', 'Duplicate pitch that should be refused.', 1000)$q$, 'duplicate open pitch');
select pg_temp.expect_fail($q$select public.send_pitch('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000b', 'Hi', 'short', 1000)$q$, 'pitch with too-short summary');

-- Attachments: the file must sit under this pitch's folder, be an allowed type, and be at most 10 MB.
select pg_temp.as_super();
select pg_temp.check((select count(*) from public.investment_pitches) = 1, 'one pitch stored');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select id as pitch from public.investment_pitches \gset
select pg_temp.expect_fail(format($q$select public.add_pitch_attachment(%L, %L, 'deck.pdf', 1000, 'application/pdf')$q$, :'pitch', '99999999-9999-9999-9999-999999999999/deck.pdf'), 'attachment in another pitch folder');
select pg_temp.expect_fail(format($q$select public.add_pitch_attachment(%L, %L, 'virus.html', 1000, 'text/html')$q$, :'pitch', :'pitch' || '/virus.html'), 'attachment with disallowed type');
select pg_temp.expect_fail(format($q$select public.add_pitch_attachment(%L, %L, 'big.pdf', 10485761, 'application/pdf')$q$, :'pitch', :'pitch' || '/big.pdf'), 'attachment over 10 MB');
select public.add_pitch_attachment(:'pitch', :'pitch' || '/deck.pdf', 'deck.pdf', 1000, 'application/pdf');
select pg_temp.check((select jsonb_array_length(attachments) from public.investment_pitches) = 1, 'attachment list has one entry');

-- Storage: owner may upload into the pitch folder; investor may read it; others may not.
-- The migration creates the bucket; check its settings instead.
select pg_temp.check((select file_size_limit from storage.buckets where id = 'pitch-attachments') = 10485760 and not (select public from storage.buckets where id = 'pitch-attachments'), 'bucket is private and capped at 10 MB');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check((select count(*) from (select 1 from (values (1)) v(x) where exists (
  select 1 from public.investment_pitches p where p.id::text = (storage.foldername(:'pitch' || '/deck.pdf'))[1] and p.owner_id = auth.uid()
)) q) = 1, 'owner passes the folder check for own pitch');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((select count(*) from public.investment_pitches p where p.id::text = (storage.foldername(:'pitch' || '/deck.pdf'))[1] and (p.owner_id = auth.uid() or p.investor_id = auth.uid())) = 1, 'addressed investor passes the read check');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.check((select count(*) from public.investment_pitches p where p.id::text = (storage.foldername(:'pitch' || '/deck.pdf'))[1] and (p.owner_id = auth.uid() or p.investor_id = auth.uid())) = 0, 'other investor fails the read check');

-- ------------------------------------------------------- respond to a pitch
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.expect_fail($q$select public.investor_respond_pitch((select id from public.investment_pitches), 'info_requested', '')$q$, 'info request with no text');
select pg_temp.check(public.investor_respond_pitch((select id from public.investment_pitches), 'info_requested', 'Please share last 6 months of sales.') = 'info_requested', 'investor requests more information');
select pg_temp.check(public.investor_respond_pitch((select id from public.investment_pitches), 'interested', null) = 'interested', 'investor marks interest');
select pg_temp.check(public.investor_respond_pitch((select id from public.investment_pitches), 'accepted', null) = 'accepted', 'investor accepts');
select pg_temp.expect_fail($q$select public.investor_respond_pitch((select id from public.investment_pitches), 'declined', null)$q$, 'changing an accepted pitch');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.expect_fail($q$select public.investor_respond_pitch((select id from public.investment_pitches), 'accepted', null)$q$, 'owner answers its own pitch');
select pg_temp.check((select status from public.my_pitches() where role = 'sent') = 'accepted', 'owner tracks the pitch status');
select pg_temp.check((select counterpart_name from public.my_pitches() where role = 'sent') = 'Asha Rao' and (select counterpart_name from public.my_pitches() where role = 'sent') <> 'a@x.test', 'owner sees the investor public name, not the email');
select pg_temp.as_super();
select pg_temp.check((select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-00000000000a' and title = 'Pitch update') >= 3, 'owner notified of each status change');
select pg_temp.check((select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-00000000000b' and title = 'New business pitch') = 1, 'investor notified of the new pitch');

-- --------------------------------------------------------------- messaging
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check(public.open_direct_conversation('00000000-0000-0000-0000-00000000000b') is not null, 'owner may message A (pitch linked)');
select pg_temp.expect_fail($q$select public.open_direct_conversation('00000000-0000-0000-0000-00000000000c')$q$, 'owner messages B (no pitch)');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check(public.open_direct_conversation('00000000-0000-0000-0000-00000000000c') is not null, 'A may message connected B');
select pg_temp.expect_fail($q$select public.open_direct_conversation('00000000-0000-0000-0000-00000000000e')$q$, 'A messages unconnected D');
select pg_temp.expect_fail($q$select public.open_direct_conversation('00000000-0000-0000-0000-0000000000f0')$q$, 'A messages a customer');
select pg_temp.check(public.open_direct_conversation('00000000-0000-0000-0000-00000000000a') is not null, 'A may open the owner thread (same thread, idempotent)');

select id as conv_ab from public.direct_conversations where user_a = least('00000000-0000-0000-0000-00000000000a'::uuid,'00000000-0000-0000-0000-00000000000b'::uuid) and user_b = greatest('00000000-0000-0000-0000-00000000000a'::uuid,'00000000-0000-0000-0000-00000000000b'::uuid) \gset
select pg_temp.check(public.send_direct_message(:'conv_ab', 'Thanks for the pitch. Can we talk Thursday?') is not null, 'A sends a message');
select pg_temp.expect_fail(format($q$select public.send_direct_message(%L, '   ')$q$, :'conv_ab'), 'empty message refused');
select pg_temp.expect_fail(format($q$select public.send_direct_message(%L, %L)$q$, :'conv_ab', repeat('x', 4001)), 'message over 4000 characters refused');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
select pg_temp.expect_fail(format($q$select public.send_direct_message(%L, 'Hi there')$q$, :'conv_ab'), 'non-member D posts into the A-O thread');
select pg_temp.check((select count(*) from public.direct_messages) = 0, 'non-member sees no messages');

select pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
select pg_temp.check((select count(*) from public.direct_messages) = 1, 'owner (member) reads the message');
select pg_temp.check((select unread_count from public.my_conversations() where conversation_id = :'conv_ab') = 1, 'owner sees 1 unread');
select pg_temp.check((select count(*) from public.my_conversations()) = 1, 'owner inbox lists one conversation');
select public.mark_conversation_read(:'conv_ab');
select pg_temp.check((select unread_count from public.my_conversations() where conversation_id = :'conv_ab') = 0, 'unread count clears after reading');
select pg_temp.as_super();
select pg_temp.check((select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-00000000000a' and title = 'New message') = 1, 'owner notified of the new message');

-- --------------------------------------------------------------- dashboard
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
select pg_temp.check((public.investor_dashboard()->>'listed_businesses')::int = 2, 'dashboard: two opted-in businesses (Bakery, Priya Textiles)');
select pg_temp.check((public.investor_dashboard()->>'connections')::int = 1, 'dashboard: A has one accepted connection (B); D is still pending');
select pg_temp.check((public.investor_dashboard()->>'pending_requests_in')::int = 0, 'dashboard: A has no requests waiting on A');
select pg_temp.check((public.investor_dashboard()->>'unread_messages')::int = 0, 'dashboard: A has no unread');

-- ------------------------------------------------------------- anonymous
select pg_temp.as_anon();
select pg_temp.expect_fail($q$select * from public.investor_marketplace()$q$, 'anonymous browses marketplace');
select pg_temp.expect_fail($q$select * from public.investor_network_directory()$q$, 'anonymous browses directory');
select pg_temp.expect_fail($q$select count(*) from public.investment_pitches$q$, 'anonymous reads pitches table');

select pg_temp.as_super();
select pg_temp.check(to_regclass('public.direct_messages') is not null, 'messages table exists');
select pg_temp.check(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'direct_messages'), 'direct_messages is in realtime publication');
select 'ALL INVESTOR PORTAL CHECKS PASSED' as result;
