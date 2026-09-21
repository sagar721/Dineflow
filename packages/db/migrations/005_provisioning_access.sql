-- 005_provisioning_access.sql — let a new restaurant's staff sign in before it
-- goes live.
--
-- Migration 002 scoped staff access to restaurants with status 'active'. That makes
-- onboarding impossible: the owner is invited while the restaurant is still
-- 'provisioning', and must sign in to fill in the profile that takes it live
-- (PRD US-02). Found by the onboarding tests, which returned 401 where they
-- expected a validation error.
--
-- 'provisioning' and 'active' are the two states in which staff may work.
-- 'suspended' and 'closed' still lock everyone out, which is the point of them.
-- Customers are unaffected: the public policies and QR resolution continue to
-- require 'active', so a restaurant that has not gone live cannot take orders.

create or replace function app.restaurant_id() returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select ru.restaurant_id
    from restaurant_users ru
    join restaurants r on r.id = ru.restaurant_id
   where ru.user_id = app.uid()
     and ru.status = 'active'
     and r.status in ('provisioning', 'active')
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
     and r.status in ('provisioning', 'active')
$$;
