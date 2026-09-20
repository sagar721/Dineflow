-- 002_tenancy.sql — restaurants, staff membership, platform admins, support grants,
-- the audit log, and the RLS policies that make tenant isolation a database property.
-- Design: docs/design/01-database.md §3.1, §6; docs/design/07-stage2-conditions.md §2–3.

-- --------------------------------------------------------------------- enums
do $$
begin
  if not exists (select 1 from pg_type where typname = 'restaurant_status') then
    create type restaurant_status as enum ('provisioning', 'active', 'suspended', 'closed');
  end if;
  if not exists (select 1 from pg_type where typname = 'staff_role') then
    create type staff_role as enum ('owner', 'manager', 'kitchen', 'billing');
  end if;
  if not exists (select 1 from pg_type where typname = 'staff_status') then
    create type staff_status as enum ('active', 'deactivated');
  end if;
end$$;

-- --------------------------------------------------------------- restaurants
create table if not exists restaurants (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name             text not null check (length(btrim(name)) between 1 and 120),
  status           restaurant_status not null default 'provisioning',
  accepting_orders boolean not null default false,
  currency         char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  timezone         text not null default 'Asia/Kolkata',
  logo_path        text,
  brand_color      char(7) check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  address_line1    text, address_line2 text, city text, region text,
  postal_code      text, country char(2), phone text, email citext,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  version          integer not null default 1,
  -- Tenant-matching foreign keys elsewhere reference (id, restaurant_id); for the
  -- tenant root itself the pair is (id, id) so the same pattern composes.
  unique (id, status)
);

drop trigger if exists trg_restaurants_touch on restaurants;
create trigger trg_restaurants_touch before update on restaurants
  for each row execute function app.touch_updated_at();

-- ----------------------------------------------------------- platform admins
create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ staff membership
create table if not exists restaurant_users (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id),
  user_id         uuid not null unique references auth.users(id),  -- one restaurant per user (FR-107)
  role            staff_role not null,
  status          staff_status not null default 'active',
  email           citext not null,
  display_name    text check (length(display_name) <= 120),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  deactivated_at  timestamptz,
  deactivated_by  uuid,
  unique (restaurant_id, user_id)
);
create index if not exists ix_restaurant_users_restaurant on restaurant_users (restaurant_id, role);

drop trigger if exists trg_restaurant_users_touch on restaurant_users;
create trigger trg_restaurant_users_touch before update on restaurant_users
  for each row execute function app.touch_updated_at();

-- A restaurant must always keep one active owner (BR-USR-01). Enforced here rather
-- than in the API so no code path can strand a tenant without an administrator.
create or replace function app.assert_owner_remains() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  rid uuid := coalesce(old.restaurant_id, new.restaurant_id);
  remaining integer;
begin
  select count(*) into remaining
    from restaurant_users
   where restaurant_id = rid and role = 'owner' and status = 'active';
  if remaining = 0 then
    raise exception 'restaurant % would be left without an active owner', rid
      using errcode = 'check_violation';
  end if;
  return null;
end$$;

drop trigger if exists trg_owner_remains on restaurant_users;
create constraint trigger trg_owner_remains
  after update or delete on restaurant_users
  deferrable initially deferred
  for each row execute function app.assert_owner_remains();

-- -------------------------------------------------------------- support grants
-- Platform-admin access to a tenant's data is deliberate, reasoned, time-limited
-- and visible to the owner (FR-123).
create table if not exists support_grants (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  admin_user_id uuid not null references auth.users(id),
  reason        text not null check (length(btrim(reason)) between 10 and 500),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '4 hours')
);
create index if not exists ix_support_grants_live on support_grants (restaurant_id, expires_at);

-- A grant is a record of who looked at whose data, so only its revocation may change.
-- Without this, a platform admin could re-point an existing grant at another tenant
-- and inherit its access (found by the isolation harness, ISO-06).
create or replace function app.support_grant_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id
     or new.admin_user_id is distinct from old.admin_user_id
     or new.reason is distinct from old.reason
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'support grants may only be revoked, not edited'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_support_grant_immutable on support_grants;
create trigger trg_support_grant_immutable before update on support_grants
  for each row execute function app.support_grant_immutable();

-- ----------------------------------------------------------------- audit log
create table if not exists audit_log (
  id            bigint generated always as identity primary key,
  restaurant_id uuid references restaurants(id),   -- null for platform-level events
  actor_user_id uuid,
  actor_role    text,
  action        text not null,
  entity_type   text,
  entity_id     text,
  summary       jsonb not null default '{}'::jsonb,
  ip            inet,
  user_agent    text,
  request_id    text,
  created_at    timestamptz not null default now()
);
create index if not exists ix_audit_restaurant_time on audit_log (restaurant_id, created_at desc);

drop trigger if exists trg_audit_append_only on audit_log;
create trigger trg_audit_append_only before update or delete on audit_log
  for each row execute function app.deny_mutation();

-- ------------------------------------------------------- context lookup (F-3)
-- The API needs the caller's membership before any tenant context exists, but its
-- login role has no table privileges. This is the one narrow door, returning only
-- what the request pipeline needs.
create or replace function app.lookup_membership(p_user_id uuid)
returns table (restaurant_id uuid, role staff_role, staff_status staff_status,
               restaurant_status restaurant_status, is_platform_admin boolean)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select ru.restaurant_id, ru.role, ru.status, r.status,
         exists (select 1 from platform_admins pa where pa.user_id = p_user_id)
    from restaurant_users ru
    join restaurants r on r.id = ru.restaurant_id
   where ru.user_id = p_user_id
  union all
  select null::uuid, null::staff_role, null::staff_status, null::restaurant_status, true
   where exists (select 1 from platform_admins pa where pa.user_id = p_user_id)
     and not exists (select 1 from restaurant_users ru2 where ru2.user_id = p_user_id)
$$;
revoke all on function app.lookup_membership(uuid) from public;
grant execute on function app.lookup_membership(uuid) to dineflow_api;

-- ------------------------------------------------------- RLS helper functions
-- The active tenant of the caller: null unless the user is an active staff member
-- of an active restaurant. Suspension therefore locks staff out everywhere at once.
create or replace function app.restaurant_id() returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select ru.restaurant_id
    from restaurant_users ru
    join restaurants r on r.id = ru.restaurant_id
   where ru.user_id = app.uid()
     and ru.status = 'active'
     and r.status = 'active'
$$;

create or replace function app.role() returns staff_role
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select ru.role
    from restaurant_users ru
    join restaurants r on r.id = ru.restaurant_id
   where ru.user_id = app.uid()
     and ru.status = 'active'
     and r.status = 'active'
$$;

-- Platform admin requires a second authentication factor (FR-105, Part 7 §3 F-9).
create or replace function app.is_platform_admin() returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select app.aal() = 'aal2'
     and exists (select 1 from platform_admins pa where pa.user_id = app.uid())
$$;

create or replace function app.has_support_grant(p_restaurant_id uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from support_grants sg
     where sg.restaurant_id = p_restaurant_id
       and sg.admin_user_id = app.uid()
       and sg.revoked_at is null
       and sg.expires_at > now()
  )
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'app.claims()', 'app.uid()', 'app.aal()', 'app.public_restaurant_id()',
    'app.restaurant_id()', 'app.role()', 'app.is_platform_admin()',
    'app.has_support_grant(uuid)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to dineflow_staff, dineflow_public', fn);
  end loop;
end$$;

-- ------------------------------------------------------------------ privileges
grant select, update on restaurants to dineflow_staff;
grant select (id, slug, name, status, accepting_orders, currency, timezone,
              logo_path, brand_color, address_line1, address_line2, city, region,
              postal_code, country, phone)
  on restaurants to dineflow_public;
grant insert on restaurants to dineflow_staff;           -- platform admin only, per policy

grant select, insert, update on restaurant_users to dineflow_staff;
grant select on platform_admins to dineflow_staff;
grant select, insert, update on support_grants to dineflow_staff;
grant select, insert on audit_log to dineflow_staff;
grant insert on audit_log to dineflow_public;

-- ------------------------------------------------------------------------ RLS
alter table restaurants      enable row level security;
alter table restaurants      force row level security;
alter table restaurant_users enable row level security;
alter table restaurant_users force row level security;
alter table platform_admins  enable row level security;
alter table platform_admins  force row level security;
alter table support_grants   enable row level security;
alter table support_grants   force row level security;
alter table audit_log        enable row level security;
alter table audit_log        force row level security;

-- restaurants -----------------------------------------------------------------
drop policy if exists restaurants_staff_read on restaurants;
create policy restaurants_staff_read on restaurants for select to dineflow_staff
  using (id = (select app.restaurant_id())
         or (select app.is_platform_admin())
         or (select app.has_support_grant(id)));

drop policy if exists restaurants_staff_update on restaurants;
create policy restaurants_staff_update on restaurants for update to dineflow_staff
  using ((id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'))
         or (select app.is_platform_admin()))
  with check ((id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'))
         or (select app.is_platform_admin()));

drop policy if exists restaurants_admin_insert on restaurants;
create policy restaurants_admin_insert on restaurants for insert to dineflow_staff
  with check ((select app.is_platform_admin()));

drop policy if exists restaurants_public_read on restaurants;
create policy restaurants_public_read on restaurants for select to dineflow_public
  using (id = (select app.public_restaurant_id()) and status = 'active');

-- restaurant_users ------------------------------------------------------------
drop policy if exists staff_read on restaurant_users;
create policy staff_read on restaurant_users for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

-- Owners manage anyone in their restaurant; managers only kitchen and billing
-- (Q-10 assumption). Nobody can grant a role above their own.
drop policy if exists staff_insert on restaurant_users;
create policy staff_insert on restaurant_users for insert to dineflow_staff
  with check (
    restaurant_id = (select app.restaurant_id())
    and ((select app.role()) = 'owner'
         or ((select app.role()) = 'manager' and role in ('kitchen', 'billing')))
  );

drop policy if exists staff_update on restaurant_users;
create policy staff_update on restaurant_users for update to dineflow_staff
  using (
    restaurant_id = (select app.restaurant_id())
    and ((select app.role()) = 'owner'
         or ((select app.role()) = 'manager' and role in ('kitchen', 'billing')))
  )
  with check (
    restaurant_id = (select app.restaurant_id())
    and ((select app.role()) = 'owner'
         or ((select app.role()) = 'manager' and role in ('kitchen', 'billing')))
  );

-- platform_admins -------------------------------------------------------------
drop policy if exists platform_admins_self on platform_admins;
create policy platform_admins_self on platform_admins for select to dineflow_staff
  using (user_id = (select app.uid()));

-- support_grants --------------------------------------------------------------
drop policy if exists support_grants_read on support_grants;
create policy support_grants_read on support_grants for select to dineflow_staff
  using ((restaurant_id = (select app.restaurant_id())      -- the owner sees who looked
          and (select app.role()) = 'owner')
         or (select app.is_platform_admin()));

drop policy if exists support_grants_admin_write on support_grants;
create policy support_grants_admin_write on support_grants for insert to dineflow_staff
  with check ((select app.is_platform_admin()) and admin_user_id = (select app.uid()));

drop policy if exists support_grants_admin_revoke on support_grants;
create policy support_grants_admin_revoke on support_grants for update to dineflow_staff
  using ((select app.is_platform_admin()))
  with check ((select app.is_platform_admin()));

-- audit_log -------------------------------------------------------------------
drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select to dineflow_staff
  using ((restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager'))
         or ((select app.is_platform_admin()) and restaurant_id is null));

drop policy if exists audit_write on audit_log;
create policy audit_write on audit_log for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id())
              or ((select app.is_platform_admin()) and restaurant_id is not null));

drop policy if exists audit_write_public on audit_log;
create policy audit_write_public on audit_log for insert to dineflow_public
  with check (restaurant_id = (select app.public_restaurant_id()));
