-- 010_order_workflow.sql — staff order workflow (PRD FR-050 … FR-059).
-- Design: docs/design/01-database.md §3.4 (order_status_history) and §4.1 (the
-- order state machine, enforced by a trigger as well as by the API).
--
-- Staff may now move an order through its statuses, cancel it with a reason,
-- revert it one step (owner and manager), and keep an internal note. Every status
-- change leaves a history row that nobody can edit or delete.

-- ------------------------------------------------------------ order columns
alter table orders add column if not exists cancel_reason text;
alter table orders add column if not exists cancelled_by  uuid;
alter table orders add column if not exists staff_note    text;
-- Moves whenever anything staff can see changes, for the live-orders cursor.
alter table orders add column if not exists updated_at    timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'orders'::regclass and conname = 'orders_cancel_reason_check') then
    alter table orders add constraint orders_cancel_reason_check
      check (cancel_reason = btrim(cancel_reason) and length(cancel_reason) between 3 and 300);
  end if;
  -- A cancelled order always says why, and only a cancelled order has a reason.
  if not exists (select 1 from pg_constraint where conrelid = 'orders'::regclass and conname = 'orders_cancelled_has_reason') then
    alter table orders add constraint orders_cancelled_has_reason
      check ((status = 'cancelled') = (cancel_reason is not null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'orders'::regclass and conname = 'orders_staff_note_check') then
    alter table orders add constraint orders_staff_note_check
      check (staff_note = btrim(staff_note) and length(staff_note) between 1 and 500);
  end if;
end$$;

create index if not exists ix_orders_updated on orders (restaurant_id, updated_at);
create index if not exists ix_orders_placed on orders (restaurant_id, placed_at desc, id desc);

-- ----------------------------------------------------------- status history
-- Append-only (FR-055). Written only by the trigger below, so no code path can
-- change a status without leaving a row.
create table if not exists order_status_history (
  id              bigint generated always as identity primary key,
  restaurant_id   uuid not null references restaurants(id),
  order_id        uuid not null,
  from_status     order_status,                 -- null for the order being placed
  to_status       order_status not null,
  changed_by      uuid,                         -- null: the customer placing it
  changed_by_role staff_role,
  reason          text check (length(reason) <= 300),
  created_at      timestamptz not null default now(),
  foreign key (order_id, restaurant_id) references orders (id, restaurant_id)
);

create index if not exists ix_order_status_history_order on order_status_history (restaurant_id, order_id, id);

drop trigger if exists trg_order_status_history_append_only on order_status_history;
create trigger trg_order_status_history_append_only before update or delete on order_status_history
  for each row execute function app.deny_mutation();

-- ------------------------------------------------------------ the guard
-- Every update to an order passes through here (design/01 §4.1). It mirrors the
-- shared TypeScript state machine; a contract test asserts the two agree for
-- every (role, from, to).
create or replace function app.order_transition_allowed(p_role staff_role, p_from order_status, p_to order_status)
returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$
  select (p_from, p_to, p_role) in (
    ('pending',   'accepted',  'owner'), ('pending',   'accepted',  'manager'), ('pending',   'accepted',  'kitchen'),
    ('accepted',  'preparing', 'owner'), ('accepted',  'preparing', 'manager'), ('accepted',  'preparing', 'kitchen'),
    ('preparing', 'ready',     'owner'), ('preparing', 'ready',     'manager'), ('preparing', 'ready',     'kitchen'),
    ('ready',     'served',    'owner'), ('ready',     'served',    'manager'), ('ready',     'served',    'billing'),
    ('pending',   'cancelled', 'owner'), ('pending',   'cancelled', 'manager'), ('pending',   'cancelled', 'kitchen'),
    ('accepted',  'cancelled', 'owner'), ('accepted',  'cancelled', 'manager'), ('accepted',  'cancelled', 'kitchen'),
    ('preparing', 'cancelled', 'owner'), ('preparing', 'cancelled', 'manager')
  )
$$;

-- One step back, owner and manager only (FR-053, BR-ORD-03). Cancelled is never
-- reverted. Served → ready must also be off any live bill; bills do not exist yet,
-- and the billing module extends this check when they do.
create or replace function app.order_revert_allowed(p_role staff_role, p_from order_status, p_to order_status)
returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$
  select p_role in ('owner', 'manager') and (p_from, p_to) in (
    ('accepted', 'pending'), ('preparing', 'accepted'), ('ready', 'preparing'), ('served', 'ready')
  )
$$;

grant execute on function app.order_transition_allowed(staff_role, order_status, order_status) to dineflow_staff;
grant execute on function app.order_revert_allowed(staff_role, order_status, order_status) to dineflow_staff;

-- The reason the API gives for this transaction's status change (cancel or revert).
create or replace function app.status_reason() returns text
language sql stable
set search_path = pg_catalog, public
as $$ select nullif(btrim(current_setting('app.status_reason', true)), '') $$;

grant execute on function app.status_reason() to dineflow_staff;

create or replace function app.order_update_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  actor staff_role := app.role();
begin
  -- What was placed is fixed: only the workflow columns may change.
  if new.id is distinct from old.id or new.restaurant_id is distinct from old.restaurant_id
     or new.table_id is distinct from old.table_id or new.order_no is distinct from old.order_no
     or new.order_ref is distinct from old.order_ref or new.subtotal_minor is distinct from old.subtotal_minor
     or new.special_instructions is distinct from old.special_instructions
     or new.public_token_hash is distinct from old.public_token_hash
     or new.idempotency_key is distinct from old.idempotency_key or new.request_hash is distinct from old.request_hash
     or new.placed_at is distinct from old.placed_at then
    raise exception 'a placed order cannot be edited' using errcode = 'insufficient_privilege';
  end if;

  -- Who cancelled an order, and why, is part of its record: set once, by the
  -- cancelling change itself, and never edited afterwards. (Cancelled is final and
  -- never reverted, so nothing legitimate ever needs to change them.)
  if current_user = 'dineflow_staff' then
    if old.status = 'cancelled'
       and (new.cancel_reason is distinct from old.cancel_reason or new.cancelled_by is distinct from old.cancelled_by) then
      raise exception 'a cancellation''s reason and author cannot be changed' using errcode = 'insufficient_privilege';
    end if;
    if new.status <> 'cancelled' and new.cancelled_by is distinct from old.cancelled_by then
      raise exception 'cancelled_by is set only by cancelling' using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.status is distinct from old.status then
    -- Requests run as dineflow_staff with a resolved role. Anything else reaching
    -- here (maintenance by the table owner) still gets the history row below.
    if current_user = 'dineflow_staff' then
      if actor is null then
        raise exception 'no staff role for this change' using errcode = 'insufficient_privilege';
      end if;
      if not (app.order_transition_allowed(actor, old.status, new.status)
              or app.order_revert_allowed(actor, old.status, new.status)) then
        raise exception 'order cannot go from % to % for this role', old.status, new.status
          using errcode = 'check_violation';
      end if;
      if (new.status = 'cancelled' or app.order_revert_allowed(actor, old.status, new.status))
         and app.status_reason() is null then
        raise exception 'a reason is required' using errcode = 'check_violation';
      end if;
    end if;
    new.status_updated_at := now();
  end if;

  new.updated_at := now();
  return new;
end$$;

drop trigger if exists trg_order_update_guard on orders;
create trigger trg_order_update_guard before update on orders
  for each row execute function app.order_update_guard();

-- Writes the history row for every placement and status change. SECURITY DEFINER
-- because nobody — staff or customer — may write history directly.
create or replace function app.record_order_status() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    insert into order_status_history (restaurant_id, order_id, from_status, to_status)
    values (new.restaurant_id, new.id, null, new.status);
  elsif new.status is distinct from old.status then
    insert into order_status_history (restaurant_id, order_id, from_status, to_status, changed_by, changed_by_role, reason)
    values (new.restaurant_id, new.id, old.status, new.status, app.uid(), app.role(), app.status_reason());
  end if;
  return null;
end$$;

revoke all on function app.record_order_status() from public;

drop trigger if exists trg_order_status_history on orders;
create trigger trg_order_status_history after insert or update of status on orders
  for each row execute function app.record_order_status();

-- Existing orders get their "placed" row, so every order has a complete history.
insert into order_status_history (restaurant_id, order_id, from_status, to_status, created_at)
select o.restaurant_id, o.id, null, 'pending', o.placed_at
  from orders o
 where not exists (select 1 from order_status_history h where h.order_id = o.id);

-- ------------------------------------------------------------------ privileges
-- Staff may change only the workflow columns; the guard decides which changes.
grant update (status, cancel_reason, cancelled_by, staff_note, version) on orders to dineflow_staff;
grant select on order_status_history to dineflow_staff;

alter table order_status_history enable row level security;
alter table order_status_history force row level security;

-- Every staff role of the restaurant may act on its orders; which transitions each
-- may make is the guard's decision. Support access stays read-only.
drop policy if exists orders_staff_update on orders;
create policy orders_staff_update on orders for update to dineflow_staff
  using (restaurant_id = (select app.restaurant_id()))
  with check (restaurant_id = (select app.restaurant_id()));

drop policy if exists order_status_history_staff_read on order_status_history;
create policy order_status_history_staff_read on order_status_history for select to dineflow_staff
  using (restaurant_id = (select app.restaurant_id())
         or (select app.has_support_grant(restaurant_id)));
