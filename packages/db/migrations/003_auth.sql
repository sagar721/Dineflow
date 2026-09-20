-- 003_auth.sql — staff invitations and brute-force lockouts.
-- Design: docs/design/02-api-auth-tenancy.md §3.3, §7; PRD FR-101, FR-103.
--
-- Identity itself (passwords, tokens, MFA factors) lives in Supabase Auth, never
-- here (FR-100). These two tables hold only what is ours: who was invited to which
-- restaurant, and how many times sign-in has failed.

-- ------------------------------------------------------------------ invitations
create table if not exists invitations (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  email         citext not null,
  role          staff_role not null,
  -- SHA-256 of a 256-bit random token. The token itself exists only in the emailed
  -- link, so a database leak cannot be used to accept an invitation.
  token_hash    bytea not null unique,
  invited_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_by   uuid references auth.users(id),
  revoked_at    timestamptz,
  revoked_by    uuid references auth.users(id),
  -- 72 hours by default (FR-101); the upper bound stops a caller quietly minting a
  -- long-lived invitation.
  constraint invitation_window check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  constraint invitation_not_both check (accepted_at is null or revoked_at is null)
);

create index if not exists ix_invitations_restaurant on invitations (restaurant_id, created_at desc);
-- One live invitation per email per restaurant: re-inviting revokes and re-issues,
-- so two valid links can never exist for the same person.
create unique index if not exists ux_invitations_live
  on invitations (restaurant_id, email)
  where accepted_at is null and revoked_at is null;

drop trigger if exists trg_invitations_touch on invitations;

-- An invitation is a record of an authorization decision: it may be accepted or
-- revoked, but its restaurant, role, email and token may never be edited. Without
-- this, an attacker with UPDATE could re-point a pending invitation at another
-- restaurant or raise its role.
create or replace function app.invitation_immutable() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id
     or new.email is distinct from old.email
     or new.role is distinct from old.role
     or new.token_hash is distinct from old.token_hash
     or new.invited_by is distinct from old.invited_by
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'invitations may only be accepted or revoked, not edited'
      using errcode = 'insufficient_privilege';
  end if;
  if old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at then
    raise exception 'an accepted invitation cannot be re-accepted'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_invitation_immutable on invitations;
create trigger trg_invitation_immutable before update on invitations
  for each row execute function app.invitation_immutable();

-- --------------------------------------------------------------- auth lockouts
-- Brute-force state (FR-103). Keyed by a hash of the identifier so the table does
-- not become a list of which email addresses exist, and by IP for spray attacks.
create table if not exists auth_lockouts (
  key_hash      bytea primary key,
  key_kind      text not null check (key_kind in ('account', 'ip', 'account_ip')),
  failures      integer not null default 0 check (failures >= 0),
  first_failure timestamptz not null default now(),
  last_failure  timestamptz not null default now(),
  locked_until  timestamptz
);

create index if not exists ix_auth_lockouts_expiry on auth_lockouts (locked_until);

-- ------------------------------------------------------------------ privileges
-- Invitations are tenant data and follow the usual pattern. Lockout rows are not
-- tenant data and are never reachable from a request role: only the API's own
-- login role touches them, through the functions below, because the caller is by
-- definition not yet authenticated.
grant select, insert, update on invitations to dineflow_staff;

alter table invitations   enable row level security;
alter table invitations   force row level security;
alter table auth_lockouts enable row level security;
alter table auth_lockouts force row level security;

-- ---------------------------------------------------------------- RLS policies
drop policy if exists invitations_read on invitations;
create policy invitations_read on invitations for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         and (select app.role()) in ('owner', 'manager'));

-- A manager may invite kitchen and billing staff only; an owner may invite anyone.
-- The same rule is enforced in the API, and here so that a bug there cannot grant
-- a role the inviter does not hold (FR-108, FR-109).
drop policy if exists invitations_create on invitations;
create policy invitations_create on invitations for insert to dineflow_staff
  with check (
    restaurant_id = (select app.restaurant_id())
    and invited_by = (select app.uid())
    and ((select app.role()) = 'owner'
         or ((select app.role()) = 'manager' and role in ('kitchen', 'billing')))
  );

drop policy if exists invitations_revoke on invitations;
create policy invitations_revoke on invitations for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         and (select app.role()) in ('owner', 'manager'))
  with check (restaurant_id = (select app.restaurant_id())
         and (select app.role()) in ('owner', 'manager'));

-- ------------------------------------------------------- unauthenticated paths
-- Accepting an invitation and recording a failed login both happen before there is
-- a session, so they cannot run under a request role. They are SECURITY DEFINER
-- functions with a narrow contract, executable only by the API's login role.

-- Returns the invitation matching a token hash if it is live, else nothing. It
-- deliberately returns the same empty result for unknown, expired, revoked and
-- already-accepted tokens so the caller cannot tell them apart.
create or replace function app.lookup_invitation(p_token_hash bytea)
returns table (id uuid, restaurant_id uuid, email citext, role staff_role)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select i.id, i.restaurant_id, i.email, i.role
    from invitations i
    join restaurants r on r.id = i.restaurant_id
   where i.token_hash = p_token_hash
     and i.accepted_at is null
     and i.revoked_at is null
     and i.expires_at > now()
     and r.status = 'active'
$$;

-- Accepts an invitation and creates the membership in one transaction. Returns the
-- new membership id, or null if the invitation was consumed concurrently — the
-- partial unique index and this guard together make double acceptance impossible.
create or replace function app.accept_invitation(
  p_token_hash bytea,
  p_user_id uuid,
  p_display_name text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  inv invitations%rowtype;
  membership_id uuid;
begin
  select * into inv
    from invitations
   where token_hash = p_token_hash
     and accepted_at is null
     and revoked_at is null
     and expires_at > now()
   for update;

  if not found then
    return null;
  end if;

  insert into restaurant_users (restaurant_id, user_id, role, status, email, display_name, created_by)
  values (inv.restaurant_id, p_user_id, inv.role, 'active', inv.email, p_display_name, inv.invited_by)
  returning id into membership_id;

  update invitations
     set accepted_at = now(), accepted_by = p_user_id
   where id = inv.id;

  insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary)
  values (inv.restaurant_id, p_user_id, inv.role::text, 'auth.invitation.accepted',
          'invitation', inv.id::text,
          jsonb_build_object('role', inv.role, 'invited_by', inv.invited_by));

  return membership_id;
end$$;

-- Records a failed sign-in attempt and returns the resulting lock expiry, if any.
-- Back-off is exponential in the number of failures, capped, so a slow attacker is
-- slowed further while a person who mistypes twice is not locked out for an hour.
create or replace function app.register_auth_failure(
  p_key_hash bytea,
  p_key_kind text,
  p_threshold integer,
  p_window interval
) returns timestamptz
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  row auth_lockouts%rowtype;
  lock_for interval;
begin
  insert into auth_lockouts (key_hash, key_kind, failures)
  values (p_key_hash, p_key_kind, 1)
  on conflict (key_hash) do update
    set failures = case
          when auth_lockouts.last_failure < now() - p_window then 1
          else auth_lockouts.failures + 1
        end,
        first_failure = case
          when auth_lockouts.last_failure < now() - p_window then now()
          else auth_lockouts.first_failure
        end,
        last_failure = now()
  returning * into row;

  if row.failures >= p_threshold then
    lock_for := least(
      interval '15 minutes' * power(2, row.failures - p_threshold),
      interval '1 hour'
    );
    update auth_lockouts set locked_until = now() + lock_for where key_hash = p_key_hash
    returning locked_until into row.locked_until;
  end if;

  return row.locked_until;
end$$;

create or replace function app.check_auth_lock(p_key_hash bytea) returns timestamptz
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select locked_until from auth_lockouts
   where key_hash = p_key_hash and locked_until is not null and locked_until > now()
$$;

create or replace function app.clear_auth_failures(p_key_hash bytea) returns void
language sql security definer
set search_path = pg_catalog, public
as $$
  delete from auth_lockouts where key_hash = p_key_hash
$$;

-- Writes an audit row when there is no request context yet (failed logins, lockouts,
-- password resets). Restricted to authentication events so it cannot become a
-- general-purpose way to write audit rows without a session.
create or replace function app.record_auth_event(
  p_restaurant_id uuid,
  p_actor_user_id uuid,
  p_action text,
  p_summary jsonb,
  p_ip inet,
  p_user_agent text,
  p_request_id text
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_action !~ '^auth\.' then
    raise exception 'record_auth_event only accepts auth.* actions, got %', p_action
      using errcode = 'insufficient_privilege';
  end if;
  insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type,
                         entity_id, summary, ip, user_agent, request_id)
  values (p_restaurant_id, p_actor_user_id, null, p_action, 'auth',
          coalesce(p_actor_user_id::text, 'anonymous'), coalesce(p_summary, '{}'::jsonb),
          p_ip, p_user_agent, p_request_id);
end$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'app.lookup_invitation(bytea)',
    'app.accept_invitation(bytea, uuid, text)',
    'app.register_auth_failure(bytea, text, integer, interval)',
    'app.check_auth_lock(bytea)',
    'app.clear_auth_failures(bytea)',
    'app.record_auth_event(uuid, uuid, text, jsonb, inet, text, text)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to dineflow_api', fn);
  end loop;
end$$;
