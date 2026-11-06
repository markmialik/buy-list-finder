-- New items go to the TOP of the list (place 1), not the end.
-- Every item that already has a place moves down one to make room.
-- Applies to items added from the page and, later, by agents.
-- An insert that sets list_order itself keeps that place (nothing moves).
create or replace function private.set_default_list_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.list_order is null then
    update public.items set list_order = list_order + 1 where list_order is not null;
    new.list_order := 1;
  end if;
  return new;
end;
$$;
