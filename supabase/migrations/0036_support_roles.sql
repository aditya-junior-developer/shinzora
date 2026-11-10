-- ============================================================================
-- 0036 · Support conversation roles
-- ----------------------------------------------------------------------------
-- 0001 constrained support_replies.author_role to ('owner', 'admin', 'system'),
-- which was accurate while every reply was typed by the owner or the platform.
-- Automated replies (0035's auto_reply switch, driven by the `ai` function) and
-- genuine inbound customer messages need two more roles, and the storefront's
-- "write to the business" path is the natural place for `customer`.
--
-- Widening a check constraint keeps every existing row valid; nothing is
-- rewritten and no default changes. Idempotent: the constraint is dropped by
-- name and recreated.
-- ============================================================================

do $$
begin
  if exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'support_replies'
       and c.conname = 'support_replies_author_role_check'
  ) then
    alter table public.support_replies drop constraint support_replies_author_role_check;
  end if;

  alter table public.support_replies
    add constraint support_replies_author_role_check
    check (author_role in ('owner', 'admin', 'system', 'assistant', 'customer'));
exception
  when duplicate_object then null;
end $$;

/* Finding "the customer's most recent message" is the query auto-reply runs on
   every check, so it gets an index rather than a scan. */
create index if not exists support_replies_ticket_role_idx
  on public.support_replies (ticket_id, author_role, created_at desc);

comment on column public.support_replies.author_role is
  'owner = the business, admin = Shinzora staff, system = platform events, assistant = automated AI reply, customer = inbound from the buyer.';
