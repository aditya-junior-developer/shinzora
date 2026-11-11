-- ============================================================================
-- 0038 · Web Push delivery
-- ----------------------------------------------------------------------------
-- Group notifications already land in `notifications` and already reach an open
-- tab over Realtime. This migration adds the closed-tab half: a trigger on
-- `notifications` hands the new row to the `push` Edge Function, which encrypts
-- and delivers it through the member's own push subscriptions.
--
-- Three deliberate choices:
--
--   • The trigger never blocks an insert. `net.http_post` is asynchronous and
--     this function swallows nothing it cannot do — if the shared secret or the
--     extension is missing it simply returns, so a group message is never lost
--     because a push could not be queued.
--   • The shared secret lives in Supabase Vault, generated here, and is never
--     in this file or in git. The write-only function below compares it; only
--     the service role may call it.
--   • Only notifications that carry a `groupId` are pushed. This is the Groups
--     feature; broadening it to every notification type should be a decision
--     made with its own test, not a side effect of this one.
-- ============================================================================

-- The scheduler for outbound HTTP. Async by design: it queues the request and a
-- background worker performs it. `pg_net` ships with Supabase; on a bare
-- PostgreSQL the migration replay substitutes a no-op (scripts/staging-db.mjs).
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Shared secret between the database and the `push` function
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_hook_secret') then
    /* Two UUIDs minus their separators: 64 hex characters, from core PostgreSQL
       rather than pgcrypto, so this runs on any supported version. */
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'push_hook_secret',
      'Presented by notify_push_fanout() in the x-push-key header of the push Edge Function call.'
    );
  end if;
end $$;

/**
 * Compare a presented secret against the stored one. Write-only from the
 * outside: no caller can read the secret back, they can only learn whether the
 * value they hold is the right one.
 */
create or replace function public.push_hook_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public, vault
as $$
  select coalesce(btrim(p_secret), '') <> ''
     and exists (
       select 1 from vault.decrypted_secrets s
       where s.name = 'push_hook_secret'
         and s.decrypted_secret = btrim(p_secret)
     );
$$;

revoke all on function public.push_hook_ok(text) from public, anon, authenticated;
grant execute on function public.push_hook_ok(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Fan-out trigger
-- ---------------------------------------------------------------------------
create or replace function public.notify_push_fanout()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  hook text;
  /* The project URL is public information — it is in the browser bundle — and
     can be overridden per environment with
     `alter database postgres set shinzora.push_url = '…'`. */
  fn_url text := coalesce(
    nullif(current_setting('shinzora.push_url', true), ''),
    'https://zmkgfmlcpzjfgxdmbtvi.supabase.co/functions/v1/push'
  );
begin
  if new.meta is null or coalesce(new.meta->>'groupId', '') = '' then
    return new;
  end if;

  select decrypted_secret into hook
    from vault.decrypted_secrets
   where name = 'push_hook_secret'
   limit 1;

  if coalesce(hook, '') = '' then
    -- Not configured: the in-app path still works, so this is not an error.
    return new;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-key', hook
    ),
    body := jsonb_build_object('notification_id', new.id),
    timeout_milliseconds := 5000
  );

  return new;
end $$;

revoke all on function public.notify_push_fanout() from public, anon, authenticated;

drop trigger if exists notifications_push_fanout on public.notifications;
create trigger notifications_push_fanout
  after insert on public.notifications
  for each row
  execute function public.notify_push_fanout();

comment on function public.notify_push_fanout() is
  'Queues a Web Push for group notifications. Asynchronous (pg_net); a failure to queue never rolls back the notification.';
