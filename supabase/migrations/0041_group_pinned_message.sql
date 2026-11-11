-- ==========================================================================
-- 0041 — one pinned message per group
-- --------------------------------------------------------------------------
-- The messaging hub shows a pin bar under the group name so the one thing a
-- group agreed on stays in sight. It is one pin per group, deliberately: a list
-- of pins becomes a second inbox nobody reads.
--
-- The group row keeps a reference to the message, so unpinning is a single
-- column write and a deleted message cannot leave a dangling pin
-- (`on delete set null` — the message going away clears the pin).
--
-- Who may pin: owner and admins (`group_role_of` in `('owner','admin')`). This
-- is checked here in the database, not by hiding the button, so a member calling
-- the RPC directly is refused.
-- ==========================================================================

alter table public.community_groups
  add column if not exists pinned_message_id uuid
  references public.community_messages(id) on delete set null;

comment on column public.community_groups.pinned_message_id is
  'The single message pinned to the top of the group thread, or null.';

-- --------------------------------------------------------------------------
-- group_pinned — read the pin (any member)
-- --------------------------------------------------------------------------
create or replace function public.group_pinned(p_group uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  pinned jsonb;
begin
  if actor is null then raise exception 'Sign in to read a group.' using errcode = '42501'; end if;
  if not public.group_is_member(p_group, actor) then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;

  select jsonb_build_object(
           'id', m.id,
           'body', left(coalesce(m.body, ''), 400),
           'authorId', m.author_id,
           'authorName', coalesce(nullif(p.full_name, ''), p.username, 'Member'),
           'createdAt', m.created_at
         )
    into pinned
    from public.community_groups g
    join public.community_messages m on m.id = g.pinned_message_id
    join public.profiles p on p.id = m.author_id
   where g.id = p_group
     and m.removed_at is null;

  return pinned; -- null when nothing is pinned
end $$;

revoke all on function public.group_pinned(uuid) from public, anon;
grant execute on function public.group_pinned(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- group_pin — pin one message (owner/admin)
-- --------------------------------------------------------------------------
create or replace function public.group_pin(p_group uuid, p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  my_role text;
begin
  if actor is null then raise exception 'Sign in to pin a message.' using errcode = '42501'; end if;

  my_role := public.group_role_of(p_group, actor);
  if my_role is null then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;
  if my_role not in ('owner', 'admin') then
    raise exception 'Only the group owner and admins can pin a message.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.community_messages m
    where m.id = p_message and m.group_id = p_group and m.removed_at is null
  ) then
    raise exception 'That message is not in this group.' using errcode = 'P0002';
  end if;

  update public.community_groups
     set pinned_message_id = p_message, updated_at = now()
   where id = p_group;

  return public.group_pinned(p_group);
end $$;

revoke all on function public.group_pin(uuid, uuid) from public, anon;
grant execute on function public.group_pin(uuid, uuid) to authenticated;

-- --------------------------------------------------------------------------
-- group_unpin — clear the pin (owner/admin)
-- --------------------------------------------------------------------------
create or replace function public.group_unpin(p_group uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  my_role text;
begin
  if actor is null then raise exception 'Sign in to change a group.' using errcode = '42501'; end if;

  my_role := public.group_role_of(p_group, actor);
  if my_role is null then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;
  if my_role not in ('owner', 'admin') then
    raise exception 'Only the group owner and admins can unpin a message.' using errcode = '42501';
  end if;

  update public.community_groups
     set pinned_message_id = null, updated_at = now()
   where id = p_group;

  return jsonb_build_object('pinned', null);
end $$;

revoke all on function public.group_unpin(uuid) from public, anon;
grant execute on function public.group_unpin(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- group_messages_search — find a message in the group you are reading
-- --------------------------------------------------------------------------
create or replace function public.group_messages_search(
  p_group uuid,
  p_query text,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  needle text := btrim(coalesce(p_query, ''));
  cap int := greatest(1, least(coalesce(p_limit, 30), 100));
begin
  if actor is null then raise exception 'Sign in to search messages.' using errcode = '42501'; end if;
  if not public.group_is_member(p_group, actor) then
    raise exception 'You are not a member of that group.' using errcode = '42501';
  end if;
  -- Two characters is the shortest query worth a round trip; below that the
  -- result would be "everything", which the thread already shows.
  if char_length(needle) < 2 then return '[]'::jsonb; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', x.id,
      'body', x.body,
      'createdAt', x.created_at,
      'authorName', x.author_name
    ) order by x.created_at desc)
    from (
      select m.id, left(coalesce(m.body, ''), 400) as body, m.created_at,
             coalesce(nullif(p.full_name, ''), p.username, 'Member') as author_name
        from public.community_messages m
        join public.profiles p on p.id = m.author_id
       where m.group_id = p_group
         and m.removed_at is null
         and m.body ilike '%' || needle || '%'
       order by m.created_at desc
       limit cap
    ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.group_messages_search(uuid, text, integer) from public, anon;
grant execute on function public.group_messages_search(uuid, text, integer) to authenticated;
