-- 006_tables_and_qr.sql — dining tables and their QR codes.
-- Design: docs/design/01-database.md §3.2; docs/design/07-stage2-conditions.md §5;
-- PRD FR-010 … FR-017.
--
-- The database never holds a usable QR token. A token is an HMAC over a random
-- qr_id, computed by the API with a key the database does not have, so stealing
-- the database alone yields nothing that works on a table.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'table_status') then
    create type table_status as enum ('active', 'inactive');
  end if;
end$$;

-- ------------------------------------------------------------------- tables
create table if not exists dining_tables (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  -- What staff and customers call the table: "12", "T01", "Patio 3". Stored as
  -- typed; uniqueness is case-insensitive so "t01" and "T01" cannot coexist.
  table_number  text not null check (table_number = btrim(table_number) and length(table_number) between 1 and 20),
  name          text check (name = btrim(name) and length(name) between 1 and 60),
  capacity      integer not null check (capacity between 1 and 100),
  status        table_status not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  version       integer not null default 1,
  -- Tenant-matching key for children, so a QR record cannot point at another
  -- restaurant's table even if application code tried to make it.
  unique (id, restaurant_id)
);

create unique index if not exists ux_dining_tables_number
  on dining_tables (restaurant_id, lower(table_number));
create index if not exists ix_dining_tables_restaurant
  on dining_tables (restaurant_id, status);

drop trigger if exists trg_dining_tables_touch on dining_tables;
create trigger trg_dining_tables_touch before update on dining_tables
  for each row execute function app.touch_updated_at();

-- A table belongs to one restaurant for life. RLS's WITH CHECK already stops a
-- request moving it; this also stops maintenance paths from doing so by accident.
create or replace function app.dining_table_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id or new.id is distinct from old.id then
    raise exception 'a table cannot move between restaurants' using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_dining_table_immutable on dining_tables;
create trigger trg_dining_table_immutable before update on dining_tables
  for each row execute function app.dining_table_immutable();

-- ----------------------------------------------------------------- QR tokens
create table if not exists table_qr_tokens (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  table_id      uuid not null,
  -- Random, and the only thing stored. The printable token is
  -- base64url(key_id || qr_id || HMAC(key, qr_id)), computed by the API.
  qr_id         uuid not null unique default gen_random_uuid(),
  key_id        smallint not null check (key_id between 1 and 255),
  created_at    timestamptz not null default now(),
  created_by    uuid,
  revoked_at    timestamptz,
  revoked_by    uuid,
  foreign key (table_id, restaurant_id) references dining_tables (id, restaurant_id)
);

-- Exactly one live QR per table: regenerating revokes the old one first, in the
-- same transaction, so a printed card and its replacement never both work.
create unique index if not exists ux_table_qr_live
  on table_qr_tokens (table_id) where revoked_at is null;
create index if not exists ix_table_qr_restaurant
  on table_qr_tokens (restaurant_id, table_id);

-- A QR record is evidence of what was printed. It may be revoked, never re-aimed.
create or replace function app.table_qr_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id
     or new.table_id is distinct from old.table_id
     or new.qr_id is distinct from old.qr_id
     or new.key_id is distinct from old.key_id
     or new.created_at is distinct from old.created_at then
    raise exception 'a QR code may only be revoked, not edited' using errcode = 'insufficient_privilege';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked QR code cannot be reinstated' using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_table_qr_immutable on table_qr_tokens;
create trigger trg_table_qr_immutable before update on table_qr_tokens
  for each row execute function app.table_qr_immutable();

-- ------------------------------------------------------------------ privileges
-- No DELETE for anyone: tables are deactivated, QR codes are revoked. Hard delete
-- of a table with no order history (FR-012) waits for the orders module, which is
-- what makes "no history" checkable.
grant select, insert, update on dining_tables to dineflow_staff;
grant select, insert, update on table_qr_tokens to dineflow_staff;
-- Customers get nothing on either table. They reach one table, through one
-- verified token, by way of the resolver below.

alter table dining_tables   enable row level security;
alter table dining_tables   force row level security;
alter table table_qr_tokens enable row level security;
alter table table_qr_tokens force row level security;

-- ----------------------------------------------------------------- policies
drop policy if exists tables_read on dining_tables;
create policy tables_read on dining_tables for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

drop policy if exists tables_insert on dining_tables;
create policy tables_insert on dining_tables for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id())
              and (select app.role()) in ('owner', 'manager'));

drop policy if exists tables_update on dining_tables;
create policy tables_update on dining_tables for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'))
  with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'));

-- QR identifiers are half of a working capability, so only the roles that print
-- and rotate QR codes may read them, and support access does not extend to them.
drop policy if exists qr_read on table_qr_tokens;
create policy qr_read on table_qr_tokens for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         and (select app.role()) in ('owner', 'manager'));

drop policy if exists qr_insert on table_qr_tokens;
create policy qr_insert on table_qr_tokens for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id())
              and (select app.role()) in ('owner', 'manager')
              and created_by = (select app.uid()));

drop policy if exists qr_revoke on table_qr_tokens;
create policy qr_revoke on table_qr_tokens for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'))
  with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'));

-- -------------------------------------------------------------- resolution
-- Called only after the API has verified the token's MAC in memory, so a forged
-- token never reaches the database. Returns a row only when every condition for a
-- customer to be at this table holds; otherwise nothing, and the caller cannot
-- tell which condition failed (FR-017).
create or replace function app.resolve_table_qr(p_qr_id uuid)
returns table (restaurant_id uuid, table_id uuid, table_number text, table_name text, key_id smallint)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select q.restaurant_id, t.id, t.table_number, t.name, q.key_id
    from table_qr_tokens q
    join dining_tables t on t.id = q.table_id and t.restaurant_id = q.restaurant_id
    join restaurants r on r.id = q.restaurant_id
   where q.qr_id = p_qr_id
     and q.revoked_at is null
     and t.status = 'active'
     and r.status = 'active'
$$;

revoke all on function app.resolve_table_qr(uuid) from public;
grant execute on function app.resolve_table_qr(uuid) to dineflow_api;
