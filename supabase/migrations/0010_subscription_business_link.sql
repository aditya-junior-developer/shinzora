-- ============================================================================
-- SHINZORA · 0010_subscription_business_link.sql
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- Finish Setup failed for every customer with:
--   "You do not have access to this resource. Row Level Security blocked the
--    request."
--
-- Two separate faults, both confirmed by reading the shipped SQL:
--
--   1. public.subscriptions has a SELECT policy only — deliberately, because a
--      plan change must go through payments and an administrator. But the
--      onboarding client called
--        sb.from("subscriptions").upsert({ user_id, plan: 'free', ... })
--      On signup the `on_auth_user_created` trigger has ALREADY created that
--      row, so the upsert became an UPDATE, which no policy permits. PostgREST
--      returned 403 → the generic RLS banner → no redirect, because the throw
--      happened before location.replace().
--
--   2. The paid-plan branch inserted a service request with status 'pending',
--      which the table CHECK does not allow (valid: requested, approved,
--      in_progress, completed, rejected, cancelled) and which the insert policy
--      also forbids. That path failed for every non-free plan.
--
-- WHAT THIS DOES
--
--   • Exposes the ONE field onboarding legitimately owns — which business the
--     customer's subscription points at — as a narrow, audited function.
--     It cannot change plan, status, credits or another user's row: the update
--     is restricted to `user_id = auth.uid()` and the business must be owned by
--     the caller. RLS is left exactly as it was; no policy is loosened.
--   • Recorded here so the reasoning survives: the free-plan row is created by
--     the signup trigger, never by the browser.
--
-- The client-side half of the fix (using this function, and the correct
-- service-request status) is in public/js/boot/onboarding.js.
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- attach_business_to_subscription(business)
--   Links the caller's own subscription to one of the caller's own businesses.
--   Creates the free row if the signup trigger has not (older accounts), and
--   never touches plan, status or credits.
-- ---------------------------------------------------------------------------
create or replace function public.attach_business_to_subscription(p_business uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  owned boolean := false;
  row_out public.subscriptions;
begin
  if caller is null then
    raise exception 'A signed-in account is required.' using errcode = '42501';
  end if;

  /* A business may only be linked by its owner. This is the boundary that makes
     the function safe to expose: without it, any signed-in caller could point
     their subscription at somebody else's business id. */
  if p_business is not null then
    select exists (
      select 1 from public.businesses b where b.id = p_business and b.owner_id = caller
    ) into owned;

    if not owned then
      raise exception 'That business does not belong to this account.' using errcode = '42501';
    end if;
  end if;

  update public.subscriptions s
     set business_id = p_business,
         updated_at = now()
   where s.user_id = caller
  returning * into row_out;

  if row_out.user_id is null then
    /* Older account with no row (the trigger was added later than the user). */
    insert into public.subscriptions (user_id, plan, status, business_id, ai_credits_limit)
    values (caller, 'free', 'active', p_business, 30)
    returning * into row_out;
  end if;

  return jsonb_build_object(
    'ok', true,
    'plan', row_out.plan,
    'status', row_out.status,
    'business_id', row_out.business_id,
    'ai_credits_used', row_out.ai_credits_used,
    'ai_credits_limit', row_out.ai_credits_limit
  );
end;
$$;

revoke all on function public.attach_business_to_subscription(uuid) from public, anon;
grant execute on function public.attach_business_to_subscription(uuid) to authenticated;

comment on function public.attach_business_to_subscription(uuid) is
  'Links the caller''s subscription row to one of the caller''s businesses. Cannot change plan, status or credits.';

-- ---------------------------------------------------------------------------
-- Make the intent of the subscriptions policies explicit in the catalogue, so
-- a future reader does not "fix" the missing write policy by adding one.
-- ---------------------------------------------------------------------------
comment on table public.subscriptions is
  'Plan, status and AI credits. Written by the signup trigger, payments verification and administrators only — never by the browser. Onboarding links a business through attach_business_to_subscription().';

-- ---------------------------------------------------------------------------
-- Service requests: the table's CHECK is the contract the client must satisfy.
-- Kept here as the single documented list of valid starting states.
-- ---------------------------------------------------------------------------
comment on column public.service_requests.status is
  'requested → approved → in_progress → completed (or rejected / cancelled). A customer insert must start at ''requested''.';
