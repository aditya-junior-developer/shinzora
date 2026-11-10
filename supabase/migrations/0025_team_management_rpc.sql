-- 0025 — team management
--
-- Three gaps left over from 0018:
--   * nothing could *list* members, so an owner had no team roster
--   * `team_revoke_member` only cancelled pending invitations; an accepted
--     member could never be removed
--   * pending invitations were invisible to the owner after they were created

create or replace function public.team_members_list(p_business uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  result jsonb;
  owner uuid;
begin
  if actor is null then raise exception 'Sign in to view the team.' using errcode='42501'; end if;
  select owner_id into owner from public.businesses where id = p_business;
  if owner is null then raise exception 'That business does not exist.' using errcode='22023'; end if;
  if owner <> actor and not public.is_admin(actor)
     and not exists (select 1 from public.business_team_members m where m.business_id = p_business and m.user_id = actor) then
    raise exception 'You are not on this team.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', x.user_id, 'fullName', x.full_name, 'username', x.username, 'avatarUrl', x.avatar_url,
    'memberType', x.member_type, 'isOwner', x.is_owner, 'joinedAt', x.created_at
  ) order by x.is_owner desc, x.created_at), '[]'::jsonb) into result
  from (
    select pr.id as user_id, pr.full_name, pr.username, pr.avatar_url, m.member_type, m.created_at, false as is_owner
      from public.business_team_members m join public.profiles pr on pr.id = m.user_id
     where m.business_id = p_business and m.user_id <> owner
    union all
    select pr.id, pr.full_name, pr.username, pr.avatar_url, 'owner'::text, b.created_at, true
      from public.businesses b join public.profiles pr on pr.id = b.owner_id
     where b.id = p_business
  ) x;
  return result;
end;
$fn$;

create or replace function public.team_pending_invites(p_business uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  result jsonb;
begin
  if actor is null then raise exception 'Sign in to manage invitations.' using errcode='42501'; end if;
  if not exists (select 1 from public.businesses b where b.id = p_business and (b.owner_id = actor or public.is_admin(actor))) then
    raise exception 'Only the business owner can see invitations.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'inviteId', i.id, 'email', i.invite_email_normalized, 'memberType', i.member_type,
    'createdAt', i.created_at, 'userExists', i.invited_user_id is not null,
    'fullName', pr.full_name, 'username', pr.username
  ) order by i.created_at desc), '[]'::jsonb) into result
  from public.business_team_invites i
  left join public.profiles pr on pr.id = i.invited_user_id
  where i.business_id = p_business and i.accepted_at is null and i.revoked_at is null and i.declined_at is null;
  return result;
end;
$fn$;

create or replace function public.team_remove_member(p_business uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  actor uuid := auth.uid();
  owner uuid;
begin
  if actor is null then raise exception 'Sign in to manage the team.' using errcode='42501'; end if;
  select owner_id into owner from public.businesses where id = p_business;
  if owner is null then raise exception 'That business does not exist.' using errcode='22023'; end if;
  if owner <> actor and not public.is_admin(actor) then
    raise exception 'Only the business owner can remove team members.' using errcode='42501';
  end if;
  if p_user = owner then raise exception 'The owner cannot be removed from the team.' using errcode='22023'; end if;
  delete from public.business_team_members where business_id = p_business and user_id = p_user;
  perform public.notify_user(p_user, 'team_removed', 'You were removed from a team',
    'Your access to this business workspace was removed by the owner.', null,
    jsonb_build_object('businessId', p_business));
  return jsonb_build_object('ok', true);
end;
$fn$;

grant execute on function public.team_members_list(uuid) to authenticated;
grant execute on function public.team_pending_invites(uuid) to authenticated;
grant execute on function public.team_remove_member(uuid,uuid) to authenticated;
revoke all on function public.team_members_list(uuid) from anon;
revoke all on function public.team_pending_invites(uuid) from anon;
revoke all on function public.team_remove_member(uuid,uuid) from anon;
