-- 001_foundations.sql — roles, schemas, closed-by-default privileges, audit skeleton.
-- Design: docs/design/01-database.md §1, §6; docs/design/07-stage2-conditions.md §3.
--
-- Everything here is written to be idempotent so it can run against a fresh local
-- Postgres container and against a Supabase project that already has `auth` objects.

-- ---------------------------------------------------------------- extensions
create extension if not exists pgcrypto;
create extension if not exists citext;

-- ------------------------------------------------------------------- schemas
create schema if not exists app;

-- `auth.users` exists in Supabase. Locally we create a minimal stand-in with the
-- same shape so migrations, foreign keys and tests are identical in both places.
create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email citext
);

-- --------------------------------------------------------------------- roles
-- dineflow_api    : the only LOGIN role the API uses. Owns nothing, has no table
--                   privileges of its own, cannot bypass RLS. It may only SET ROLE
--                   to the two request roles below (F-2 in Part 7 §3).
-- dineflow_staff  : staff and platform-admin requests.
-- dineflow_public : unauthenticated customer requests.
-- dineflow_ops    : maintenance/retention jobs. Not reachable from the API.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dineflow_staff') then
    create role dineflow_staff nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dineflow_public') then
    create role dineflow_public nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dineflow_ops') then
    create role dineflow_ops nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dineflow_api') then
    -- Password is set out of band (deploy secret); never in a migration.
    create role dineflow_api login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end$$;

-- NOINHERIT means dineflow_api holds no privileges of its own: it must SET ROLE
-- explicitly, so a query that forgets to establish a request context runs with
-- nothing rather than with someone else's rights.
grant dineflow_staff, dineflow_public to dineflow_api;

-- ------------------------------------------------- closed-by-default privileges
-- Supabase grants new tables to anon/authenticated/service_role by default. Those
-- roles are doors into our data via the auto-generated Data API (Part 7 §3, F-1),
-- so we revoke the defaults and never grant them anything.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke all on schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end$$;

revoke all on schema public from public;
revoke all on all tables in schema public from public;
alter default privileges in schema public revoke all on tables from public;
alter default privileges in schema public revoke all on sequences from public;
alter default privileges in schema public revoke execute on functions from public;

grant usage on schema public to dineflow_staff, dineflow_public, dineflow_ops;
grant usage on schema app    to dineflow_staff, dineflow_public, dineflow_ops, dineflow_api;

-- ------------------------------------------------------------------- helpers
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

-- Raise on any attempt to change or remove an append-only row. Used by audit and
-- ledger tables, where "the application never deletes" must not rely on the
-- application remembering.
create or replace function app.deny_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'append-only table: % not permitted on %', tg_op, tg_table_name
    using errcode = 'insufficient_privilege';
end$$;

-- --------------------------------------------------------------- request context
-- Identity comes from settings the API sets inside each transaction, after it has
-- verified the session token. SQL-level limits of this approach: Part 1 §6.4.
create or replace function app.claims() returns jsonb
language sql stable
set search_path = pg_catalog, public
as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

create or replace function app.uid() returns uuid
language sql stable
set search_path = pg_catalog, public
as $$ select nullif(app.claims() ->> 'sub', '')::uuid $$;

create or replace function app.aal() returns text
language sql stable
set search_path = pg_catalog, public
as $$ select coalesce(app.claims() ->> 'aal', 'aal1') $$;

create or replace function app.public_restaurant_id() returns uuid
language sql stable
set search_path = pg_catalog, public
as $$ select nullif(current_setting('app.public_restaurant_id', true), '')::uuid $$;
