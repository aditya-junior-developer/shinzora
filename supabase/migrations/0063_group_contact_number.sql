-- ============================================================================
-- 0063 — Each group can show a contact number
--
-- Selecting a group in Messages shows its contact number instead of opening
-- the chat. The owner (or an admin) sets the number; members read it.
--
-- community_groups has no direct write policy (0037), so the number changes
-- only through group_set_contact(), which checks the caller. Reading it is
-- limited to members: group_contact() refuses anyone outside the group.
-- ============================================================================

alter table public.community_groups
  add column if not exists contact_phone text;

alter table public.community_groups drop constraint if exists community_groups_contact_phone_check;
alter table public.community_groups
  add constraint community_groups_contact_phone_check
  check (contact_phone is null or contact_phone ~ '^\+?[0-9]{7,15}$');

comment on column public.community_groups.contact_phone is
  'Optional contact number for the group, digits with an optional leading +. Set by the owner or an admin through group_set_contact(); read by members through group_contact().';

-- Members read the number. Nobody else can.
create or replace function public.group_contact(p_group uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_phone text;
begin
  if actor is null then raise exception 'Sign in to see a group.' using errcode = '42501'; end if;
  if not public.group_is_member(p_group, actor) then
    raise exception 'Only members can see this group.' using errcode = '42501';
  end if;
  select g.contact_phone into v_phone from public.community_groups g where g.id = p_group;
  return v_phone;
end;
$$;

-- The owner or an admin sets or clears the number. Spaces, dashes and brackets
-- are removed before the check, so the stored value is always digits.
create or replace function public.group_set_contact(p_group uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  v_phone text;
begin
  if actor is null then raise exception 'Sign in to change a group.' using errcode = '42501'; end if;
  if not public.group_can_manage(p_group, actor) then
    raise exception 'Only the group owner or a group admin can set the contact number.' using errcode = '42501';
  end if;

  v_phone := nullif(regexp_replace(coalesce(p_phone, ''), '[\s\-()\.]', '', 'g'), '');
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'Enter a phone number with 7 to 15 digits, optionally starting with +.' using errcode = '22023';
  end if;

  update public.community_groups g set contact_phone = v_phone, updated_at = now() where g.id = p_group;
  if not found then raise exception 'That group does not exist.' using errcode = 'P0002'; end if;

  return jsonb_build_object('contactPhone', v_phone);
end;
$$;

revoke all on function public.group_contact(uuid) from public, anon;
grant execute on function public.group_contact(uuid) to authenticated;
revoke all on function public.group_set_contact(uuid, text) from public, anon;
grant execute on function public.group_set_contact(uuid, text) to authenticated;
