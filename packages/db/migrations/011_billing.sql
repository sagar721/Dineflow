-- 011_billing.sql — bills and payments (PRD FR-070 … FR-082; BR-BILL-01 … 06,
-- BR-ORD-03/04). Design: docs/design/01-database.md §3.5 and §4.2.
--
-- Draft → Finalized → Void. A draft is a snapshot of one table's orders that only
-- a discount may change; finalizing allocates the next number in an unbroken
-- sequence and freezes everything; a finalized bill can only be voided. Payment
-- status is derived from payments, never stored. All money is integer minor units.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'bill_status') then
    create type bill_status as enum ('draft', 'finalized', 'void');
  end if;
  if not exists (select 1 from pg_type where typname = 'discount_type') then
    create type discount_type as enum ('percent', 'fixed');
  end if;
  if not exists (select 1 from pg_type where typname = 'payment_method') then
    create type payment_method as enum ('cash', 'card', 'upi', 'other');
  end if;
end$$;

-- ---------------------------------------------------------------- numbering
-- One continuous series per restaurant in v1 ('main'); the key allows more later.
create table if not exists bill_counters (
  restaurant_id uuid not null references restaurants(id),
  series        text not null,
  next_no       integer not null default 1 check (next_no >= 1),
  primary key (restaurant_id, series)
);

-- -------------------------------------------------------------------- bills
create table if not exists bills (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references restaurants(id),
  table_id             uuid not null,
  status               bill_status not null default 'draft',
  bill_series          text not null default 'main' check (bill_series ~ '^[a-z0-9_-]{1,20}$'),
  bill_no              integer check (bill_no >= 1),
  bill_ref             text check (length(bill_ref) between 1 and 30),
  -- Snapshot of how this bill is worked out, taken when it was generated (FR-074).
  currency             char(3) not null,
  prices_include_tax   boolean not null,
  service_charge_bps   integer not null check (service_charge_bps between 0 and 10000),
  rounding_mode        rounding_mode not null,
  -- Amounts (minor units).
  subtotal_minor       bigint not null check (subtotal_minor >= 0),
  discount_type        discount_type,
  discount_value       bigint check (discount_value >= 0),
  discount_minor       bigint not null default 0 check (discount_minor >= 0),
  discount_reason      text check (discount_reason = btrim(discount_reason) and length(discount_reason) between 3 and 200),
  service_charge_minor bigint not null default 0 check (service_charge_minor >= 0),
  tax_total_minor      bigint not null default 0 check (tax_total_minor >= 0),
  rounding_minor       bigint not null default 0 check (rounding_minor between -50 and 50),
  total_minor          bigint not null check (total_minor >= 0),
  -- Restaurant name, address, contact, tax registration number, footer — as at
  -- generation, refreshed once more at finalization, then frozen (FR-071).
  issuer_snapshot      jsonb not null,
  -- SHA-256 of the canonical bill text (Stage-2 condition 5.2), set at finalization.
  content_hash         bytea check (length(content_hash) = 32),
  created_by           uuid not null,
  created_at           timestamptz not null default now(),
  finalized_by         uuid,
  finalized_at         timestamptz,
  voided_by            uuid,
  voided_at            timestamptz,
  void_reason          text check (void_reason = btrim(void_reason) and length(void_reason) between 3 and 300),
  version              integer not null default 1,
  unique (id, restaurant_id),
  foreign key (table_id, restaurant_id) references dining_tables (id, restaurant_id),
  constraint bills_discount_within_subtotal check (discount_minor <= subtotal_minor),
  constraint bills_discount_shape check (
    (discount_type is null) = (discount_value is null)
    and (discount_type is null or discount_reason is not null)
    and (discount_type is not null or discount_minor = 0)),
  -- The arithmetic identity (design/01 §4.2), on every row, always.
  constraint bills_total_identity check (
    total_minor = subtotal_minor - discount_minor + service_charge_minor
                  + case when prices_include_tax then 0 else tax_total_minor end + rounding_minor),
  -- A number, reference, hash and finalizer exist exactly when the bill is issued.
  constraint bills_issued_shape check (
    (status = 'draft') = (bill_no is null) and (bill_no is null) = (bill_ref is null)
    and (status = 'draft') = (content_hash is null)
    and (status = 'draft') = (finalized_at is null) and (finalized_at is null) = (finalized_by is null)),
  constraint bills_void_shape check (
    (status = 'void') = (voided_at is not null) and (voided_at is null) = (voided_by is null)
    and (voided_at is null) = (void_reason is null))
);

create unique index if not exists ux_bills_number on bills (restaurant_id, bill_series, bill_no) where bill_no is not null;
create index if not exists ix_bills_status on bills (restaurant_id, status, created_at desc);
create index if not exists ix_bills_finalized on bills (restaurant_id, finalized_at);

-- --------------------------------------------------------- bill ↔ orders
create table if not exists bill_orders (
  bill_id       uuid not null,
  order_id      uuid not null,
  restaurant_id uuid not null references restaurants(id),
  -- Set when the bill is voided, freeing the order for a new bill (FR-077).
  voided        boolean not null default false,
  primary key (bill_id, order_id),
  foreign key (bill_id, restaurant_id) references bills (id, restaurant_id) on delete cascade,
  foreign key (order_id, restaurant_id) references orders (id, restaurant_id)
);

-- An order is on at most one live (draft or finalized) bill (BR-BILL-01).
create unique index if not exists ux_bill_orders_live on bill_orders (order_id) where not voided;

-- ------------------------------------------------------- lines and taxes
create table if not exists bill_lines (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id),
  bill_id          uuid not null,
  order_item_id    uuid not null,
  position         smallint not null check (position between 1 and 2000),
  name             text not null check (length(name) between 1 and 120),
  quantity         integer not null check (quantity between 1 and 99),
  unit_price_minor bigint not null check (unit_price_minor between 0 and 100000000),
  line_total_minor bigint not null check (line_total_minor = unit_price_minor * quantity),
  unique (id, restaurant_id),
  unique (bill_id, position),
  foreign key (bill_id, restaurant_id) references bills (id, restaurant_id) on delete cascade,
  foreign key (order_item_id, restaurant_id) references order_items (id, restaurant_id)
);
create index if not exists ix_bill_lines_bill on bill_lines (restaurant_id, bill_id);

create table if not exists bill_taxes (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id),
  bill_id       uuid not null,
  position      smallint not null check (position between 1 and 20),
  name          text not null check (length(name) between 1 and 40),
  rate_bps      integer not null check (rate_bps between 0 and 10000),
  taxable_minor bigint not null check (taxable_minor >= 0),
  amount_minor  bigint not null check (amount_minor >= 0),
  unique (bill_id, position),
  foreign key (bill_id, restaurant_id) references bills (id, restaurant_id) on delete cascade
);

-- ----------------------------------------------------------------- payments
-- Recorded, not processed (PRD §5.2). Append-only: a mistake is corrected by an
-- audited reversal, never by editing or deleting (FR-081).
create table if not exists payments (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id),
  bill_id         uuid not null,
  method          payment_method not null,
  -- Must equal the bill total (BR-BILL-06); checked by the guard below. Zero is
  -- allowed only because a bill discounted to zero must still be closable.
  amount_minor    bigint not null check (amount_minor >= 0),
  reference       text check (reference = btrim(reference) and length(reference) between 1 and 80),
  recorded_by     uuid not null,
  recorded_at     timestamptz not null default now(),
  reversed_at     timestamptz,
  reversed_by     uuid,
  reversal_reason text check (reversal_reason = btrim(reversal_reason) and length(reversal_reason) between 3 and 300),
  unique (id, restaurant_id),
  foreign key (bill_id, restaurant_id) references bills (id, restaurant_id),
  constraint payments_reversal_shape check (
    (reversed_at is null) = (reversed_by is null) and (reversed_at is null) = (reversal_reason is null))
);

-- At most one live payment per bill: no partial or double payment (FR-081, Q-08).
create unique index if not exists ux_payments_live on payments (bill_id) where reversed_at is null;
create index if not exists ix_payments_recorded on payments (restaurant_id, recorded_at);

-- ---------------------------------------------------------------- functions
-- The next bill number for the caller's restaurant. No restaurant argument: a
-- caller can only number its own bills; only billing roles may draw a number.
create or replace function app.next_bill_no(p_series text) returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  rid uuid := app.restaurant_id();
  n integer;
begin
  if rid is null or app.role() not in ('owner', 'manager', 'billing') then
    raise exception 'not permitted to issue bill numbers' using errcode = 'insufficient_privilege';
  end if;
  insert into bill_counters (restaurant_id, series, next_no) values (rid, p_series, 2)
  on conflict (restaurant_id, series) do update set next_no = bill_counters.next_no + 1
  returning next_no - 1 into n;
  return n;
end$$;
revoke all on function app.next_bill_no(text) from public;
grant execute on function app.next_bill_no(text) to dineflow_staff;

-- Whether p_no is the number most recently drawn for this series — i.e. it came
-- from the counter, in order, so the sequence has no gaps and no inventions.
create or replace function app.bill_no_is_current(p_restaurant uuid, p_series text, p_no integer) returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (select 1 from bill_counters
                  where restaurant_id = p_restaurant and series = p_series and next_no - 1 = p_no)
$$;
revoke all on function app.bill_no_is_current(uuid, text, integer) from public;
grant execute on function app.bill_no_is_current(uuid, text, integer) to dineflow_staff;

-- Which live bill, if any, an order is on: 'finalized', 'draft' or 'none'.
-- SECURITY DEFINER so the order guard can ask for kitchen staff, who may not
-- read bills themselves.
create or replace function app.order_bill_state(p_order uuid) returns text
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select coalesce((
    select b.status::text from bill_orders bo join bills b on b.id = bo.bill_id
     where bo.order_id = p_order and not bo.voided and b.status in ('draft', 'finalized')
     limit 1), 'none')
$$;
revoke all on function app.order_bill_state(uuid) from public;
grant execute on function app.order_bill_state(uuid) to dineflow_staff;

-- -------------------------------------------------------------- bill guard
-- Enforces the lifecycle in the database (FR-076, BR-BILL-02). The immutability of
-- issued bills applies to everyone, the table owner included; the role rules
-- apply to requests (dineflow_staff).
create or replace function app.bills_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  is_staff boolean := current_user = 'dineflow_staff';
  actor staff_role := app.role();
  cap integer;
  fixed_cols text[] := array['id', 'restaurant_id', 'table_id', 'bill_series', 'currency', 'prices_include_tax',
                             'service_charge_bps', 'rounding_mode', 'subtotal_minor', 'created_by', 'created_at'];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'only a draft bill can be discarded' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if exists (select 1 from unnest(fixed_cols) c where to_jsonb(new) -> c is distinct from to_jsonb(old) -> c) then
    raise exception 'what a bill was generated from cannot be changed' using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'void' then
    raise exception 'a void bill cannot be changed' using errcode = 'insufficient_privilege';
  end if;

  if old.status = 'finalized' then
    -- The one change left: voiding (FR-077). Everything else is frozen.
    if new.status <> 'void'
       or (to_jsonb(new) - array['status', 'voided_by', 'voided_at', 'void_reason', 'version'])
          is distinct from (to_jsonb(old) - array['status', 'voided_by', 'voided_at', 'void_reason', 'version']) then
      raise exception 'a finalized bill cannot be changed, only voided' using errcode = 'insufficient_privilege';
    end if;
    if is_staff and actor not in ('owner', 'manager') then
      raise exception 'only an owner or manager may void a bill' using errcode = 'insufficient_privilege';
    end if;
    if exists (select 1 from payments p where p.bill_id = old.id and p.reversed_at is null) then
      raise exception 'reverse the payment before voiding this bill' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- A draft.
  if new.status = 'void' then
    raise exception 'a draft is discarded, not voided' using errcode = 'check_violation';
  end if;
  if (new.discount_type, new.discount_value, new.discount_minor, new.discount_reason)
     is distinct from (old.discount_type, old.discount_value, old.discount_minor, old.discount_reason) then
    if is_staff and actor not in ('owner', 'manager') then
      raise exception 'only an owner or manager may apply a discount' using errcode = 'insufficient_privilege';
    end if;
    -- Managers are capped (Q-12); owners are not.
    if is_staff and actor = 'manager' then
      select manager_discount_cap_bps into cap from restaurant_settings where restaurant_id = new.restaurant_id;
      if new.discount_minor::numeric * 10000 > coalesce(cap, 0)::numeric * new.subtotal_minor then
        raise exception 'the discount is above the manager limit' using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;

  if new.status = 'finalized' then
    if not app.bill_no_is_current(new.restaurant_id, new.bill_series, new.bill_no) then
      raise exception 'a bill number must come from the counter, in order' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from bill_orders where bill_id = new.id) then
      raise exception 'a bill needs at least one order' using errcode = 'check_violation';
    end if;
    if exists (select 1 from bill_orders bo join orders o on o.id = bo.order_id
                where bo.bill_id = new.id and o.status = 'cancelled') then
      raise exception 'a cancelled order cannot be billed' using errcode = 'check_violation';
    end if;
    if new.subtotal_minor <> (select coalesce(sum(line_total_minor), 0) from bill_lines where bill_id = new.id)
       or new.tax_total_minor <> (select coalesce(sum(amount_minor), 0) from bill_taxes where bill_id = new.id) then
      raise exception 'bill totals do not match its lines and taxes' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end$$;

drop trigger if exists trg_bills_guard on bills;
create trigger trg_bills_guard before update or delete on bills
  for each row execute function app.bills_guard();

-- Voiding a bill frees its orders for a new bill (FR-077).
create or replace function app.bill_void_releases_orders() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'void' and old.status <> 'void' then
    update bill_orders set voided = true where bill_id = new.id and not voided;
  end if;
  return null;
end$$;

drop trigger if exists trg_bill_void_releases_orders on bills;
create trigger trg_bill_void_releases_orders after update of status on bills
  for each row execute function app.bill_void_releases_orders();

-- Lines, taxes and order links change only while their bill is a draft; the only
-- later change is an order link being released when its bill is voided.
create or replace function app.bill_children_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  parent bill_status;
begin
  select status into parent from bills
   where id = case when tg_op = 'DELETE' then old.bill_id else new.bill_id end;
  if tg_op = 'DELETE' then
    -- No parent: it is being deleted, which its own guard allowed (drafts only).
    if parent is not null and parent <> 'draft' then
      raise exception 'an issued bill cannot be changed' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if parent is distinct from 'draft' then
      raise exception 'lines can be added only to a draft bill' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  -- UPDATE: only releasing an order link of a voided bill. (Nested, because only
  -- bill_orders has a `voided` field; PL/pgSQL would resolve it on any table.)
  if tg_table_name = 'bill_orders' and parent = 'void' then
    if (to_jsonb(old) ->> 'voided')::boolean = false and (to_jsonb(new) ->> 'voided')::boolean = true
       and new.bill_id = old.bill_id and to_jsonb(new) -> 'order_id' = to_jsonb(old) -> 'order_id'
       and new.restaurant_id = old.restaurant_id then
      return new;
    end if;
  end if;
  raise exception 'an issued bill cannot be changed' using errcode = 'insufficient_privilege';
end$$;

drop trigger if exists trg_bill_lines_guard on bill_lines;
create trigger trg_bill_lines_guard before insert or update or delete on bill_lines
  for each row execute function app.bill_children_guard();
drop trigger if exists trg_bill_taxes_guard on bill_taxes;
create trigger trg_bill_taxes_guard before insert or update or delete on bill_taxes
  for each row execute function app.bill_children_guard();
drop trigger if exists trg_bill_orders_guard on bill_orders;
create trigger trg_bill_orders_guard before insert or update or delete on bill_orders
  for each row execute function app.bill_children_guard();

-- Payments: only on a finalized bill, only for its exact total, never edited except
-- to be reversed once, never deleted (FR-080, FR-081, BR-BILL-06).
create or replace function app.payments_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  is_staff boolean := current_user = 'dineflow_staff';
  actor staff_role := app.role();
  bill_state bill_status;
  bill_total bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'payments are never deleted; reverse it instead' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    -- FOR SHARE: waits for a concurrent void to commit, then sees it.
    select status, total_minor into bill_state, bill_total from bills where id = new.bill_id for share;
    if bill_state is distinct from 'finalized' then
      raise exception 'payment can be recorded only for a finalized bill' using errcode = 'check_violation';
    end if;
    if new.amount_minor <> bill_total then
      raise exception 'the payment must equal the bill total' using errcode = 'check_violation';
    end if;
    if new.reversed_at is not null then
      raise exception 'a payment cannot be recorded already reversed' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- UPDATE: reversal only, once.
  if old.reversed_at is not null or new.reversed_at is null
     or (to_jsonb(new) - array['reversed_at', 'reversed_by', 'reversal_reason'])
        is distinct from (to_jsonb(old) - array['reversed_at', 'reversed_by', 'reversal_reason']) then
    raise exception 'a payment can only be reversed, once' using errcode = 'insufficient_privilege';
  end if;
  if is_staff and actor not in ('owner', 'manager') then
    raise exception 'only an owner or manager may reverse a payment' using errcode = 'insufficient_privilege';
  end if;
  return new;
end$$;

drop trigger if exists trg_payments_guard on payments;
create trigger trg_payments_guard before insert or update or delete on payments
  for each row execute function app.payments_guard();

-- ------------------------------------------- orders: billing-aware rules
-- BR-ORD-04: an order on a finalized, non-void bill cannot be cancelled.
-- BR-ORD-03: served → ready only while the order is on no live bill.
-- Replaces the 010 guard with the same rules plus these two.
create or replace function app.order_update_guard() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  actor staff_role := app.role();
  billed text;
begin
  if new.id is distinct from old.id or new.restaurant_id is distinct from old.restaurant_id
     or new.table_id is distinct from old.table_id or new.order_no is distinct from old.order_no
     or new.order_ref is distinct from old.order_ref or new.subtotal_minor is distinct from old.subtotal_minor
     or new.special_instructions is distinct from old.special_instructions
     or new.public_token_hash is distinct from old.public_token_hash
     or new.idempotency_key is distinct from old.idempotency_key or new.request_hash is distinct from old.request_hash
     or new.placed_at is distinct from old.placed_at then
    raise exception 'a placed order cannot be edited' using errcode = 'insufficient_privilege';
  end if;

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
      billed := app.order_bill_state(new.id);
      if new.status = 'cancelled' and billed = 'finalized' then
        raise exception 'an order on a finalized bill cannot be cancelled' using errcode = 'check_violation';
      end if;
      if old.status = 'served' and new.status = 'ready' and billed <> 'none' then
        raise exception 'an order on a bill cannot be taken back from served' using errcode = 'check_violation';
      end if;
    end if;
    new.status_updated_at := now();
  end if;

  new.updated_at := now();
  return new;
end$$;

-- ------------------------------------------------------------------ privileges
-- Billing is for owners, managers and billing staff; kitchen has no access at all.
grant select, insert, delete on bills, bill_lines, bill_taxes, bill_orders to dineflow_staff;
grant update (status, bill_no, bill_ref, discount_type, discount_value, discount_minor, discount_reason,
              service_charge_minor, tax_total_minor, rounding_minor, total_minor, issuer_snapshot, content_hash,
              finalized_by, finalized_at, voided_by, voided_at, void_reason, version) on bills to dineflow_staff;
grant update (voided) on bill_orders to dineflow_staff;
grant select, insert on payments to dineflow_staff;
grant update (reversed_at, reversed_by, reversal_reason) on payments to dineflow_staff;
-- bill_counters: no grants; only app.next_bill_no() touches it.

alter table bill_counters enable row level security;
alter table bill_counters force row level security;
alter table bills         enable row level security;
alter table bills         force row level security;
alter table bill_orders   enable row level security;
alter table bill_orders   force row level security;
alter table bill_lines    enable row level security;
alter table bill_lines    force row level security;
alter table bill_taxes    enable row level security;
alter table bill_taxes    force row level security;
alter table payments      enable row level security;
alter table payments      force row level security;

-- ------------------------------------------------------------------ policies
-- The billing roles of the bill's own restaurant; support access reads only.
do $$
declare
  t text;
begin
  foreach t in array array['bills', 'bill_orders', 'bill_lines', 'bill_taxes', 'payments'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format($p$create policy %I on %I for select to dineflow_staff
      using ((restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'billing'))
             or (select app.has_support_grant(restaurant_id)))$p$, t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format($p$create policy %I on %I for insert to dineflow_staff
      with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'billing'))$p$,
      t || '_insert', t);
  end loop;
  foreach t in array array['bills', 'bill_orders', 'payments'] loop
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format($p$create policy %I on %I for update to dineflow_staff
      using (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'billing'))
      with check (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'billing'))$p$,
      t || '_update', t);
  end loop;
  foreach t in array array['bills', 'bill_orders', 'bill_lines', 'bill_taxes'] loop
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format($p$create policy %I on %I for delete to dineflow_staff
      using (restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'billing'))$p$,
      t || '_delete', t);
  end loop;
end$$;

-- New bills are drafts, created by the caller; payments are recorded by the caller.
drop policy if exists bills_insert on bills;
create policy bills_insert on bills for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id())
              and (select app.role()) in ('owner', 'manager', 'billing')
              and status = 'draft' and created_by = (select app.uid()));

drop policy if exists payments_insert on payments;
create policy payments_insert on payments for insert to dineflow_staff
  with check (restaurant_id = (select app.restaurant_id())
              and (select app.role()) in ('owner', 'manager', 'billing')
              and recorded_by = (select app.uid()));
