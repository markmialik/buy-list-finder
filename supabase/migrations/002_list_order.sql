-- Exact list order (1, 2, 3...) chosen by the owner in Arrange mode.

alter table public.items add column list_order integer check (list_order > 0);

-- Start from today's order: priority (high, normal, low), then name.
with ordered as (
  select id,
         row_number() over (
           order by case priority when 'high' then 0 when 'normal' then 1 else 2 end,
                    lower(name), id
         ) as rn
  from public.items
)
update public.items i set list_order = o.rn from ordered o where o.id = i.id;

create index items_list_order_idx on public.items (list_order);

-- New items (from the page or, later, agents) go to the end of the list.
create function private.set_default_list_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.list_order is null then
    select coalesce(max(list_order), 0) + 1 into new.list_order from public.items;
  end if;
  return new;
end;
$$;

create trigger items_default_list_order
  before insert on public.items
  for each row execute function private.set_default_list_order();

-- Save a whole new order in one call: ordered_ids[1] becomes #1, and so on.
-- Runs as the caller, so the normal row-level security rules apply.
create function public.set_item_order(ordered_ids bigint[])
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.items i
     set list_order = t.ord
    from unnest(ordered_ids) with ordinality as t(id, ord)
   where i.id = t.id
     and i.list_order is distinct from t.ord::integer;
$$;
revoke all on function public.set_item_order(bigint[]) from public, anon;
grant execute on function public.set_item_order(bigint[]) to authenticated;
