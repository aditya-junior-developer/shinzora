-- ============================================================================
-- SHINZORA · 0009_admin_authority_and_audit.sql
-- ----------------------------------------------------------------------------
-- Phase 3 — administrator authority, an audit spine, and archival instead of
-- destruction.
--
-- What this migration is for:
--
--   • an administrator can finally see the whole user directory, not just their
--     own row (the old `admin_users` policy allowed "select your own row" only)
--   • promote / demote is a database function with escalation guards, not a
--     frontend flag: only a super administrator may call it, the protected
--     owner can never be demoted, and the platform can never be left with zero
--     super administrators
--   • every privileged change writes a row to `admin_audit` — who, what, when,
--     why, and the before/after state
--   • payments are archived, never silently destroyed; a verified payment is
--     voided with a reason and kept, and only a row that never reached a money
--     state may be hard-deleted, with a full snapshot in the audit trail
--   • subscriptions, AI-credit resets and stock changes each keep a history
--
-- Deletion rules enforced here (agreed with the owner, 7 Nov 2026):
--   verified                      → void (soft) only. Never hard-deleted.
--   awaiting_verification         → void (soft) only: the customer says they paid,
--                                   so the money question must stay answerable.
--   pending / rejected / cancelled→ soft by default; hard delete permitted, and
--                                   the deleted row is copied into admin_audit first.
--
-- Safe to re-run: every object is created only if missing, functions are
-- replaced, and policies are dropped before creation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. admin_users: provenance, protection, timestamps
--    This comes first: is_protected_owner() below is a `language sql` function
--    and is parsed when it is created, so the column must already exist.
-- ---------------------------------------------------------------------------
alter table public.admin_users add column if not exists granted_by uuid;
alter table public.admin_users add column if not exists granted_at timestamptz;
alter table public.admin_users add column if not exists updated_at timestamptz not null default now();
alter table public.admin_users add column if not exists note text;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'admin_users' and column_name = 'protected'
  ) then
    alter table public.admin_users add column protected boolean not null default false;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Role helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_superadmin(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = p_user and a.role = 'superadmin'
  );
$$;

create or replace function public.superadmin_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.admin_users where role = 'superadmin';
$$;

create or replace function public.is_protected_owner(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select a.protected from public.admin_users a where a.user_id = p_user),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. admin_users: provenance and protection
-- ---------------------------------------------------------------------------
/* The founding account is the recovery path: it cannot be demoted, revoked or
   edited by anyone, including another super administrator. Exactly one row is
   protected, and only this migration decides which — no function can set it. */
do $$
declare
  existing uuid;
begin
  select user_id into existing from public.admin_users where protected limit 1;

  if existing is null then
    update public.admin_users
       set protected = true
     where user_id = (
       select user_id from public.admin_users
       where role = 'superadmin'
       order by created_at asc, user_id asc
       limit 1
     );
  end if;
end
$$;

/* Administrators may now read the whole table; previously the only policy was
   "select your own row", which is why the console showed exactly one person. */
drop policy if exists admin_users_admin_read on public.admin_users;
create policy admin_users_admin_read on public.admin_users
  for select to authenticated
  using (public.is_admin());

-- No insert / update / delete policy exists for any client role. The only write
-- path is public.set_admin_role(), which re-checks the caller.

-- ---------------------------------------------------------------------------
-- 3. The audit spine
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  actor_email text,
  actor_role text,
  action text not null,
  target_table text,
  target_id uuid,
  reason text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
create index if not exists admin_audit_target_idx on public.admin_audit (target_table, target_id);

alter table public.admin_audit enable row level security;

/* No policy for any client role: the trail is written by SECURITY DEFINER
   functions and the service role, and read through admin_audit_log(). An
   administrator cannot edit or delete what they did. */

/* Internal writer. Not granted to any client role. */
create or replace function public.write_admin_audit(
  p_action text,
  p_target_table text,
  p_target_id uuid,
  p_reason text,
  p_before jsonb,
  p_after jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  entry uuid;
begin
  insert into public.admin_audit (
    actor_id, actor_email, actor_role, action, target_table, target_id, reason, before, after
  )
  values (
    actor,
    (select email from public.admin_users where user_id = actor limit 1),
    (select role from public.admin_users where user_id = actor limit 1),
    p_action, p_target_table, p_target_id, p_reason, p_before, p_after
  )
  returning id into entry;

  return entry;
end;
$$;

revoke all on function public.write_admin_audit(text, text, uuid, text, jsonb, jsonb) from public;
grant execute on function public.write_admin_audit(text, text, uuid, text, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Directory + administrator list
-- ---------------------------------------------------------------------------
create or replace function public.admin_directory()
returns table (
  user_id uuid,
  email text,
  full_name text,
  phone text,
  role text,
  plan text,
  plan_status text,
  ai_credits_used int,
  ai_credits_limit int,
  projects int,
  joined_at timestamptz,
  protected boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  return query
    select
      p.id,
      coalesce(p.email, u.email),
      p.full_name,
      p.phone,
      coalesce(a.role, 'user')::text,
      coalesce(s.plan, 'free')::text,
      coalesce(s.status, 'active')::text,
      coalesce(s.ai_credits_used, 0),
      coalesce(s.ai_credits_limit, 30),
      (select count(*)::int from public.projects pr where pr.owner_id = p.id),
      p.created_at,
      coalesce(a.protected, false)
    from public.profiles p
    left join auth.users u on u.id = p.id
    left join public.admin_users a on a.user_id = p.id
    left join public.subscriptions s on s.user_id = p.id
    order by
      case coalesce(a.role, 'user') when 'superadmin' then 0 when 'admin' then 1 else 2 end,
      p.created_at asc;
end;
$$;

create or replace function public.admin_audit_log(p_limit int default 100)
returns setof public.admin_audit
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  return query
    select * from public.admin_audit
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Promote / demote — the only write path to admin_users
-- ---------------------------------------------------------------------------
create or replace function public.set_admin_role(
  p_user uuid,
  p_role text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  wanted text := lower(coalesce(p_role, ''));
  previous text;
  previous_protected boolean := false;
  remaining int;
  before_row jsonb;
  after_row jsonb;
begin
  if actor is null then
    raise exception 'Sign in to continue.' using errcode = '42501';
  end if;

  -- Escalation guard: an ordinary administrator cannot grant anything at all,
  -- and nobody can grant a role they do not hold through this function.
  if not public.is_superadmin(actor) then
    raise exception 'Only a super administrator can change administrator roles.'
      using errcode = '42501';
  end if;

  if wanted not in ('admin', 'superadmin', 'none') then
    raise exception 'Role must be admin, superadmin or none.' using errcode = '22023';
  end if;

  if p_user is null then
    raise exception 'A user id is required.' using errcode = '22023';
  end if;

  select role, protected into previous, previous_protected
    from public.admin_users where user_id = p_user;

  if previous is null and wanted = 'none' then
    raise exception 'That account is not an administrator.' using errcode = 'P0002';
  end if;

  select to_jsonb(a) into before_row from public.admin_users a where a.user_id = p_user;

  -- The recovery path is untouchable, by anyone, in any direction.
  if previous_protected and wanted <> 'superadmin' then
    raise exception 'The protected owner account cannot be demoted or revoked.'
      using errcode = '42501';
  end if;

  -- The platform must never be left without a super administrator.
  if previous = 'superadmin' and wanted <> 'superadmin' then
    select count(*)::int into remaining from public.admin_users where role = 'superadmin' and user_id <> p_user;
    if remaining < 1 then
      raise exception 'This is the last super administrator. Promote another account first.'
        using errcode = '42501';
    end if;
  end if;

  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'No account exists for that user id.' using errcode = 'P0002';
  end if;

  if wanted = 'none' then
    delete from public.admin_users where user_id = p_user;
    update public.profiles set role = 'owner', updated_at = now() where id = p_user;
  else
    insert into public.admin_users as a (user_id, email, role, granted_by, granted_at, updated_at)
    values (
      p_user,
      (select coalesce(email, '') from public.profiles where id = p_user),
      wanted, actor, now(), now()
    )
    on conflict (user_id) do update
      set role = excluded.role,
          email = excluded.email,
          updated_at = now()
      where a.protected = false;

    /* Belt and braces: the WHERE above silently does nothing on a protected
       row, so confirm the change actually landed rather than reporting success
       on an update that matched nothing. */
    if not exists (select 1 from public.admin_users where user_id = p_user and role = wanted) then
      raise exception 'The protected owner account cannot be demoted or revoked.'
        using errcode = '42501';
    end if;

    update public.profiles set role = 'admin', updated_at = now() where id = p_user;
  end if;

  select to_jsonb(a) into after_row from public.admin_users a where a.user_id = p_user;

  perform public.write_admin_audit(
    case when wanted = 'none' then 'admin.revoke' else 'admin.set_role' end,
    'admin_users', p_user, p_reason, before_row, after_row
  );

  insert into public.customer_activity (user_id, action, entity_type, entity_id, meta)
  values (p_user, 'admin.role_changed', 'admin_users', p_user::text,
          jsonb_build_object('from', previous, 'to', wanted, 'actor', actor));

  return jsonb_build_object(
    'user_id', p_user,
    'previous', previous,
    'role', wanted,
    'ok', true
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Subscription changes and AI-credit resets
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  from_plan text,
  to_plan text,
  from_status text,
  to_status text,
  credits_reset boolean not null default false,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists subscription_events_user_idx on public.subscription_events (user_id, created_at desc);

alter table public.subscription_events enable row level security;

drop policy if exists subscription_events_owner_read on public.subscription_events;
create policy subscription_events_owner_read on public.subscription_events
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Writes happen inside the guarded functions below.

create or replace function public.admin_update_subscription(
  p_user uuid,
  p_plan text default null,
  p_status text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  next_plan text := nullif(lower(coalesce(p_plan, '')), '');
  next_status text := nullif(lower(coalesce(p_status, '')), '');
  before_row jsonb;
  current_plan text;
  current_status text;
  limits jsonb := jsonb_build_object('free', 30, 'pro', 800, 'enterprise', 6000);
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  if next_plan is null and next_status is null then
    raise exception 'Nothing to change: supply a plan or a status.' using errcode = '22023';
  end if;

  if next_plan is not null and next_plan not in ('free', 'pro', 'enterprise') then
    raise exception 'Plan must be free, pro or enterprise.' using errcode = '22023';
  end if;

  if next_status is not null and next_status not in ('active', 'past_due', 'cancelled', 'trialing') then
    raise exception 'Status must be active, past_due, cancelled or trialing.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.subscriptions where user_id = p_user) then
    insert into public.subscriptions (user_id, plan, status, ai_credits_limit)
    values (p_user, coalesce(next_plan, 'free'), coalesce(next_status, 'active'),
            coalesce((limits ->> coalesce(next_plan, 'free'))::int, 30));
  end if;

  select to_jsonb(s), s.plan, s.status into before_row, current_plan, current_status
    from public.subscriptions s where s.user_id = p_user;

  update public.subscriptions
     set plan = coalesce(next_plan, plan),
         status = coalesce(next_status, status),
         ai_credits_limit = case
           when next_plan is null then ai_credits_limit
           else coalesce((limits ->> next_plan)::int, ai_credits_limit)
         end,
         ai_credits_used = case
           when next_plan is null or next_plan = current_plan then ai_credits_used
           else 0
         end,
         ai_period_start = case
           when next_plan is null or next_plan = current_plan then ai_period_start
           else date_trunc('month', now())
         end,
         updated_at = now()
   where user_id = p_user;

  insert into public.subscription_events (
    user_id, actor_id, action, from_plan, to_plan, from_status, to_status, reason
  )
  values (
    p_user, actor,
    case when next_plan is not null and next_plan <> current_plan then 'plan_changed' else 'status_changed' end,
    current_plan, coalesce(next_plan, current_plan),
    current_status, coalesce(next_status, current_status),
    p_reason
  );

  perform public.write_admin_audit(
    'subscription.update', 'subscriptions',
    (select id from public.subscriptions where user_id = p_user),
    p_reason, before_row,
    (select to_jsonb(s) from public.subscriptions s where s.user_id = p_user)
  );

  insert into public.customer_activity (user_id, action, entity_type, entity_id, meta)
  values (p_user, 'subscription.changed', 'subscriptions', p_user::text,
          jsonb_build_object('plan', coalesce(next_plan, current_plan),
                             'status', coalesce(next_status, current_status),
                             'actor', actor));

  return jsonb_build_object('ok', true, 'plan', coalesce(next_plan, current_plan),
                            'status', coalesce(next_status, current_status));
end;
$$;

create or replace function public.admin_reset_ai_credits(
  p_user uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  before_row jsonb;
  used int;
begin
  -- The owner restricted this action to super administrators, and asked for it
  -- to appear in the audit trail.
  if not public.is_superadmin() then
    raise exception 'Only a super administrator can reset AI credits.' using errcode = '42501';
  end if;

  select to_jsonb(s), s.ai_credits_used into before_row, used
    from public.subscriptions s where s.user_id = p_user;

  if before_row is null then
    raise exception 'That customer has no subscription row.' using errcode = 'P0002';
  end if;

  update public.subscriptions
     set ai_credits_used = 0,
         ai_period_start = date_trunc('month', now()),
         updated_at = now()
   where user_id = p_user;

  insert into public.subscription_events (
    user_id, actor_id, action, from_plan, to_plan, from_status, to_status, credits_reset, reason
  )
  values (
    p_user, actor, 'credits_reset',
    (select plan from public.subscriptions where user_id = p_user),
    (select plan from public.subscriptions where user_id = p_user),
    (select status from public.subscriptions where user_id = p_user),
    (select status from public.subscriptions where user_id = p_user),
    true, p_reason
  );

  perform public.write_admin_audit(
    'subscription.reset_credits', 'subscriptions',
    (select id from public.subscriptions where user_id = p_user),
    p_reason, before_row,
    (select to_jsonb(s) from public.subscriptions s where s.user_id = p_user)
  );

  return jsonb_build_object('ok', true, 'credits_used_before', coalesce(used, 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Payments: archive, void, or (only for rows that never held money) delete
-- ---------------------------------------------------------------------------
alter table public.payments add column if not exists deleted_at timestamptz;
alter table public.payments add column if not exists deleted_by uuid;
alter table public.payments add column if not exists deletion_reason text;
alter table public.payments add column if not exists voided_at timestamptz;
alter table public.payments add column if not exists void_reason text;

/* Archived payments disappear from every client read — including the customer's
   own billing history — because the policy excludes them, not because a view
   remembered to filter. */
drop policy if exists payments_owner_select on public.payments;
create policy payments_owner_select on public.payments
  for select to authenticated
  using ((owner_id = auth.uid() or public.is_admin()) and deleted_at is null);

create or replace function public.admin_delete_payment(
  p_payment uuid,
  p_reason text,
  p_hard boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  row_before jsonb;
  state text;
  removal text;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  if length(coalesce(p_reason, '')) < 3 then
    raise exception 'A reason is required to remove a payment record.' using errcode = '22023';
  end if;

  select to_jsonb(p), p.status into row_before, state
    from public.payments p where p.id = p_payment;

  if row_before is null then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;

  /* The agreed rules, in order of strictness:
       verified or awaiting_verification → void only (money is involved, or the
                                           customer says it is)
       anything else                     → void by default, hard delete on request
     A hard delete copies the full row into admin_audit first. */
  if state in ('verified', 'awaiting_verification', 'refunded') then
    removal := 'voided';
  elsif p_hard then
    removal := 'deleted';
  else
    removal := 'voided';
  end if;

  if removal = 'deleted' then
    perform public.write_admin_audit(
      'payment.hard_delete', 'payments', p_payment, p_reason, row_before, null
    );
    delete from public.payments where id = p_payment;
  else
    update public.payments
       set deleted_at = now(),
           deleted_by = actor,
           deletion_reason = p_reason,
           voided_at = case when state = 'verified' then now() else voided_at end,
           void_reason = case when state = 'verified' then p_reason else void_reason end,
           updated_at = now()
     where id = p_payment;

    perform public.write_admin_audit(
      case when state = 'verified' then 'payment.void' else 'payment.archive' end,
      'payments', p_payment, p_reason, row_before,
      (select to_jsonb(p) from public.payments p where p.id = p_payment)
    );
  end if;

  return jsonb_build_object('ok', true, 'removal', removal, 'status', state);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Stock movements — recorded by the database, not by the form
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.store_products(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  before_stock int,
  after_stock int,
  delta int not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists inventory_movements_product_idx on public.inventory_movements (product_id, created_at desc);

alter table public.inventory_movements enable row level security;

drop policy if exists inventory_movements_owner_read on public.inventory_movements;
create policy inventory_movements_owner_read on public.inventory_movements
  for select to authenticated
  using (owner_id = auth.uid() or public.is_admin());

create or replace function public.record_stock_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.stock, 0) is distinct from coalesce(old.stock, 0) then
    insert into public.inventory_movements (
      product_id, owner_id, actor_id, before_stock, after_stock, delta, reason
    )
    values (
      new.id, new.owner_id, auth.uid(), old.stock, new.stock,
      coalesce(new.stock, 0) - coalesce(old.stock, 0),
      case when auth.uid() is null then 'system' else 'manual' end
    );
  end if;
  return new;
end;
$$;

drop trigger if exists store_products_stock_history on public.store_products;
create trigger store_products_stock_history
  after update on public.store_products
  for each row execute function public.record_stock_change();

-- ---------------------------------------------------------------------------
-- 9. Archive instead of destroy: tickets, contacts, announcements, activity
-- ---------------------------------------------------------------------------
alter table public.support_tickets add column if not exists archived_at timestamptz;
alter table public.contact_messages add column if not exists archived_at timestamptz;
alter table public.admin_announcements add column if not exists deleted_at timestamptz;
alter table public.customer_activity add column if not exists deleted_at timestamptz;

/* The original policy was `for all`, which cannot carry a different filter for
   reads than for writes. It is replaced by three specific policies so an
   archived ticket disappears from every list without blocking the customer
   from opening a new one or replying to an active thread. */
drop policy if exists support_tickets_owner_all on public.support_tickets;
drop policy if exists support_tickets_owner_select on public.support_tickets;
drop policy if exists support_tickets_owner_insert on public.support_tickets;
drop policy if exists support_tickets_owner_update on public.support_tickets;

create policy support_tickets_owner_select on public.support_tickets
  for select to authenticated
  using ((owner_id = auth.uid() or public.is_admin()) and archived_at is null);

create policy support_tickets_owner_insert on public.support_tickets
  for insert to authenticated
  with check (owner_id = auth.uid() or public.is_admin());

create policy support_tickets_owner_update on public.support_tickets
  for update to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists support_tickets_owner_delete on public.support_tickets;
create policy support_tickets_owner_delete on public.support_tickets
  for delete to authenticated
  using (public.is_admin());

/* Announcements keep their expiry rule and lose their deleted ones. */
drop policy if exists announcements_read on public.admin_announcements;
create policy announcements_read on public.admin_announcements
  for select using (
    deleted_at is null and (expires_at is null or expires_at > now() or public.is_admin())
  );

/* The customer's own activity feed hides records an administrator removed. */
drop policy if exists activity_owner_select on public.customer_activity;
create policy activity_owner_select on public.customer_activity
  for select using ((user_id = auth.uid() or public.is_admin()) and deleted_at is null);

create or replace function public.admin_archive_record(
  p_table text,
  p_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  before_row jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required.' using errcode = '42501';
  end if;

  if p_table not in ('support_tickets', 'contact_messages', 'admin_announcements', 'customer_activity') then
    raise exception 'That table cannot be archived.' using errcode = '22023';
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table)
    into before_row using p_id;

  if before_row is null then
    raise exception 'Record not found.' using errcode = 'P0002';
  end if;

  if p_table = 'admin_announcements' or p_table = 'customer_activity' then
    execute format('update public.%I set deleted_at = now() where id = $1', p_table) using p_id;
  else
    execute format('update public.%I set archived_at = now() where id = $1', p_table) using p_id;
  end if;

  perform public.write_admin_audit(
    'record.archive', p_table, p_id, p_reason, before_row, null
  );

  return jsonb_build_object('ok', true, 'table', p_table, 'id', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Grants — guarded functions only, never anon
-- ---------------------------------------------------------------------------
revoke all on function public.admin_directory() from public;
revoke all on function public.admin_audit_log(int) from public;
revoke all on function public.set_admin_role(uuid, text, text) from public;
revoke all on function public.admin_update_subscription(uuid, text, text, text) from public;
revoke all on function public.admin_reset_ai_credits(uuid, text) from public;
revoke all on function public.admin_delete_payment(uuid, text, boolean) from public;
revoke all on function public.admin_archive_record(text, uuid, text) from public;

grant execute on function public.admin_directory() to authenticated, service_role;
grant execute on function public.admin_audit_log(int) to authenticated, service_role;
grant execute on function public.set_admin_role(uuid, text, text) to authenticated, service_role;
grant execute on function public.admin_update_subscription(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.admin_reset_ai_credits(uuid, text) to authenticated, service_role;
grant execute on function public.admin_delete_payment(uuid, text, boolean) to authenticated, service_role;
grant execute on function public.admin_archive_record(text, uuid, text) to authenticated, service_role;

grant execute on function public.is_superadmin(uuid) to authenticated, service_role;
grant execute on function public.superadmin_count() to authenticated, service_role;
grant execute on function public.is_protected_owner(uuid) to authenticated, service_role;

-- The audit and history tables are read through functions; no direct write.
revoke insert, update, delete on public.admin_audit from anon, authenticated;
revoke insert, update, delete on public.subscription_events from anon, authenticated;
revoke insert, update, delete on public.inventory_movements from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. Record what this migration decided
-- ---------------------------------------------------------------------------
do $$
declare
  owner_email text;
  admins int;
  protected_count int;
begin
  select email into owner_email from public.admin_users where protected limit 1;
  select count(*) into admins from public.admin_users;
  select count(*) into protected_count from public.admin_users where protected;

  if admins > 0 and protected_count <> 1 then
    raise exception 'Expected exactly one protected owner, found %.', protected_count;
  end if;

  if to_regclass('public.migration_notes') is not null
     and not exists (
       select 1 from public.migration_notes
       where migration = '0009_admin_authority_and_audit'
     ) then
    insert into public.migration_notes (migration, entity, action, detail)
    values (
      '0009_admin_authority_and_audit',
      'admin_users',
      'authority_and_audit_installed',
      jsonb_build_object(
        'protected_owner', owner_email,
        'admin_rows', admins,
        'roles', (select jsonb_object_agg(role, n) from (
          select role, count(*)::int as n from public.admin_users group by role
        ) s)
      )
    );
  end if;

  raise notice '0009 applied. administrator rows: %, protected owner: %', admins, coalesce(owner_email, 'none');
end
$$;
