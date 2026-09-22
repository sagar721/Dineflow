-- 012_billing_ledger.sql — the billing ledger (Stage-2 conditions 5.1–5.3; approved
-- billing decision 9).
--
-- Every billing event — a draft created, discounted or discarded; a bill finalized
-- or voided; a payment recorded or reversed; a PDF generated or a copy printed — is
-- appended here by triggers, in the same transaction as the change itself, so no
-- code path can change a bill without leaving an entry. Entries are chained per
-- restaurant: each entry's hash covers its content and the previous entry's hash,
-- so editing, deleting or reordering any entry breaks every hash after it. The
-- verifier (packages/db/src/billing-ledger.ts) recomputes the chain and checks each
-- finalized bill's content hash against its bill.
--
-- Not built here (deferred by decision 9): external anchoring of chain heads, the
-- weekly email, and a reconciliation/exception UI.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'bill_ledger_event') then
    create type bill_ledger_event as enum (
      'bill_created', 'discount_applied', 'draft_discarded', 'bill_finalized', 'bill_voided',
      'payment_recorded', 'payment_reversed', 'pdf_generated', 'bill_printed');
  end if;
end$$;

-- ---------------------------------------------------------------------- tables
create table if not exists bill_ledger (
  id            bigint generated always as identity primary key,
  restaurant_id uuid not null references restaurants(id),
  seq           bigint not null check (seq >= 1),
  event         bill_ledger_event not null,
  -- No foreign key: a discarded draft is deleted, and its entries must remain.
  bill_id       uuid not null,
  payment_id    uuid,
  -- The bill's content hash, for bill_finalized (and copies, which name the hash
  -- the copy was made from).
  content_hash  bytea check (length(content_hash) = 32),
  payload       jsonb not null default '{}',
  actor_user_id uuid,
  actor_role    staff_role,
  created_at    timestamptz not null default clock_timestamp(),
  prev_hash     bytea not null check (length(prev_hash) = 32),
  entry_hash    bytea not null check (length(entry_hash) = 32),
  unique (restaurant_id, seq)
);
create index if not exists ix_bill_ledger_bill on bill_ledger (restaurant_id, bill_id, seq);

-- The chain head per restaurant: the last sequence number and hash. Appends lock
-- this row, so entries of one restaurant are numbered and chained one at a time.
create table if not exists bill_ledger_heads (
  restaurant_id uuid primary key references restaurants(id),
  seq           bigint not null,
  last_hash     bytea not null check (length(last_hash) = 32)
);

drop trigger if exists trg_bill_ledger_append_only on bill_ledger;
create trigger trg_bill_ledger_append_only before update or delete on bill_ledger
  for each row execute function app.deny_mutation();

-- ------------------------------------------------------------------ hashing
-- The exact text an entry's hash covers. The verifier rebuilds it from the stored
-- columns with this same function, and independently in TypeScript.
create or replace function app.bill_ledger_entry_text(
  p_restaurant uuid, p_seq bigint, p_event bill_ledger_event, p_bill uuid, p_payment uuid,
  p_content_hash bytea, p_payload jsonb, p_actor uuid, p_role staff_role, p_at timestamptz)
returns text
language sql immutable
set search_path = pg_catalog, public
as $$
  select concat_ws('|', 'v1', p_restaurant::text, p_seq::text, p_event::text, p_bill::text,
                   coalesce(p_payment::text, ''), coalesce(encode(p_content_hash, 'hex'), ''),
                   coalesce(p_actor::text, ''), coalesce(p_role::text, ''),
                   (extract(epoch from p_at) * 1000000)::bigint::text, p_payload::text)
$$;

-- Appends one entry. Not SECURITY DEFINER and granted to nobody: it runs only
-- inside the definer triggers below (and record_bill_copy), as their owner.
create or replace function app.bill_ledger_append(
  p_restaurant uuid, p_event bill_ledger_event, p_bill uuid, p_payment uuid, p_content_hash bytea, p_payload jsonb)
returns bigint
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  head bill_ledger_heads%rowtype;
  next_seq bigint;
  prev bytea;
  at timestamptz := clock_timestamp();
  actor uuid := app.uid();
  actor_role staff_role := app.role();
  entry bytea;
begin
  insert into bill_ledger_heads (restaurant_id, seq, last_hash)
  values (p_restaurant, 0, decode(repeat('00', 32), 'hex'))
  on conflict (restaurant_id) do nothing;
  select * into head from bill_ledger_heads where restaurant_id = p_restaurant for update;
  next_seq := head.seq + 1;
  prev := head.last_hash;
  entry := sha256(prev || convert_to(app.bill_ledger_entry_text(
    p_restaurant, next_seq, p_event, p_bill, p_payment, p_content_hash, p_payload, actor, actor_role, at), 'UTF8'));
  insert into bill_ledger (restaurant_id, seq, event, bill_id, payment_id, content_hash, payload,
                           actor_user_id, actor_role, created_at, prev_hash, entry_hash)
  values (p_restaurant, next_seq, p_event, p_bill, p_payment, p_content_hash, p_payload,
          actor, actor_role, at, prev, entry);
  update bill_ledger_heads set seq = next_seq, last_hash = entry where restaurant_id = p_restaurant;
  return next_seq;
end$$;
revoke all on function app.bill_ledger_append(uuid, bill_ledger_event, uuid, uuid, bytea, jsonb) from public;

-- ----------------------------------------------------------------- triggers
create or replace function app.ledger_on_bills() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    perform app.bill_ledger_append(new.restaurant_id, 'bill_created', new.id, null, null,
      jsonb_build_object('tableId', new.table_id, 'subtotalMinor', new.subtotal_minor, 'totalMinor', new.total_minor));
  elsif tg_op = 'DELETE' then
    perform app.bill_ledger_append(old.restaurant_id, 'draft_discarded', old.id, null, null,
      jsonb_build_object('totalMinor', old.total_minor));
  else
    if (new.discount_type, new.discount_value, new.discount_minor, new.discount_reason)
       is distinct from (old.discount_type, old.discount_value, old.discount_minor, old.discount_reason) then
      perform app.bill_ledger_append(new.restaurant_id, 'discount_applied', new.id, null, null,
        jsonb_build_object('type', new.discount_type, 'value', new.discount_value, 'discountMinor', new.discount_minor,
                           'reason', new.discount_reason, 'totalMinor', new.total_minor));
    end if;
    if old.status = 'draft' and new.status = 'finalized' then
      perform app.bill_ledger_append(new.restaurant_id, 'bill_finalized', new.id, null, new.content_hash,
        jsonb_build_object('series', new.bill_series, 'billNo', new.bill_no, 'billRef', new.bill_ref,
                           'totalMinor', new.total_minor));
    elsif old.status = 'finalized' and new.status = 'void' then
      perform app.bill_ledger_append(new.restaurant_id, 'bill_voided', new.id, null, new.content_hash,
        jsonb_build_object('billNo', new.bill_no, 'reason', new.void_reason));
    end if;
  end if;
  return null;
end$$;
revoke all on function app.ledger_on_bills() from public;

drop trigger if exists trg_ledger_on_bills on bills;
create trigger trg_ledger_on_bills after insert or update or delete on bills
  for each row execute function app.ledger_on_bills();

create or replace function app.ledger_on_payments() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    perform app.bill_ledger_append(new.restaurant_id, 'payment_recorded', new.bill_id, new.id, null,
      jsonb_build_object('method', new.method, 'amountMinor', new.amount_minor));
  elsif old.reversed_at is null and new.reversed_at is not null then
    perform app.bill_ledger_append(new.restaurant_id, 'payment_reversed', new.bill_id, new.id, null,
      jsonb_build_object('method', new.method, 'amountMinor', new.amount_minor, 'reason', new.reversal_reason));
  end if;
  return null;
end$$;
revoke all on function app.ledger_on_payments() from public;

drop trigger if exists trg_ledger_on_payments on payments;
create trigger trg_ledger_on_payments after insert or update on payments
  for each row execute function app.ledger_on_payments();

-- --------------------------------------------------------- copies (duplicates)
-- Records that a copy of an issued bill was produced — a PDF or a print — and
-- returns which copy it is. The first copy of a bill is the original; every later
-- one is marked as a duplicate (Stage-2 condition 5.3). Only for the caller's own
-- restaurant and billing roles; only for issued bills.
create or replace function app.record_bill_copy(p_bill uuid, p_kind text) returns integer
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  rid uuid := app.restaurant_id();
  b record;
  copies integer;
begin
  if rid is null or app.role() not in ('owner', 'manager', 'billing') then
    raise exception 'not permitted to produce bill copies' using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('pdf', 'print') then
    raise exception 'unknown copy kind' using errcode = 'invalid_parameter_value';
  end if;
  select id, status, content_hash into b from bills where id = p_bill and restaurant_id = rid for share;
  if b.id is null then
    raise exception 'bill not found' using errcode = 'no_data_found';
  end if;
  if b.status = 'draft' then
    raise exception 'a draft has no copies' using errcode = 'check_violation';
  end if;
  -- The head lock inside append serializes copies too, so two copies at once still
  -- get distinct numbers.
  perform 1 from bill_ledger_heads where restaurant_id = rid for update;
  select count(*) + 1 into copies from bill_ledger
   where restaurant_id = rid and bill_id = p_bill and event in ('pdf_generated', 'bill_printed');
  perform app.bill_ledger_append(rid, case when p_kind = 'pdf' then 'pdf_generated'::bill_ledger_event
                                           else 'bill_printed'::bill_ledger_event end,
                                 p_bill, null, b.content_hash, jsonb_build_object('copy', copies, 'status', b.status));
  return copies;
end$$;
revoke all on function app.record_bill_copy(uuid, text) from public;
grant execute on function app.record_bill_copy(uuid, text) to dineflow_staff;

-- --------------------------------------------------------------- privileges
-- Read-only for the billing roles and support access; nobody writes directly.
grant select on bill_ledger, bill_ledger_heads to dineflow_staff;

alter table bill_ledger       enable row level security;
alter table bill_ledger       force row level security;
alter table bill_ledger_heads enable row level security;
alter table bill_ledger_heads force row level security;

do $$
declare
  t text;
begin
  foreach t in array array['bill_ledger', 'bill_ledger_heads'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format($p$create policy %I on %I for select to dineflow_staff
      using ((restaurant_id = (select app.restaurant_id()) and (select app.role()) in ('owner', 'manager', 'billing'))
             or (select app.has_support_grant(restaurant_id)))$p$, t || '_read', t);
  end loop;
end$$;

-- --------------------------------------------------------------- backfill
-- Bills that existed before this migration get their entries now, in the order
-- they happened, so every issued bill has a bill_finalized entry to verify.
do $$
declare
  b record;
  p record;
begin
  for b in select * from bills
            where not exists (select 1 from bill_ledger l where l.bill_id = bills.id)
            order by created_at, id loop
    perform app.bill_ledger_append(b.restaurant_id, 'bill_created', b.id, null, null,
      jsonb_build_object('tableId', b.table_id, 'subtotalMinor', b.subtotal_minor, 'totalMinor', b.total_minor, 'backfilled', true));
    if b.status <> 'draft' then
      perform app.bill_ledger_append(b.restaurant_id, 'bill_finalized', b.id, null, b.content_hash,
        jsonb_build_object('series', b.bill_series, 'billNo', b.bill_no, 'billRef', b.bill_ref,
                           'totalMinor', b.total_minor, 'backfilled', true));
    end if;
    for p in select * from payments where bill_id = b.id order by recorded_at, id loop
      perform app.bill_ledger_append(p.restaurant_id, 'payment_recorded', p.bill_id, p.id, null,
        jsonb_build_object('method', p.method, 'amountMinor', p.amount_minor, 'backfilled', true));
      if p.reversed_at is not null then
        perform app.bill_ledger_append(p.restaurant_id, 'payment_reversed', p.bill_id, p.id, null,
          jsonb_build_object('method', p.method, 'amountMinor', p.amount_minor, 'reason', p.reversal_reason, 'backfilled', true));
      end if;
    end loop;
    if b.status = 'void' then
      perform app.bill_ledger_append(b.restaurant_id, 'bill_voided', b.id, null, b.content_hash,
        jsonb_build_object('billNo', b.bill_no, 'reason', b.void_reason, 'backfilled', true));
    end if;
  end loop;
end$$;
