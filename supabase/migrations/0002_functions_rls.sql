-- ============================================================================
-- SHINZORA · 0002_functions_rls.sql
-- ----------------------------------------------------------------------------
-- Server-side authority:
--   • is_admin()          — admin rights live only in public.admin_users
--   • handle_new_user()   — profile + free subscription + onboarding row
--   • ai_usage_quota()    — plan limits, readable from the client
--   • consume_ai_credit() — atomic credit spend, service-role only
--   • log_activity()      — audit trail written with auth.uid()
--   • payments guard      — a payment can only become 'verified' through an
--                           administrator or a service-role provider callback
--   • RLS on every table, owner-scoped, with admin read access
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- is_admin() — the single source of truth for administrator rights.
-- SECURITY DEFINER so it can read admin_users even though RLS restricts it.
-- A normal user can never insert into admin_users (no policy allows it), so
-- self-promotion is impossible.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = p_user
      and a.role in ('admin', 'superadmin')
  );
$$;

create or replace function public.admin_role(p_user uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = public
as $$
  select a.role from public.admin_users a where a.user_id = p_user limit 1;
$$;

grant execute on function public.is_admin(uuid) to authenticated, anon;
grant execute on function public.admin_role(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- New user bootstrap
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
    new.email
  )
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id, plan, status, ai_credits_limit)
  values (new.id, 'free', 'active', 30)
  on conflict (user_id) do nothing;

  insert into public.onboarding_progress (user_id, current_step, data)
  values (new.id, 1, '{}'::jsonb)
  on conflict (user_id) do nothing;

  insert into public.notifications (user_id, title, body, type, link)
  values (
    new.id,
    'Welcome to Shinzora',
    'Finish onboarding to let the AI learn your business, then generate your first site.',
    'account',
    '/onboarding/'
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- AI quota
-- ---------------------------------------------------------------------------
create or replace function public.ai_usage_quota()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sub public.subscriptions;
  period_start timestamptz := date_trunc('month', now());
  used int;
begin
  select * into sub from public.subscriptions where user_id = auth.uid();

  if sub.user_id is null then
    return jsonb_build_object('plan', 'free', 'used', 0, 'limit', 30, 'remaining', 30, 'period_start', period_start);
  end if;

  -- Reset the counter lazily when the billing period has rolled over.
  if sub.ai_period_start is null or sub.ai_period_start < period_start then
    update public.subscriptions
       set ai_credits_used = 0, ai_period_start = period_start
     where user_id = auth.uid();
    used := 0;
  else
    used := coalesce(sub.ai_credits_used, 0);
  end if;

  return jsonb_build_object(
    'plan', sub.plan,
    'used', used,
    'limit', sub.ai_credits_limit,
    'remaining', greatest(sub.ai_credits_limit - used, 0),
    'period_start', period_start,
    'period_end', sub.current_period_end
  );
end;
$$;

grant execute on function public.ai_usage_quota() to authenticated;

-- Atomic credit spend. Called by the `ai` Edge Function (service role) so the
-- browser can never increment its own counter.
create or replace function public.consume_ai_credit(
  p_user uuid,
  p_mode text,
  p_model text default null,
  p_credits int default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.subscriptions;
  period_start timestamptz := date_trunc('month', now());
begin
  select * into sub from public.subscriptions where user_id = p_user for update;

  if sub.user_id is null then
    insert into public.subscriptions (user_id, plan, status, ai_credits_used, ai_credits_limit)
    values (p_user, 'free', 'active', p_credits, 30)
    on conflict (user_id) do update set ai_credits_used = public.subscriptions.ai_credits_used + p_credits
    returning * into sub;
  else
    if sub.ai_period_start is null or sub.ai_period_start < period_start then
      sub.ai_credits_used := 0;
      update public.subscriptions set ai_period_start = period_start where user_id = p_user;
    end if;

    if sub.ai_credits_used + p_credits > sub.ai_credits_limit then
      return jsonb_build_object('ok', false, 'reason', 'quota_exceeded',
        'used', sub.ai_credits_used, 'limit', sub.ai_credits_limit, 'plan', sub.plan);
    end if;

    update public.subscriptions
       set ai_credits_used = ai_credits_used + p_credits
     where user_id = p_user
    returning * into sub;
  end if;

  insert into public.ai_usage_log (user_id, mode, model, credits)
  values (p_user, p_mode, p_model, p_credits);

  return jsonb_build_object('ok', true, 'used', sub.ai_credits_used, 'limit', sub.ai_credits_limit, 'plan', sub.plan);
end;
$$;

revoke all on function public.consume_ai_credit(uuid, text, text, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Activity log — callable from the browser, always attributed to auth.uid()
-- ---------------------------------------------------------------------------
create or replace function public.log_activity(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_meta jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into public.customer_activity (user_id, action, entity_type, entity_id, meta)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, coalesce(p_meta, '{}'::jsonb));
end;
$$;

grant execute on function public.log_activity(text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Payments guard — closing a window, reloading the app or editing the DOM can
-- never mark a payment as verified. Only an admin session or the service role
-- may move a payment into 'verified'.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text := coalesce(current_setting('request.jwt.claims', true)::jsonb->>'role', current_user);
begin
  if new.status = 'verified' and coalesce(old.status, 'pending') <> 'verified' then
    if caller_role not in ('service_role', 'postgres', 'supabase_admin') and not public.is_admin() then
      raise exception 'Only an administrator or a verified provider callback can confirm a payment.'
        using errcode = 'check_violation';
    end if;
    new.verified_at := coalesce(new.verified_at, now());
    new.verified_by := coalesce(new.verified_by, auth.uid());
  end if;

  if new.status = 'verified' and old.status is distinct from 'verified' then
    insert into public.notifications (user_id, title, body, type, link)
    values (
      new.owner_id,
      'Payment verified',
      'Payment ' || new.reference || ' for ' || coalesce(new.label, new.purpose) || ' has been verified.',
      'payment',
      '/app/?view=billing'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists payments_guard on public.payments;
create trigger payments_guard
  before update on public.payments
  for each row execute function public.guard_payment_status();

-- ---------------------------------------------------------------------------
-- Project counters — version_count and published state stay truthful
-- ---------------------------------------------------------------------------
create or replace function public.bump_project_version_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.projects
     set version_count = (select count(*) from public.project_versions v where v.project_id = new.project_id),
         updated_at = now()
   where id = new.project_id;
  return new;
end;
$$;

drop trigger if exists project_versions_count on public.project_versions;
create trigger project_versions_count
  after insert on public.project_versions
  for each row execute function public.bump_project_version_count();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.businesses          enable row level security;
alter table public.onboarding_progress enable row level security;
alter table public.subscriptions       enable row level security;
alter table public.projects            enable row level security;
alter table public.project_versions    enable row level security;
alter table public.ai_conversations    enable row level security;
alter table public.ai_messages         enable row level security;
alter table public.domains             enable row level security;
alter table public.domain_orders       enable row level security;
alter table public.payments            enable row level security;
alter table public.notifications       enable row level security;
alter table public.admin_announcements enable row level security;
alter table public.support_tickets     enable row level security;
alter table public.support_replies     enable row level security;
alter table public.service_requests    enable row level security;
alter table public.customer_activity   enable row level security;
alter table public.store_products      enable row level security;
alter table public.store_customers     enable row level security;
alter table public.store_orders        enable row level security;
alter table public.store_order_items   enable row level security;
alter table public.campaigns           enable row level security;
alter table public.integrations        enable row level security;
alter table public.integration_tokens  enable row level security;
alter table public.deployments         enable row level security;
alter table public.admin_users         enable row level security;
alter table public.contact_messages    enable row level security;
alter table public.ai_usage_log        enable row level security;

-- profiles ------------------------------------------------------------------
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert with check (id = auth.uid());

-- businesses ----------------------------------------------------------------
drop policy if exists businesses_owner_all on public.businesses;
create policy businesses_owner_all on public.businesses
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

-- onboarding_progress -------------------------------------------------------
drop policy if exists onboarding_owner_all on public.onboarding_progress;
create policy onboarding_owner_all on public.onboarding_progress
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- subscriptions — read-only for owners; plan changes go through payments -----
drop policy if exists subscriptions_select_self on public.subscriptions;
create policy subscriptions_select_self on public.subscriptions
  for select using (user_id = auth.uid() or public.is_admin());

-- projects ------------------------------------------------------------------
drop policy if exists projects_owner_all on public.projects;
create policy projects_owner_all on public.projects
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

-- A published project must be readable by anonymous visitors for /site/.
drop policy if exists projects_public_read on public.projects;
create policy projects_public_read on public.projects
  for select to anon using (status = 'published' and slug is not null);

-- project_versions ----------------------------------------------------------
drop policy if exists project_versions_owner_all on public.project_versions;
create policy project_versions_owner_all on public.project_versions
  for all using (
    exists (select 1 from public.projects p where p.id = project_id and (p.owner_id = auth.uid() or public.is_admin()))
  )
  with check (
    exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid())
  );

drop policy if exists project_versions_public_read on public.project_versions;
create policy project_versions_public_read on public.project_versions
  for select to anon using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and p.status = 'published' and p.published_version_id = project_versions.id
    )
  );

-- ai_conversations / ai_messages -------------------------------------------
drop policy if exists ai_conversations_owner_all on public.ai_conversations;
create policy ai_conversations_owner_all on public.ai_conversations
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid());

drop policy if exists ai_messages_owner_all on public.ai_messages;
create policy ai_messages_owner_all on public.ai_messages
  for all using (
    exists (select 1 from public.ai_conversations c where c.id = conversation_id and (c.user_id = auth.uid() or public.is_admin()))
  )
  with check (
    exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = auth.uid())
  );

-- domains / domain_orders ---------------------------------------------------
drop policy if exists domains_owner_select on public.domains;
create policy domains_owner_select on public.domains
  for select using (owner_id = auth.uid() or public.is_admin());

drop policy if exists domains_owner_write on public.domains;
create policy domains_owner_write on public.domains
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists domain_orders_owner_select on public.domain_orders;
create policy domain_orders_owner_select on public.domain_orders
  for select using (owner_id = auth.uid() or public.is_admin());

-- payments — owners may read their records. Writes are service-role only, so
-- the browser has no path to create or confirm a payment.
drop policy if exists payments_owner_select on public.payments;
create policy payments_owner_select on public.payments
  for select using (owner_id = auth.uid() or public.is_admin());

-- notifications -------------------------------------------------------------
drop policy if exists notifications_owner_select on public.notifications;
create policy notifications_owner_select on public.notifications
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists notifications_owner_update on public.notifications;
create policy notifications_owner_update on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- announcements -------------------------------------------------------------
drop policy if exists announcements_read on public.admin_announcements;
create policy announcements_read on public.admin_announcements
  for select using (expires_at is null or expires_at > now() or public.is_admin());

-- support -------------------------------------------------------------------
drop policy if exists support_tickets_owner_all on public.support_tickets;
create policy support_tickets_owner_all on public.support_tickets
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists support_replies_owner_all on public.support_replies;
create policy support_replies_owner_all on public.support_replies
  for all using (
    exists (select 1 from public.support_tickets t where t.id = ticket_id and (t.owner_id = auth.uid() or public.is_admin()))
  )
  with check (
    exists (select 1 from public.support_tickets t where t.id = ticket_id and (t.owner_id = auth.uid() or public.is_admin()))
  );

-- service_requests ----------------------------------------------------------
drop policy if exists service_requests_owner_all on public.service_requests;
create policy service_requests_owner_all on public.service_requests
  for select using (owner_id = auth.uid() or public.is_admin());

drop policy if exists service_requests_owner_insert on public.service_requests;
create policy service_requests_owner_insert on public.service_requests
  for insert with check (owner_id = auth.uid() and status = 'requested');

-- customer_activity ---------------------------------------------------------
drop policy if exists activity_owner_select on public.customer_activity;
create policy activity_owner_select on public.customer_activity
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists activity_owner_insert on public.customer_activity;
create policy activity_owner_insert on public.customer_activity
  for insert with check (user_id = auth.uid());

-- store_* -------------------------------------------------------------------
drop policy if exists store_products_owner_all on public.store_products;
create policy store_products_owner_all on public.store_products
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists store_customers_owner_all on public.store_customers;
create policy store_customers_owner_all on public.store_customers
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists store_orders_owner_all on public.store_orders;
create policy store_orders_owner_all on public.store_orders
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists store_order_items_owner_all on public.store_order_items;
create policy store_order_items_owner_all on public.store_order_items
  for all using (
    exists (select 1 from public.store_orders o where o.id = order_id and (o.owner_id = auth.uid() or public.is_admin()))
  )
  with check (
    exists (select 1 from public.store_orders o where o.id = order_id and o.owner_id = auth.uid())
  );

-- campaigns -----------------------------------------------------------------
drop policy if exists campaigns_owner_all on public.campaigns;
create policy campaigns_owner_all on public.campaigns
  for all using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

-- integrations / deployments ------------------------------------------------
drop policy if exists integrations_owner_select on public.integrations;
create policy integrations_owner_select on public.integrations
  for select using (owner_id = auth.uid() or public.is_admin());

drop policy if exists deployments_owner_select on public.deployments;
create policy deployments_owner_select on public.deployments
  for select using (owner_id = auth.uid() or public.is_admin());

-- admin_users — read your own row only; writes are service-role only --------
drop policy if exists admin_users_self on public.admin_users;
create policy admin_users_self on public.admin_users
  for select using (user_id = auth.uid() or public.is_admin());

-- contact_messages — anonymous visitors may submit, only admins read --------
drop policy if exists contact_insert_any on public.contact_messages;
create policy contact_insert_any on public.contact_messages
  for insert to anon, authenticated with check (true);

drop policy if exists contact_admin_read on public.contact_messages;
create policy contact_admin_read on public.contact_messages
  for select using (public.is_admin());

-- ai_usage_log — owners may see their own usage; writes service-role only ---
drop policy if exists ai_usage_owner_select on public.ai_usage_log;
create policy ai_usage_owner_select on public.ai_usage_log
  for select using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- Profiles: keep email in sync when auth updates it
-- ---------------------------------------------------------------------------
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set email = new.email,
         last_sign_in_at = new.last_sign_in_at
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email, last_sign_in_at on auth.users
  for each row execute function public.sync_profile_email();
