-- 0024 — community chat, portfolio, invitation completion, pitch decisions, notification fan-out
--
-- Reuses everything already present (profiles/businesses/freelancer_profiles/
-- marketplace_jobs/marketplace_proposals/business_team_*). Adds only what the
-- phase-3 brief needs and nothing that already exists in another shape.
--
-- Applied in three parts:
--   a) community_portfolio_schema
--   b) community_invitations_rpc
--   c) grants_and_notification_triggers

-- ---------------------------------------------------------------- a) schema

alter table public.freelancer_profiles
  add column if not exists resume_url   text,
  add column if not exists experience   jsonb not null default '[]'::jsonb,
  add column if not exists social_links jsonb not null default '{}'::jsonb,
  add column if not exists languages    text[] not null default '{}'::text[],
  add column if not exists timezone     text;

comment on column public.freelancer_profiles.experience is
  'Array of {role, company, from, to, summary} entries, rendered on the agent profile modal.';
comment on column public.freelancer_profiles.resume_url is
  'Storage path or external URL for the CV. Optional.';

create table if not exists public.freelancer_portfolio_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 1 and 160),
  summary      text check (summary is null or char_length(summary) <= 2000),
  url          text,
  image_url    text,
  skills       text[] not null default '{}'::text[],
  completed_on date,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists freelancer_portfolio_items_user_idx
  on public.freelancer_portfolio_items (user_id, sort_order, created_at desc);

alter table public.freelancer_portfolio_items enable row level security;

drop policy if exists "portfolio readable by signed in users" on public.freelancer_portfolio_items;
create policy "portfolio readable by signed in users"
  on public.freelancer_portfolio_items for select
  to authenticated using (true);

drop policy if exists "portfolio owner writes" on public.freelancer_portfolio_items;
create policy "portfolio owner writes"
  on public.freelancer_portfolio_items for all
  to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Community: public text-only rooms. Deliberately has no attachment column —
-- that is how "text only, no images" is enforced at the storage layer.
create table if not exists public.community_channels (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name        text not null,
  description text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.community_messages (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.community_channels(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  removed_at timestamptz
);

create index if not exists community_messages_channel_idx
  on public.community_messages (channel_id, created_at desc);

alter table public.community_channels enable row level security;
alter table public.community_messages enable row level security;

drop policy if exists "channels readable" on public.community_channels;
create policy "channels readable"
  on public.community_channels for select to authenticated using (true);

drop policy if exists "messages readable" on public.community_messages;
create policy "messages readable"
  on public.community_messages for select to authenticated using (removed_at is null);

insert into public.community_channels (slug, name, description, sort_order) values
  ('general',  'General',  'Introductions, questions and everything else.', 10),
  ('projects', 'Projects', 'Talk about live projects and who is building what.', 20),
  ('wins',     'Wins',     'Shipped something? Post it here.', 30)
on conflict (slug) do nothing;

-- Invitation + proposal lifecycle columns.
alter table public.business_team_invites
  add column if not exists declined_at timestamptz,
  add column if not exists last_notified_at timestamptz;

alter table public.marketplace_proposals
  add column if not exists decided_at   timestamptz,
  add column if not exists decided_by   uuid references public.profiles(id) on delete set null,
  add column if not exists decision_note text;

alter table public.marketplace_jobs
  add column if not exists published_at timestamptz,
  add column if not exists closed_at    timestamptz;

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- These two columns exist on the live project but were never declared in a
-- migration, so a from-scratch install produced a `notifications` table that
-- notify_user() could not write to. Declared here (no-op in production) so the
-- migration set and the live schema agree.
alter table public.notifications
  add column if not exists message text not null default '',
  add column if not exists is_read boolean default false;

-- ------------------------------------------------- b) functions

create or replace function public.notify_user(p_user uuid, p_type text, p_title text, p_message text, p_link text default null, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare
  target text := p_link;
begin
  if p_user is null then return; end if;
  -- Callers name the destination as '#view'; the notification centre does a
  -- location.assign(), so store a real route. Without this, '#invitations'
  -- reloads the current page instead of opening the invitations screen.
  if target like '#%' then
    target := '/app/?view=' || substr(target, 2);
  end if;
  insert into public.notifications (user_id, title, message, body, type, link, meta, is_read)
  values (p_user, left(coalesce(p_title,'Notification'),200), left(coalesce(p_message,''),1000), left(coalesce(p_message,''),1000), coalesce(p_type,'general'), target, coalesce(p_meta,'{}'::jsonb), false);
end;
$fn$;

create or replace function public.community_send(p_channel text, p_body text)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  ch uuid;
  clean text := btrim(coalesce(p_body,''));
  recent timestamptz;
  msg public.community_messages%rowtype;
begin
  if actor is null then raise exception 'Sign in to post in the community.' using errcode='42501'; end if;
  if char_length(clean) < 1 then raise exception 'Write something first.' using errcode='22023'; end if;
  if char_length(clean) > 4000 then raise exception 'Community messages are limited to 4000 characters.' using errcode='22023'; end if;
  select id into ch from public.community_channels where slug = lower(btrim(coalesce(p_channel,'')));
  if ch is null then raise exception 'That channel does not exist.' using errcode='22023'; end if;
  select max(created_at) into recent from public.community_messages where author_id = actor;
  if recent is not null and recent > now() - interval '2 seconds' then
    raise exception 'Slow down for a moment before posting again.' using errcode='22023';
  end if;
  insert into public.community_messages (channel_id, author_id, body) values (ch, actor, clean) returning * into msg;
  return jsonb_build_object('id',msg.id,'channel',p_channel,'body',msg.body,'createdAt',msg.created_at);
end;
$fn$;

create or replace function public.community_messages_list(p_channel text, p_before timestamptz default null, p_limit integer default 60)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  ch uuid;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to read the community.' using errcode='42501'; end if;
  select id into ch from public.community_channels where slug = lower(btrim(coalesce(p_channel,'')));
  if ch is null then raise exception 'That channel does not exist.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'body', x.body, 'createdAt', x.created_at, 'authorId', x.author_id,
    'authorName', coalesce(x.full_name, 'Member'), 'username', x.username, 'avatarUrl', x.avatar_url
  ) order by x.created_at asc), '[]'::jsonb) into result
  from (
    select m.id, m.body, m.created_at, m.author_id, pr.full_name, pr.username, pr.avatar_url
      from public.community_messages m
      join public.profiles pr on pr.id = m.author_id
     where m.channel_id = ch and m.removed_at is null
       and (p_before is null or m.created_at < p_before)
     order by m.created_at desc
     limit greatest(1, least(coalesce(p_limit, 60), 200))
  ) x;
  return result;
end;
$fn$;

create or replace function public.team_search_people(p_business uuid, p_query text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  q text := lower(btrim(coalesce(p_query,'')));
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to search people.' using errcode='42501'; end if;
  if not exists (select 1 from public.businesses b where b.id = p_business and (b.owner_id = actor or public.is_admin(actor))) then
    raise exception 'Only the business owner can invite people.' using errcode='42501';
  end if;
  if char_length(q) < 2 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', x.id, 'fullName', x.full_name, 'username', x.username, 'email', x.email,
    'avatarUrl', x.avatar_url, 'accountType', x.account_type,
    'isMember', exists (select 1 from public.business_team_members m where m.business_id = p_business and m.user_id = x.id),
    'hasPendingInvite', exists (select 1 from public.business_team_invites i where i.business_id = p_business and i.invite_email_normalized = lower(x.email) and i.accepted_at is null and i.revoked_at is null and i.declined_at is null)
  ) order by x.full_name), '[]'::jsonb) into result
  from (
    select pr.id, pr.full_name, pr.username, pr.email, pr.avatar_url, pr.account_type
      from public.profiles pr
     where pr.id <> actor
       and (lower(coalesce(pr.username,'')) like q || '%'
         or lower(coalesce(pr.email,'')) like q || '%'
         or lower(coalesce(pr.full_name,'')) like '%' || q || '%')
     order by pr.full_name
     limit 12
  ) x;
  return result;
end;
$fn$;

-- The invitee's inbox. Declined invitations are excluded so the row does not
-- keep reappearing after it has been answered.
create or replace function public.team_my_invitations()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  mail text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  result jsonb;
begin
  if actor is null or mail = '' then raise exception 'Sign in with a verified email address.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'inviteId', i.id,
    'businessId', i.business_id,
    'businessName', b.name,
    'businessLogo', b.logo_url,
    'email', i.invite_email_normalized,
    'memberType', i.member_type,
    'createdAt', i.created_at,
    'inviterName', coalesce(pr.full_name, pr.username, 'A business owner')
  ) order by i.created_at desc), '[]'::jsonb) into result
  from public.business_team_invites i
  join public.businesses b on b.id = i.business_id
  left join public.profiles pr on pr.id = i.invited_by
  where i.invite_email_normalized = mail
    and i.accepted_at is null and i.revoked_at is null and i.declined_at is null;
  return result;
end;
$fn$;

create or replace function public.team_decline_invite(p_invite uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  mail text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  invitation public.business_team_invites%rowtype;
begin
  if actor is null or mail = '' then raise exception 'Sign in with the invited email address.' using errcode='42501'; end if;
  update public.business_team_invites
     set declined_at = now()
   where id = p_invite and invite_email_normalized = mail
     and accepted_at is null and revoked_at is null and declined_at is null
   returning * into invitation;
  if invitation.id is null then raise exception 'This invitation is unavailable for this email address.' using errcode='42501'; end if;
  return jsonb_build_object('ok', true, 'businessId', invitation.business_id);
end;
$fn$;

create or replace function public.team_accept_invite(p_invite uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  mail text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  invitation public.business_team_invites%rowtype;
  bname text;
begin
  if actor is null or mail = '' then raise exception 'Sign in with the invited email address.' using errcode='42501'; end if;
  select * into invitation
    from public.business_team_invites i
   where i.id = p_invite and i.invite_email_normalized = mail
     and i.accepted_at is null and i.revoked_at is null and i.declined_at is null
   for update;
  if invitation.id is null then raise exception 'This invitation is unavailable for this email address.' using errcode='42501'; end if;

  insert into public.business_team_members (business_id, user_id, member_type, invited_by)
  values (invitation.business_id, actor, invitation.member_type, invitation.invited_by)
  on conflict (business_id, user_id) do update set member_type = excluded.member_type;
  update public.business_team_invites
     set accepted_at = now(), invited_user_id = actor
   where id = invitation.id;
  select name into bname from public.businesses where id = invitation.business_id;
  perform public.notify_user(invitation.invited_by, 'invite_accepted', 'Your invitation was accepted',
    format('Someone joined %s as %s.', coalesce(bname,'your business'), invitation.member_type),
    '#team', jsonb_build_object('businessId', invitation.business_id, 'userId', actor));
  return jsonb_build_object('ok', true, 'businessId', invitation.business_id, 'businessName', bname, 'memberType', invitation.member_type);
end;
$fn$;

-- Accept and reject were previously both missing: `marketplace_accept_proposal`
-- could only ever say yes, so a rejected pitch stayed 'submitted' forever.
create or replace function public.marketplace_decide_proposal(p_proposal uuid, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  decision text := lower(btrim(coalesce(p_decision,'')));
  prop public.marketplace_proposals%rowtype;
  job public.marketplace_jobs%rowtype;
  contract_id uuid;
begin
  if actor is null then raise exception 'Sign in to review pitches.' using errcode='42501'; end if;
  if decision not in ('accept','reject') then raise exception 'Choose accept or reject.' using errcode='22023'; end if;
  select * into prop from public.marketplace_proposals where id = p_proposal for update;
  if prop.id is null then raise exception 'That pitch no longer exists.' using errcode='22023'; end if;
  select * into job from public.marketplace_jobs where id = prop.job_id for update;
  if job.id is null then raise exception 'That project no longer exists.' using errcode='22023'; end if;
  if job.owner_id <> actor and not public.is_admin(actor) then
    raise exception 'Only the project owner can decide on pitches.' using errcode='42501';
  end if;
  if prop.status <> 'submitted' then raise exception 'This pitch was already decided.' using errcode='22023'; end if;

  if decision = 'reject' then
    update public.marketplace_proposals
       set status='rejected', decided_at=now(), decided_by=actor, decision_note=left(coalesce(p_note,''),2000)
     where id = prop.id;
    perform public.notify_user(prop.freelancer_id, 'proposal_rejected', 'Your pitch was not taken forward',
      format('The owner reviewed your pitch for "%s".', job.title), '#my-work',
      jsonb_build_object('jobId', job.id, 'proposalId', prop.id));
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  update public.marketplace_proposals
     set status='accepted', decided_at=now(), decided_by=actor, decision_note=left(coalesce(p_note,''),2000)
   where id = prop.id;
  update public.marketplace_jobs set status='filled', closed_at=now() where id = job.id;
  select id into contract_id from public.marketplace_contracts where proposal_id = prop.id limit 1;
  if contract_id is null then
    insert into public.marketplace_contracts (job_id, proposal_id, client_id, freelancer_id, amount, currency, status, started_at)
    values (job.id, prop.id, job.owner_id, prop.freelancer_id, prop.bid_amount, prop.currency, 'active', now())
    returning id into contract_id;
  end if;
  perform public.notify_user(prop.freelancer_id, 'proposal_accepted', 'You were hired',
    format('The owner accepted your pitch for "%s".', job.title), '#my-work',
    jsonb_build_object('jobId', job.id, 'proposalId', prop.id, 'contractId', contract_id));
  return jsonb_build_object('ok', true, 'status', 'accepted', 'contractId', contract_id);
end;
$fn$;

-- ------------------------------------------------- c) triggers + grants

create or replace function public.tg_notify_team_invite()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare bname text;
begin
  if new.invited_user_id is null or new.accepted_at is not null or new.revoked_at is not null or new.declined_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.invited_user_id is not distinct from new.invited_user_id and old.member_type is not distinct from new.member_type and old.revoked_at is not distinct from new.revoked_at then
    return new;
  end if;
  select name into bname from public.businesses where id = new.business_id;
  perform public.notify_user(new.invited_user_id, 'team_invite', 'You have a team invitation',
    format('%s invited you to join as %s.', coalesce(bname,'A business'), new.member_type),
    '#invitations', jsonb_build_object('inviteId', new.id, 'businessId', new.business_id));
  new.last_notified_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_notify_team_invite on public.business_team_invites;
create trigger trg_notify_team_invite
  before insert or update on public.business_team_invites
  for each row execute function public.tg_notify_team_invite();

create or replace function public.tg_notify_proposal()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare job record;
begin
  if new.status is distinct from 'submitted' then return new; end if;
  select id, title, owner_id into job from public.marketplace_jobs where id = new.job_id;
  if job.owner_id is null or job.owner_id = new.freelancer_id then return new; end if;
  perform public.notify_user(job.owner_id, 'proposal_received', 'New pitch on your project',
    format('Someone pitched on "%s".', job.title), '#my-projects',
    jsonb_build_object('jobId', job.id, 'proposalId', new.id));
  return new;
end;
$fn$;

drop trigger if exists trg_notify_proposal on public.marketplace_proposals;
create trigger trg_notify_proposal
  after insert on public.marketplace_proposals
  for each row execute function public.tg_notify_proposal();

-- notify_user is an internal fan-out helper. Postgres grants EXECUTE to PUBLIC
-- by default, which would let any signed-in user push notifications to anyone,
-- so every public grant is revoked explicitly.
revoke all on function public.notify_user(uuid,text,text,text,text,jsonb) from public;
revoke all on function public.notify_user(uuid,text,text,text,text,jsonb) from anon;
revoke all on function public.notify_user(uuid,text,text,text,text,jsonb) from authenticated;

grant execute on function public.community_send(text,text) to authenticated;
grant execute on function public.community_messages_list(text,timestamptz,integer) to authenticated;
grant execute on function public.team_search_people(uuid,text) to authenticated;
grant execute on function public.team_decline_invite(uuid) to authenticated;
grant execute on function public.team_my_invitations() to authenticated;
grant execute on function public.team_accept_invite(uuid) to authenticated;
grant execute on function public.marketplace_decide_proposal(uuid,text,text) to authenticated;
revoke all on function public.community_send(text,text) from anon;
revoke all on function public.community_messages_list(text,timestamptz,integer) from anon;
revoke all on function public.team_search_people(uuid,text) from anon;
revoke all on function public.team_decline_invite(uuid) from anon;
revoke all on function public.marketplace_decide_proposal(uuid,text,text) from anon;

do $rt$ begin
  begin alter publication supabase_realtime add table public.community_messages; exception when others then null; end;
  begin alter publication supabase_realtime add table public.notifications; exception when others then null; end;
end $rt$;
