-- ============================================================================
-- SHINZORA · 0049_inventory_movements_align.sql
-- ----------------------------------------------------------------------------
-- The live inventory_movements table was created from an older schema. The
-- stock trigger from 0009 inserts columns that did not exist, so every stock
-- update failed. This aligns the table and the trigger. Nothing is dropped:
-- the table held no rows when this was applied.
-- Safe to re-run.
-- ============================================================================

alter table public.inventory_movements
  add column if not exists actor_id uuid references auth.users(id) on delete set null,
  add column if not exists before_stock int,
  add column if not exists after_stock int;

-- Older columns that are NOT NULL but are not written by the trigger.
do $$
declare
  r record;
begin
  for r in
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'inventory_movements'
       and is_nullable = 'NO'
       and column_name not in ('id', 'product_id', 'owner_id', 'delta', 'created_at')
  loop
    execute format('alter table public.inventory_movements alter column %I drop not null', r.column_name);
  end loop;
end $$;

-- The live check constraint allows only these reasons.
-- 'adjustment' = a signed-in change; 'correction' = a change with no user session.
create or replace function public.record_stock_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.stock, 0) is distinct from coalesce(old.stock, 0) then
    insert into public.inventory_movements (
      product_id, owner_id, actor_id, before_stock, after_stock, balance_after, delta, reason
    )
    values (
      new.id, new.owner_id, auth.uid(), old.stock, new.stock, new.stock,
      coalesce(new.stock, 0) - coalesce(old.stock, 0),
      case when auth.uid() is null then 'correction' else 'adjustment' end
    );
  end if;
  return new;
end;
$$;
