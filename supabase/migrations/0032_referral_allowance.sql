-- 0032 — a referral bonus is part of the monthly allowance
--
-- `referral_grant_one()` credits the allowance by hand: it adds
-- `bonus_credits` to `ai_credits_limit`. That works on the day of the referral
-- and then quietly stops working, because three separate writers rebuild the
-- limit from the plan's base allowance and drop whatever was added to it:
--
--   * admin_update_subscription() (0009) on a plan change,
--   * admin/index.ts → subscriptionUpdate(),
--   * admin/index.ts → applyPaymentEffect() after an approved plan payment.
--
-- So a customer who earned ten extra generations a month lost them the next
-- time they upgraded, which is worse than never promising them. The limit is
-- now derived in one place — base allowance for the plan plus the bonus the
-- account has earned — so it does not matter which writer runs or how often.
--
-- Idempotent by construction: the value is computed, never incremented.

create or replace function public.subscriptions_allowance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base int;
begin
  -- The same numbers as PLAN_LIMITS in the Edge Functions and the `limits`
  -- jsonb in admin_update_subscription(). Kept together here so a bonus never
  -- has to be re-applied after somebody changes their mind about a plan.
  base := case coalesce(new.plan, 'free')
    when 'pro' then 800
    when 'enterprise' then 6000
    else 30
  end;

  new.ai_credits_limit := base + greatest(coalesce(new.bonus_credits, 0), 0);

  -- A bonus can never make the used counter look larger than the allowance.
  if new.ai_credits_used is null or new.ai_credits_used < 0 then
    new.ai_credits_used := 0;
  end if;

  return new;
end $$;

drop trigger if exists subscriptions_allowance on public.subscriptions;
create trigger subscriptions_allowance
  before insert or update on public.subscriptions
  for each row execute function public.subscriptions_allowance();

-- Functions are not directly callable; only the trigger needs it.
revoke all on function public.subscriptions_allowance() from public, anon, authenticated;

-- Recompute every existing row once. Safe to re-run: the trigger is idempotent
-- and this statement only touches what is already there.
update public.subscriptions
   set bonus_credits = coalesce(bonus_credits, 0),
       updated_at = updated_at
 where bonus_credits is null
    or ai_credits_limit is distinct from
       (case coalesce(plan, 'free')
          when 'pro' then 800
          when 'enterprise' then 6000
          else 30
        end) + greatest(coalesce(bonus_credits, 0), 0);

-- The client asks for this in one read; expose it the same way it exposes the
-- rest of the allowance instead of making the browser recompute it.
create or replace function public.ai_allowance()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  actor uuid := auth.uid();
  row_sub public.subscriptions;
  period_start timestamptz := date_trunc('month', now());
begin
  if actor is null then
    raise exception 'Sign in to check your AI allowance.' using errcode = '42501';
  end if;

  select * into row_sub from public.subscriptions where user_id = actor;

  if row_sub.user_id is null then
    return jsonb_build_object(
      'plan', 'free', 'used', 0, 'limit', 30, 'remaining', 30,
      'bonus', 0, 'bonusCredits', 0
    );
  end if;

  if row_sub.ai_period_start is null or row_sub.ai_period_start < period_start then
    return jsonb_build_object(
      'plan', row_sub.plan,
      'used', 0,
      'limit', row_sub.ai_credits_limit,
      'remaining', row_sub.ai_credits_limit,
      'bonus', coalesce(row_sub.bonus_credits, 0),
      'bonusCredits', coalesce(row_sub.bonus_credits, 0),
      'period_start', period_start
    );
  end if;

  return jsonb_build_object(
    'plan', row_sub.plan,
    'used', row_sub.ai_credits_used,
    'limit', row_sub.ai_credits_limit,
    'remaining', greatest(row_sub.ai_credits_limit - row_sub.ai_credits_used, 0),
    'bonus', coalesce(row_sub.bonus_credits, 0),
    'bonusCredits', coalesce(row_sub.bonus_credits, 0),
    'period_start', period_start
  );
end $$;

revoke all on function public.ai_allowance() from public, anon;
grant execute on function public.ai_allowance() to authenticated;
