-- ============================================================================
-- 0079 — Business stage (onboarding, badge, personalisation)
--
-- The stage lives on public.businesses.stage (0001). Until now it held four
-- free-text onboarding choices. This migration maps them, once, onto the four
-- canonical stages and refuses anything else:
--   idea     -> ideation
--   starting -> mvp
--   operating -> scaling
--   growing  -> established
-- Nothing is deleted. A row with no stage stays null: existing members are
-- never forced back through onboarding; the app only invites them to set it.
--
-- business_set_stage() is the only browser write path for the stage. It checks
-- the value and that the caller owns the business, so the check is in the
-- database and does not depend on the page.
-- ============================================================================

update public.businesses
   set stage = case stage
                 when 'idea' then 'ideation'
                 when 'starting' then 'mvp'
                 when 'operating' then 'scaling'
                 when 'growing' then 'established'
               end
 where stage in ('idea', 'starting', 'operating', 'growing');

alter table public.businesses drop constraint if exists businesses_stage_known;
alter table public.businesses
  add constraint businesses_stage_known
  check (stage is null or stage in ('ideation', 'mvp', 'scaling', 'established'));

create or replace function public.business_set_stage(p_business uuid, p_stage text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_stage text := lower(btrim(coalesce(p_stage, '')));
  v_row public.businesses%rowtype;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  if v_stage not in ('ideation', 'mvp', 'scaling', 'established') then
    raise exception 'Choose one of the four stages.' using errcode = '22023';
  end if;

  select * into v_row from public.businesses where id = p_business;
  if not found or v_row.owner_id <> actor then
    raise exception 'That business is not yours.' using errcode = '42501';
  end if;

  update public.businesses
     set stage = v_stage, updated_at = now()
   where id = p_business
   returning * into v_row;

  return jsonb_build_object('ok', true, 'businessId', v_row.id, 'stage', v_row.stage);
end;
$$;

revoke all on function public.business_set_stage(uuid, text) from public, anon;
grant execute on function public.business_set_stage(uuid, text) to authenticated;
