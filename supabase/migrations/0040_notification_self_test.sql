-- ============================================================================
-- 0040 · A notification you can prove
-- ----------------------------------------------------------------------------
-- "I am not getting notifications" is not answerable by reading code. This adds
-- the smallest honest instrument: a function that creates one real notification
-- for the caller, addressed to the caller, through the same `notifications`
-- table and the same `group` meta shape every group message uses — so it also
-- exercises the push trigger. A second function deletes it again, so a test
-- leaves no clutter in anybody's inbox.
--
-- It is not a mock: the row is stored, counted, pushed and linked exactly like a
-- real one. If the row appears and no alert does, the break is in the browser
-- path; if the row does not appear, the break is here. Either way the answer is
-- unambiguous.
-- ============================================================================

create or replace function public.notification_self_test()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  target_group uuid;
  group_name text;
  new_id uuid;
begin
  if actor is null then raise exception 'Sign in to test notifications.' using errcode = '42501'; end if;

  /* If the caller is in a group, the test notification carries that group's id
     and name: the push trigger only fires for group notifications, so this is
     what makes the closed-tab half testable too. */
  select g.id, g.name into target_group, group_name
  from public.community_group_members m
  join public.community_groups g on g.id = m.group_id
  where m.user_id = actor
  order by m.joined_at
  limit 1;

  insert into public.notifications (user_id, type, title, body, link, meta)
  values (
    actor,
    'group',
    'Test notification',
    'If you can read this, the notification path works for this account on this device.',
    case when target_group is not null
      then '/app/?view=messages&group=' || target_group::text
      else '/app/?view=settings&section=preferences'
    end,
    jsonb_build_object(
      'groupId', target_group,
      'groupName', coalesce(group_name, 'Shinzora'),
      'senderName', 'Shinzora',
      'senderId', actor,
      'kind', 'message',
      'selfTest', true
    )
  )
  returning id into new_id;

  return jsonb_build_object(
    'id', new_id,
    'inGroup', target_group is not null,
    'groupName', group_name,
    'pushDevices', (
      select count(*) from public.push_subscriptions
      where user_id = actor and disabled_at is null
    ),
    'pushEnabled', coalesce((
      select p.push_enabled from public.notification_preferences p where p.user_id = actor
    ), false)
  );
end $$;

revoke all on function public.notification_self_test() from public, anon;
grant execute on function public.notification_self_test() to authenticated;

/** Remove the test rows this account created. Only your own, only self-tests. */
create or replace function public.notification_self_test_clear()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  removed int := 0;
begin
  if actor is null then raise exception 'Sign in to do that.' using errcode = '42501'; end if;
  delete from public.notifications
   where user_id = actor and coalesce((meta->>'selfTest')::boolean, false);
  get diagnostics removed = row_count;
  return jsonb_build_object('removed', removed);
end $$;

revoke all on function public.notification_self_test_clear() from public, anon;
grant execute on function public.notification_self_test_clear() to authenticated;

comment on function public.notification_self_test() is
  'Creates one real notification for the caller so the delivery path can be proven from the UI. Deleted again by notification_self_test_clear().';
