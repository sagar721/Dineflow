-- 008_menu.sql — menu categories and items (PRD FR-020 … FR-028).
-- Design: docs/design/01-database.md §3.3 and §6.3.
--
-- Nothing here is ever deleted: categories and items are archived, so orders that
-- reference an item keep a valid reference (FR-026). Orders will also snapshot the
-- name and price they were placed at, so later edits cannot rewrite history.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'diet_type') then
    create type diet_type as enum ('veg', 'non_veg', 'egg', 'none');
  end if;
end$$;

-- --------------------------------------------------------------- categories
create table if not exists menu_categories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  name          text not null check (name = btrim(name) and length(name) between 1 and 60),
  sort_order    integer not null default 0 check (sort_order between 0 and 100000),
  visible       boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1,
  -- Tenant-matching key for items, so an item cannot sit in another restaurant's category.
  unique (id, restaurant_id)
);

-- Names are unique among live categories, case-insensitively. An archived "Drinks"
-- does not block a new one.
create unique index if not exists ux_menu_categories_name
  on menu_categories (restaurant_id, lower(name)) where archived_at is null;
create index if not exists ix_menu_categories_order
  on menu_categories (restaurant_id, sort_order);

-- ------------------------------------------------------------------- items
create table if not exists menu_items (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  category_id   uuid not null,
  name          text not null check (name = btrim(name) and length(name) between 1 and 120),
  description   text check (description = btrim(description) and length(description) between 1 and 1000),
  -- Minor units (paise). Upper bound 10,00,000.00: far above any menu price, low
  -- enough that a typo of extra zeros is refused rather than printed on a bill.
  price_minor   bigint not null check (price_minor between 0 and 100000000),
  -- Written only by the API after it has validated and re-encoded an upload. The
  -- path must sit under this restaurant's own prefix, so no row can point at
  -- another tenant's file even if application code tried.
  image_path    text constraint menu_items_image_path_check
                  check (image_path ~ ('^restaurants/' || restaurant_id::text || '/menu/[0-9a-f]{32}\.webp$')),
  diet          diet_type not null default 'none',
  available     boolean not null default true,
  visible       boolean not null default true,
  sort_order    integer not null default 0 check (sort_order between 0 and 100000),
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1,
  unique (id, restaurant_id),
  foreign key (category_id, restaurant_id) references menu_categories (id, restaurant_id)
);

create index if not exists ix_menu_items_category
  on menu_items (restaurant_id, category_id, sort_order);
-- Two live "Masala Tea" in one category would be indistinguishable on the menu and
-- on a bill. The same name in different categories is fine.
create unique index if not exists ux_menu_items_name
  on menu_items (restaurant_id, category_id, lower(name)) where archived_at is null;

drop trigger if exists trg_menu_categories_touch on menu_categories;
create trigger trg_menu_categories_touch before update on menu_categories
  for each row execute function app.touch_updated_at();
drop trigger if exists trg_menu_items_touch on menu_items;
create trigger trg_menu_items_touch before update on menu_items
  for each row execute function app.touch_updated_at();

-- A category or item belongs to one restaurant for life.
create or replace function app.menu_row_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id or new.id is distinct from old.id then
    raise exception 'menu rows cannot move between restaurants' using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_menu_categories_immutable on menu_categories;
create trigger trg_menu_categories_immutable before update on menu_categories
  for each row execute function app.menu_row_immutable();
drop trigger if exists trg_menu_items_immutable on menu_items;
create trigger trg_menu_items_immutable before update on menu_items
  for each row execute function app.menu_row_immutable();

-- Kitchen staff may mark an item sold out or back in stock (FR-024) and nothing
-- else. RLS can say "kitchen may update this row" but not "only this column", so
-- the column rule lives here, independent of the API.
create or replace function app.menu_item_kitchen_limit() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (select app.role()) = 'kitchen' and (
       new.category_id  is distinct from old.category_id
    or new.name         is distinct from old.name
    or new.description  is distinct from old.description
    or new.price_minor  is distinct from old.price_minor
    or new.image_path   is distinct from old.image_path
    or new.diet         is distinct from old.diet
    or new.visible      is distinct from old.visible
    or new.sort_order   is distinct from old.sort_order
    or new.archived_at  is distinct from old.archived_at
    or new.created_at   is distinct from old.created_at) then
    raise exception 'kitchen staff may only change availability' using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_menu_item_kitchen_limit on menu_items;
create trigger trg_menu_item_kitchen_limit before update on menu_items
  for each row execute function app.menu_item_kitchen_limit();

-- ------------------------------------------------------------------ privileges
-- No DELETE for anyone (FR-026): archive instead.
grant select, insert, update on menu_categories to dineflow_staff;
grant select, insert, update on menu_items to dineflow_staff;
-- Customers read the menu of the one restaurant their QR resolved to. Nothing in
-- these tables is private, but rows are still filtered by the policies below.
grant select on menu_categories to dineflow_public;
grant select on menu_items to dineflow_public;

alter table menu_categories enable row level security;
alter table menu_categories force row level security;
alter table menu_items      enable row level security;
alter table menu_items      force row level security;

-- ------------------------------------------------------------------ policies
drop policy if exists menu_categories_read on menu_categories;
create policy menu_categories_read on menu_categories for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

drop policy if exists menu_categories_insert on menu_categories;
create policy menu_categories_insert on menu_categories for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id())
              and (select app.role()) in ('owner', 'manager'));

drop policy if exists menu_categories_update on menu_categories;
create policy menu_categories_update on menu_categories for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'))
  with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'));

drop policy if exists menu_categories_public_read on menu_categories;
create policy menu_categories_public_read on menu_categories for select to dineflow_public
  using (restaurant_id = (select app.public_restaurant_id())
         and visible and archived_at is null);

drop policy if exists menu_items_read on menu_items;
create policy menu_items_read on menu_items for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

drop policy if exists menu_items_insert on menu_items;
create policy menu_items_insert on menu_items for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id())
              and (select app.role()) in ('owner', 'manager'));

-- Kitchen is admitted here for availability only; the trigger above refuses any
-- other column change it attempts.
drop policy if exists menu_items_update on menu_items;
create policy menu_items_update on menu_items for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'kitchen'))
  with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'kitchen'));

-- A customer sees an item only if it and its category are both shown and live.
-- Sold-out items are included, so they can be displayed as sold out (FR-025).
drop policy if exists menu_items_public_read on menu_items;
create policy menu_items_public_read on menu_items for select to dineflow_public
  using (restaurant_id = (select app.public_restaurant_id())
         and visible and archived_at is null
         and exists (select 1 from menu_categories c
                      where c.id = menu_items.category_id
                        and c.restaurant_id = menu_items.restaurant_id
                        and c.visible and c.archived_at is null));
