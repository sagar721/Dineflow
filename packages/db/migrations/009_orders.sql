-- 009_orders.sql — customer order placement (PRD FR-030 … FR-046).
-- Design: docs/design/01-database.md §3.4, docs/design/02-api-auth-tenancy.md §8.
--
-- Scope: what a customer needs to place an order and follow it. Status changes by
-- staff, the status history, cancellation and the kitchen views are the next module
-- and add their own grants; until then no role may change an order after it is
-- placed.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type order_status as enum ('pending', 'accepted', 'preparing', 'ready', 'served', 'cancelled');
  end if;
end$$;

-- ------------------------------------------------------------- order numbers
-- One continuous sequence per restaurant (Q-13, D-18). Allocated only through
-- app.next_order_no(), inside the order's own transaction: the row lock serialises
-- concurrent orders, and a rolled-back order gives its number back, so there are
-- no gaps and no duplicates.
create table if not exists order_counters (
  restaurant_id uuid primary key references restaurants(id),
  next_no       integer not null default 1 check (next_no >= 1)
);

-- ------------------------------------------------------------------- orders
create table if not exists orders (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references restaurants(id),
  table_id             uuid not null,
  order_no             integer not null check (order_no >= 1),
  -- What staff and the customer call it: the restaurant's prefix and the number.
  order_ref            text not null check (length(order_ref) between 1 and 20),
  status               order_status not null default 'pending',
  subtotal_minor       bigint not null check (subtotal_minor between 0 and 1000000000000),
  special_instructions text check (special_instructions = btrim(special_instructions)
                                   and length(special_instructions) between 1 and 500),
  -- SHA-256 of the customer's order-status token. The token itself is never stored.
  public_token_hash    bytea not null unique check (length(public_token_hash) = 32),
  idempotency_key      uuid not null,
  -- SHA-256 of the canonical request, so a reused key with a different cart is refused.
  request_hash         bytea not null check (length(request_hash) = 32),
  placed_at            timestamptz not null default now(),
  status_updated_at    timestamptz not null default now(),
  version              integer not null default 1,
  unique (id, restaurant_id),
  unique (restaurant_id, order_no),
  unique (restaurant_id, idempotency_key),
  -- The table must belong to the same restaurant: a cross-tenant order is impossible.
  foreign key (table_id, restaurant_id) references dining_tables (id, restaurant_id)
);

create index if not exists ix_orders_status on orders (restaurant_id, status, placed_at);
create index if not exists ix_orders_table on orders (restaurant_id, table_id, status);

-- -------------------------------------------------------------- order items
-- Snapshots: the name and unit price as they were when the order was placed, so
-- later menu edits never change what an order says (FR-026, BR-ORD-01).
create table if not exists order_items (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id),
  order_id         uuid not null,
  menu_item_id     uuid not null,
  position         smallint not null check (position between 1 and 200),
  name_snapshot    text not null check (length(name_snapshot) between 1 and 120),
  unit_price_minor bigint not null check (unit_price_minor between 0 and 100000000),
  quantity         integer not null check (quantity between 1 and 99),
  line_total_minor bigint generated always as (unit_price_minor * quantity) stored,
  item_note        text check (item_note = btrim(item_note) and length(item_note) between 1 and 200),
  unique (id, restaurant_id),
  unique (order_id, position),
  -- One line per menu item: the cart merges quantities, so a repeat is a mistake.
  unique (order_id, menu_item_id),
  foreign key (order_id, restaurant_id) references orders (id, restaurant_id),
  -- The item must belong to the same restaurant as the order.
  foreign key (menu_item_id, restaurant_id) references menu_items (id, restaurant_id)
);

create index if not exists ix_order_items_order on order_items (restaurant_id, order_id);

-- ----------------------------------------------------------- customer contact
-- Personal data kept apart from operational data, so kitchen staff, who see
-- orders, never see who placed them (design/02 §4).
create table if not exists order_customers (
  order_id      uuid primary key,
  restaurant_id uuid not null references restaurants(id),
  mobile        text check (mobile ~ '^\+?[0-9]{10,15}$'),
  email         text check (length(email) <= 254 and email = lower(email)
                            and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  consent_at    timestamptz not null default now(),
  anonymized_at timestamptz,
  check (mobile is not null or email is not null or anonymized_at is not null),
  foreign key (order_id, restaurant_id) references orders (id, restaurant_id)
);

-- ------------------------------------------------------------ integrity checks
-- An order must have at least one line, and its subtotal must be exactly the sum
-- of its lines. Checked at commit (deferred), when every line has been written,
-- and again if a line is ever added to an existing order. SECURITY DEFINER because
-- the customer role that inserts the order may not read orders back.
create or replace function app.check_order_totals() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  target uuid;
  expected bigint;
  lines integer;
  total bigint;
begin
  -- An IF, not a CASE: PL/pgSQL resolves every field a CASE names, and orders
  -- rows have no order_id.
  if tg_table_name = 'orders' then
    target := new.id;
  else
    target := new.order_id;
  end if;
  select subtotal_minor into expected from orders where id = target;
  -- The row is being inserted in this very transaction, so not seeing it means the
  -- check itself cannot see the data. Fail loudly rather than pass unchecked.
  if not found then
    raise exception 'order integrity check could not read the order' using errcode = 'check_violation';
  end if;
  select count(*), coalesce(sum(line_total_minor), 0) into lines, total from order_items where order_id = target;
  if lines = 0 then
    raise exception 'an order needs at least one item' using errcode = 'check_violation';
  end if;
  if total <> expected then
    raise exception 'order subtotal does not match its lines' using errcode = 'check_violation';
  end if;
  return null;
end$$;

revoke all on function app.check_order_totals() from public;

drop trigger if exists trg_orders_totals on orders;
create constraint trigger trg_orders_totals after insert on orders
  deferrable initially deferred for each row execute function app.check_order_totals();
drop trigger if exists trg_order_items_totals on order_items;
create constraint trigger trg_order_items_totals after insert on order_items
  deferrable initially deferred for each row execute function app.check_order_totals();

-- The next order number for the restaurant the customer's QR resolved to. It takes
-- no argument, so it can only ever number orders of that one restaurant.
create or replace function app.next_order_no() returns integer
language sql security definer
set search_path = pg_catalog, public
as $$
  insert into order_counters (restaurant_id, next_no)
  values (app.public_restaurant_id(), 2)
  on conflict (restaurant_id) do update set next_no = order_counters.next_no + 1
  returning next_no - 1
$$;

revoke all on function app.next_order_no() from public;
grant execute on function app.next_order_no() to dineflow_public;

-- The hash of the order-status token the customer presented, set by the API for
-- one transaction. Reading an order back needs it: a customer can see an order
-- only by proving they hold its token.
create or replace function app.public_order_token_hash() returns bytea
language sql stable
set search_path = pg_catalog, public
as $$ select decode(nullif(current_setting('app.public_order_token_hash', true), ''), 'hex') $$;

grant execute on function app.public_order_token_hash() to dineflow_public, dineflow_staff;

-- ------------------------------------------------------------------ privileges
-- Customers place orders; nobody changes or deletes one yet.
grant insert on orders, order_items, order_customers to dineflow_public;
grant select on orders, order_items to dineflow_public;   -- filtered to the token holder below
grant select on orders, order_items to dineflow_staff;
grant select on order_customers to dineflow_staff;        -- kitchen excluded by policy
-- order_counters: no grants at all; only app.next_order_no() touches it.
-- The order-number prefix is printed on every order the customer sees, so the
-- customer role may read that one column too.
grant select (order_prefix) on restaurant_settings to dineflow_public;

alter table order_counters  enable row level security;
alter table order_counters  force row level security;
alter table orders          enable row level security;
alter table orders          force row level security;
alter table order_items     enable row level security;
alter table order_items     force row level security;
alter table order_customers enable row level security;
alter table order_customers force row level security;

-- ------------------------------------------------------------------ policies
-- Staff: every role reads its own restaurant's orders; support access reads too.
drop policy if exists orders_staff_read on orders;
create policy orders_staff_read on orders for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

drop policy if exists order_items_staff_read on order_items;
create policy order_items_staff_read on order_items for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

-- Contact details: owner, manager and billing only — never kitchen (PRD §8).
drop policy if exists order_customers_staff_read on order_customers;
create policy order_customers_staff_read on order_customers for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         and (select app.role()) in ('owner', 'manager', 'billing'));

-- Customers: insert only into the restaurant their QR resolved to, only a new
-- pending order, and only while the restaurant is taking orders.
drop policy if exists orders_public_insert on orders;
create policy orders_public_insert on orders for insert to dineflow_public
  with check (restaurant_id = (select app.public_restaurant_id())
              and status = 'pending'
              and exists (select 1 from restaurants r
                           where r.id = orders.restaurant_id and r.status = 'active' and r.accepting_orders));

drop policy if exists order_items_public_insert on order_items;
create policy order_items_public_insert on order_items for insert to dineflow_public
  with check (restaurant_id = (select app.public_restaurant_id()));

drop policy if exists order_customers_public_insert on order_customers;
create policy order_customers_public_insert on order_customers for insert to dineflow_public
  with check (restaurant_id = (select app.public_restaurant_id()));

-- Customers read back only the order whose status token they hold (FR-042).
-- No restaurant context is needed: the token is the whole capability.
drop policy if exists orders_public_read on orders;
create policy orders_public_read on orders for select to dineflow_public
  using (public_token_hash = (select app.public_order_token_hash()));

drop policy if exists order_items_public_read on order_items;
create policy order_items_public_read on order_items for select to dineflow_public
  using (exists (select 1 from orders o
                  where o.id = order_items.order_id
                    and o.public_token_hash = (select app.public_order_token_hash())));
