-- 004_restaurant_profile.sql — restaurant settings, tax configuration, and the
-- rules about who may change what on a restaurant.
-- Design: docs/design/01-database.md §3.1; PRD FR-003 … FR-009.

-- --------------------------------------------------------------------- enums
do $$
begin
  if not exists (select 1 from pg_type where typname = 'contact_policy') then
    create type contact_policy as enum ('off', 'optional', 'require_mobile', 'require_email', 'require_both');
  end if;
  if not exists (select 1 from pg_type where typname = 'rounding_mode') then
    -- Values are minor units: nearest_50 rounds to the nearest 0.50.
    create type rounding_mode as enum ('none', 'nearest_50', 'nearest_1');
  end if;
end$$;

-- Opening hours are free text in v1: a structured schedule is only worth building
-- when something depends on it (auto-closing ordering is Q-16, not v1).
alter table restaurants add column if not exists opening_hours_text text
  check (length(opening_hours_text) <= 500);

-- ------------------------------------------------------------------- settings
create table if not exists restaurant_settings (
  restaurant_id            uuid primary key references restaurants(id),
  contact_policy           contact_policy not null default 'optional',
  order_prefix             text not null default '' check (order_prefix ~ '^[A-Z0-9-]{0,6}$'),
  prices_include_tax       boolean not null default true,
  service_charge_bps       integer not null default 0 check (service_charge_bps between 0 and 10000),
  tax_registration_no      text check (length(tax_registration_no) <= 40),
  bill_footer              text check (length(bill_footer) <= 500),
  rounding_mode            rounding_mode not null default 'none',
  max_qty_per_line         integer not null default 20 check (max_qty_per_line between 1 and 99),
  max_items_per_order      integer not null default 60 check (max_items_per_order between 1 and 200),
  manager_discount_cap_bps integer not null default 2000 check (manager_discount_cap_bps between 0 and 10000),
  allow_customer_cancel    boolean not null default false,
  customer_data_retention_days integer check (customer_data_retention_days between 1 and 3650),
  require_table_code       boolean not null default false,  -- reserved hook (D-16), unused in v1
  onboarding_completed_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by               uuid
);

drop trigger if exists trg_restaurant_settings_touch on restaurant_settings;
create trigger trg_restaurant_settings_touch before update on restaurant_settings
  for each row execute function app.touch_updated_at();

-- Every restaurant has exactly one settings row, created with it. Doing this in a
-- trigger rather than in the API means no code path can produce a restaurant
-- without settings, however it is created.
-- SECURITY DEFINER because the row is an invariant of creating a restaurant, not a
-- write the caller is asking for: a platform admin may create the restaurant while
-- holding no privilege on restaurant_settings at all.
create or replace function app.create_default_settings() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  insert into restaurant_settings (restaurant_id) values (new.id)
  on conflict (restaurant_id) do nothing;
  return new;
end$$;

drop trigger if exists trg_restaurant_default_settings on restaurants;
create trigger trg_restaurant_default_settings after insert on restaurants
  for each row execute function app.create_default_settings();

-- -------------------------------------------------------------- tax components
-- Named, configurable tax lines. Nothing about tax is hardcoded: rates, names and
-- whether prices include tax are the restaurant's to set, and its responsibility to
-- get right (BR-BILL-08).
create table if not exists tax_components (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  name          text not null check (length(btrim(name)) between 1 and 40),
  rate_bps      integer not null check (rate_bps between 0 and 10000),
  sort_order    integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, restaurant_id)
);

create unique index if not exists ux_tax_components_name
  on tax_components (restaurant_id, lower(name));
create index if not exists ix_tax_components_restaurant
  on tax_components (restaurant_id, sort_order);

drop trigger if exists trg_tax_components_touch on tax_components;
create trigger trg_tax_components_touch before update on tax_components
  for each row execute function app.touch_updated_at();

-- A restaurant cannot carry an unbounded stack of taxes; the limit is about keeping
-- a bill readable, not about arithmetic.
create or replace function app.limit_tax_components() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  count_active integer;
begin
  select count(*) into count_active from tax_components
   where restaurant_id = new.restaurant_id and active;
  if count_active > 5 then
    raise exception 'a restaurant may have at most 5 active tax components'
      using errcode = 'check_violation';
  end if;
  return null;
end$$;

drop trigger if exists trg_limit_tax_components on tax_components;
create constraint trigger trg_limit_tax_components
  after insert or update on tax_components
  deferrable initially deferred
  for each row execute function app.limit_tax_components();

-- ------------------------------------------------- who may change a restaurant
-- The PRD has the owner activate their restaurant by finishing onboarding (US-02),
-- while the design reserves status changes for platform admins. Both hold here: an
-- owner may make exactly one transition, provisioning -> active, and nothing else;
-- every other transition is a platform-admin action.
create or replace function app.restaurants_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  is_admin boolean;
  actor_role staff_role;
begin
  -- Slug and id are immutable for everyone, including maintenance: printed QR links
  -- resolve through them.
  if new.slug is distinct from old.slug then
    -- The slug appears in printed QR links; changing it would break them.
    raise exception 'a restaurant slug cannot be changed' using errcode = 'insufficient_privilege';
  end if;

  if new.id is distinct from old.id then
    raise exception 'a restaurant id cannot be changed' using errcode = 'insufficient_privilege';
  end if;

  -- The rules below are about *who* is asking. A connection with no request identity
  -- is a migration, a maintenance job or a definer function, none of which have a
  -- role to check; such connections are already held to RLS, which grants them
  -- nothing without a context.
  if app.uid() is null then
    return new;
  end if;

  is_admin := app.is_platform_admin();
  actor_role := app.role();

  if new.status is distinct from old.status and not is_admin then
    if not (old.status = 'provisioning' and new.status = 'active' and actor_role = 'owner') then
      raise exception 'only a platform administrator may change restaurant status'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Currency is fixed once the restaurant is live, because prices, orders and bills
  -- recorded in one currency cannot be reinterpreted in another.
  if new.currency is distinct from old.currency
     and old.status <> 'provisioning' and not is_admin then
    raise exception 'currency cannot be changed after a restaurant goes live'
      using errcode = 'insufficient_privilege';
  end if;

  -- A manager may edit the profile, name included (FR-004), but not the money and
  -- time semantics everything else is recorded against.
  if actor_role = 'manager' and not is_admin then
    if new.currency is distinct from old.currency
       or new.timezone is distinct from old.timezone then
      raise exception 'only an owner may change the restaurant currency or timezone'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end$$;

drop trigger if exists trg_restaurants_guard on restaurants;
create trigger trg_restaurants_guard before update on restaurants
  for each row execute function app.restaurants_guard();

-- Settings belong to the owner. A manager may read them (the bill header and order
-- limits affect their work) but not rewrite the tax or billing rules.
create or replace function app.settings_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- As above: no request identity means a maintenance path, which RLS already
  -- confines. Only a real request is held to the role rule.
  if app.uid() is null then
    return new;
  end if;
  if app.role() is distinct from 'owner' and not app.is_platform_admin() then
    raise exception 'only an owner may change restaurant settings'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_settings_guard on restaurant_settings;
create trigger trg_settings_guard before update on restaurant_settings
  for each row execute function app.settings_guard();

-- ------------------------------------------------------------------ privileges
grant select, update on restaurant_settings to dineflow_staff;
grant select (restaurant_id, contact_policy, prices_include_tax, max_qty_per_line,
              max_items_per_order, allow_customer_cancel, require_table_code)
  on restaurant_settings to dineflow_public;

grant select, insert, update on tax_components to dineflow_staff;
grant select (id, restaurant_id, name, rate_bps, sort_order, active)
  on tax_components to dineflow_public;

-- ------------------------------------------------------------------------ RLS
alter table restaurant_settings enable row level security;
alter table restaurant_settings force row level security;
alter table tax_components      enable row level security;
alter table tax_components      force row level security;

drop policy if exists settings_staff_read on restaurant_settings;
create policy settings_staff_read on restaurant_settings for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

drop policy if exists settings_staff_write on restaurant_settings;
create policy settings_staff_write on restaurant_settings for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id()) and (select app.role()) = 'owner')
  with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) = 'owner');

drop policy if exists settings_public_read on restaurant_settings;
create policy settings_public_read on restaurant_settings for select to dineflow_public
  using (restaurant_id = (select app.public_restaurant_id()));

drop policy if exists tax_staff_read on tax_components;
create policy tax_staff_read on tax_components for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));

drop policy if exists tax_staff_insert on tax_components;
create policy tax_staff_insert on tax_components for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) = 'owner');

drop policy if exists tax_staff_update on tax_components;
create policy tax_staff_update on tax_components for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id()) and (select app.role()) = 'owner')
  with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) = 'owner');

drop policy if exists tax_public_read on tax_components;
create policy tax_public_read on tax_components for select to dineflow_public
  using (restaurant_id = (select app.public_restaurant_id()) and active);

-- ------------------------------------------------- platform: create a tenant
-- Creating a restaurant and its first owner invitation is one act: a restaurant
-- with no way in is not useful, and two separate calls could leave one half done.
-- It runs before any tenant context exists, so it is a definer function granted
-- only to the API's login role, and it checks the caller's platform rights itself.
create or replace function app.create_restaurant(
  p_admin_user_id uuid,
  p_slug text,
  p_name text,
  p_owner_email citext,
  p_token_hash bytea,
  p_expires_at timestamptz,
  p_currency char(3),
  p_timezone text
) returns table (restaurant_id uuid, invitation_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  new_restaurant uuid;
  new_invitation uuid;
begin
  if not exists (select 1 from platform_admins where user_id = p_admin_user_id) then
    raise exception 'only a platform administrator may create a restaurant'
      using errcode = 'insufficient_privilege';
  end if;

  insert into restaurants (slug, name, currency, timezone)
  values (p_slug, p_name, coalesce(p_currency, 'INR'), coalesce(p_timezone, 'Asia/Kolkata'))
  returning id into new_restaurant;

  insert into invitations (restaurant_id, email, role, token_hash, invited_by, expires_at)
  values (new_restaurant, p_owner_email, 'owner', p_token_hash, p_admin_user_id, p_expires_at)
  returning id into new_invitation;

  insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary)
  values (new_restaurant, p_admin_user_id, 'platform_admin', 'platform.restaurant.created',
          'restaurant', new_restaurant::text,
          jsonb_build_object('slug', p_slug, 'owner_email', p_owner_email));

  return query select new_restaurant, new_invitation;
end$$;

-- Platform-level listing: status and counts only, never a tenant's business data
-- (FR-009). A platform admin who needs to see inside a restaurant must take an
-- audited support grant.
create or replace function app.list_restaurants(p_admin_user_id uuid)
returns table (
  id uuid, slug text, name text, status restaurant_status, accepting_orders boolean,
  currency char(3), timezone text, created_at timestamptz,
  active_staff bigint, pending_invitations bigint, onboarding_completed_at timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from platform_admins where user_id = p_admin_user_id) then
    raise exception 'only a platform administrator may list restaurants'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select r.id, r.slug, r.name, r.status, r.accepting_orders, r.currency, r.timezone, r.created_at,
           (select count(*) from restaurant_users ru where ru.restaurant_id = r.id and ru.status = 'active'),
           (select count(*) from invitations i where i.restaurant_id = r.id
              and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
           s.onboarding_completed_at
      from restaurants r
      left join restaurant_settings s on s.restaurant_id = r.id
     order by r.created_at desc;
end$$;

create or replace function app.set_restaurant_status(
  p_admin_user_id uuid,
  p_restaurant_id uuid,
  p_status restaurant_status,
  p_reason text
) returns restaurant_status
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  previous restaurant_status;
begin
  if not exists (select 1 from platform_admins where user_id = p_admin_user_id) then
    raise exception 'only a platform administrator may change restaurant status'
      using errcode = 'insufficient_privilege';
  end if;

  select status into previous from restaurants where id = p_restaurant_id for update;
  if previous is null then
    return null;
  end if;

  -- Suspension must also stop ordering, or a suspended restaurant would keep taking
  -- orders from its printed QR codes while its staff are locked out.
  update restaurants
     set status = p_status,
         accepting_orders = case when p_status = 'active' then accepting_orders else false end
   where id = p_restaurant_id;

  insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary)
  values (p_restaurant_id, p_admin_user_id, 'platform_admin', 'platform.restaurant.status_changed',
          'restaurant', p_restaurant_id::text,
          jsonb_build_object('from', previous, 'to', p_status, 'reason', p_reason));

  return previous;
end$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'app.create_restaurant(uuid, text, text, citext, bytea, timestamptz, char, text)',
    'app.list_restaurants(uuid)',
    'app.set_restaurant_status(uuid, uuid, restaurant_status, text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to dineflow_api', fn);
  end loop;
end$$;
