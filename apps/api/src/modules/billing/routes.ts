// Billing (PRD FR-070 … FR-082; design/02 §6.8, design/01 §4.2).
//
// The restaurant comes from the authenticated membership and RLS; no route accepts
// a restaurant id. The lifecycle is Draft → Finalized → Void. Every rule is checked
// here, for a clear answer, and again by the database guards (app.bills_guard,
// app.bill_children_guard, app.payments_guard), which also hold for anything that
// bypasses this code. Money is integer minor units throughout (@dineflow/shared).
import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import {
  BillError, canonicalBillText, computeBill, type BillTotals, type DiscountType, type RoundingMode,
} from '@dineflow/shared';
import type { Database } from '../../lib/db.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { authenticate, requirePermission, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';
import { billPdf, copyMark } from './pdf.ts';

export type BillingDeps = { db: Database; verify: Verifier; cookieSecure: boolean };

/** One continuous series per restaurant (approved decision 5). */
export const BILL_SERIES = 'main';
const MAX_ORDERS_PER_BILL = 50;
const MAX_PAGE = 100;

const version = z.number().int().min(1);
const reason = z.string().trim().min(3, 'Give a reason of at least 3 characters.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createBody = z.object({
  orderIds: z.array(z.string().uuid()).min(1, 'Choose at least one order.').max(MAX_ORDERS_PER_BILL),
}).strict();
// Percent values are basis points (1250 = 12.5 %); fixed values are minor units.
// `type: null` removes the discount.
const discountBody = z.union([
  z.object({
    type: z.enum(['percent', 'fixed']),
    value: z.number().int().min(1).max(1_000_000_000),
    reason: reason.max(200),
    version,
  }).strict(),
  z.object({ type: z.null(), version }).strict(),
]);
const finalizeBody = z.object({ version }).strict();
const voidBody = z.object({ reason: reason.max(300), version }).strict();
const paymentBody = z.object({
  method: z.enum(['cash', 'card', 'upi', 'other']),
  amountMinor: z.number().int().min(0),
  reference: z.string().trim().min(1).max(80).optional(),
}).strict();
const reverseBody = z.object({ reason: reason.max(300) }).strict();
const listQuery = z.object({
  status: z.enum(['draft', 'finalized', 'void']).optional(),
  payment: z.enum(['paid', 'unpaid']).optional(),
  table: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().regex(/^\d{1,10}$/, 'Search by bill number.').optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
}).strict();
const billableQuery = z.object({ table: z.string().uuid().optional() }).strict();

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('VALIDATION_FAILED', 'Please check the details and try again.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  }
  return result.data;
}

/** A malformed id is answered like a missing bill, so probing learns nothing. */
const idParam = (req: Request): string => {
  const parsed = z.string().uuid().safeParse(req.params.id);
  if (!parsed.success) throw notFound();
  return parsed.data;
};

const encodeCursor = (at: Date, id: string) => Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !z.string().uuid().safeParse(id).success) throw new Error();
    return [at, id];
  } catch {
    throw badRequest('VALIDATION_FAILED', 'That page link is not valid. Please reload.');
  }
}

/** The database guards are the second line: if one refuses, answer as the API would have. */
const guardRefusal = (error: unknown): never => {
  const code = (error as { code?: string }).code;
  if (code === '23514') throw conflict('BILL_RULE', 'That change is not allowed for this bill.');
  if (code === '42501') throw forbidden('You do not have permission to do that.');
  throw error;
};

const billError = (error: unknown): never => {
  if (error instanceof BillError) {
    throw badRequest(error.code, error.message, [{ field: 'value', message: error.message }]);
  }
  throw error;
};

type BillRow = {
  id: string; status: 'draft' | 'finalized' | 'void'; bill_series: string; bill_no: number | null; bill_ref: string | null;
  currency: string; prices_include_tax: boolean; service_charge_bps: number; rounding_mode: RoundingMode;
  subtotal_minor: string; discount_type: DiscountType | null; discount_value: string | null; discount_minor: string;
  discount_reason: string | null; service_charge_minor: string; tax_total_minor: string; rounding_minor: string;
  total_minor: string; issuer_snapshot: Record<string, unknown>; content_hash: Buffer | null;
  created_by: string; created_at: Date; finalized_by: string | null; finalized_at: Date | null;
  voided_by: string | null; voided_at: Date | null; void_reason: string | null; version: number;
  table_id: string; table_number: string; table_name: string | null;
};

/** Everything a bill shows and everything its content hash covers (FR-071). */
export async function loadBill(client: pg.PoolClient, id: string) {
  const found = await client.query<BillRow>(
    `select b.*, t.table_number, t.name as table_name
       from bills b join dining_tables t on t.id = b.table_id
      where b.id = $1`, [id]);
  const row = found.rows[0];
  if (!row) return null;
  // One after another: a pg client runs one query at a time.
  const lines = await client.query<{ name: string; quantity: number; unit_price_minor: string; line_total_minor: string }>(
    'select name, quantity, unit_price_minor, line_total_minor from bill_lines where bill_id = $1 order by position', [id]);
  const taxes = await client.query<{ name: string; rate_bps: number; taxable_minor: string; amount_minor: string }>(
    'select name, rate_bps, taxable_minor, amount_minor from bill_taxes where bill_id = $1 order by position', [id]);
  const orders = await client.query<{ id: string; order_ref: string; status: string; voided: boolean }>(
    `select o.id, o.order_ref, o.status, bo.voided
       from bill_orders bo join orders o on o.id = bo.order_id
      where bo.bill_id = $1 order by o.order_no`, [id]);
  const payments = await client.query<{
    id: string; method: string; amount_minor: string; reference: string | null; recorded_by: string; recorded_at: Date;
    reversed_at: Date | null; reversed_by: string | null; reversal_reason: string | null;
  }>(`select id, method, amount_minor, reference, recorded_by, recorded_at, reversed_at, reversed_by, reversal_reason
        from payments where bill_id = $1 order by recorded_at, id`, [id]);
  const staff = await client.query<{ user_id: string; display_name: string | null }>(
    'select user_id, display_name from restaurant_users where restaurant_id = (select restaurant_id from bills where id = $1)', [id]);
  const nameOf = (userId: string | null) =>
    userId ? staff.rows.find((s) => s.user_id === userId)?.display_name ?? null : null;
  const livePayment = payments.rows.find((p) => p.reversed_at === null) ?? null;
  return {
    id: row.id,
    status: row.status,
    paymentStatus: row.status === 'finalized' ? (livePayment ? 'paid' : 'unpaid') : null,
    series: row.bill_series,
    number: row.bill_no,
    ref: row.bill_ref,
    table: { id: row.table_id, tableNumber: row.table_number, name: row.table_name },
    orders: orders.rows.map((o) => ({ id: o.id, ref: o.order_ref, status: o.status, released: o.voided })),
    currency: row.currency,
    pricesIncludeTax: row.prices_include_tax,
    serviceChargeBps: row.service_charge_bps,
    roundingMode: row.rounding_mode,
    lines: lines.rows.map((l) => ({
      name: l.name, quantity: l.quantity, unitPriceMinor: Number(l.unit_price_minor), lineTotalMinor: Number(l.line_total_minor),
    })),
    taxes: taxes.rows.map((t) => ({
      name: t.name, rateBps: t.rate_bps, taxableMinor: Number(t.taxable_minor), amountMinor: Number(t.amount_minor),
    })),
    subtotalMinor: Number(row.subtotal_minor),
    discount: row.discount_type
      ? { type: row.discount_type, value: Number(row.discount_value), reason: row.discount_reason }
      : null,
    discountMinor: Number(row.discount_minor),
    serviceChargeMinor: Number(row.service_charge_minor),
    taxTotalMinor: Number(row.tax_total_minor),
    roundingMinor: Number(row.rounding_minor),
    totalMinor: Number(row.total_minor),
    issuer: row.issuer_snapshot,
    contentHash: row.content_hash ? row.content_hash.toString('hex') : null,
    createdAt: row.created_at,
    createdBy: nameOf(row.created_by),
    finalizedAt: row.finalized_at,
    finalizedBy: nameOf(row.finalized_by),
    voidedAt: row.voided_at,
    voidedBy: nameOf(row.voided_by),
    voidReason: row.void_reason,
    payments: payments.rows.map((p) => ({
      id: p.id, method: p.method, amountMinor: Number(p.amount_minor), reference: p.reference,
      recordedAt: p.recorded_at, recordedBy: nameOf(p.recorded_by),
      reversedAt: p.reversed_at, reversedBy: nameOf(p.reversed_by), reversalReason: p.reversal_reason,
    })),
    version: row.version,
  };
}

export type BillView = NonNullable<Awaited<ReturnType<typeof loadBill>>>;

/** The canonical text of an issued bill, whose SHA-256 is its content hash. */
export function canonicalTextOf(bill: BillView, restaurantId: string): string {
  return canonicalBillText({
    restaurantId, billNo: bill.number!, billRef: bill.ref!, series: bill.series, currency: bill.currency,
    pricesIncludeTax: bill.pricesIncludeTax, issuer: bill.issuer, tableNumber: bill.table.tableNumber,
    orderRefs: bill.orders.map((o) => o.ref), lines: bill.lines, taxes: bill.taxes,
    subtotalMinor: bill.subtotalMinor, discountType: bill.discount?.type ?? null,
    discountValue: bill.discount?.value ?? null, discountMinor: bill.discountMinor,
    discountReason: bill.discount?.reason ?? null, serviceChargeBps: bill.serviceChargeBps,
    serviceChargeMinor: bill.serviceChargeMinor, taxTotalMinor: bill.taxTotalMinor, roundingMode: bill.roundingMode,
    roundingMinor: bill.roundingMinor, totalMinor: bill.totalMinor,
  });
}

/** The restaurant's name, address, contact, tax number and footer, as printed (FR-071). */
async function issuerSnapshot(client: pg.PoolClient, restaurantId: string) {
  const { rows: [r] } = await client.query<{
    name: string; address_line1: string | null; address_line2: string | null; city: string | null; region: string | null;
    postal_code: string | null; country: string | null; phone: string | null; email: string | null; logo_path: string | null;
    tax_registration_no: string | null; bill_footer: string | null;
  }>(`select r.name, r.address_line1, r.address_line2, r.city, r.region, r.postal_code, r.country, r.phone,
             r.email::text as email, r.logo_path, s.tax_registration_no, s.bill_footer
        from restaurants r left join restaurant_settings s on s.restaurant_id = r.id
       where r.id = $1`, [restaurantId]);
  return {
    name: r!.name,
    addressLines: [r!.address_line1, r!.address_line2, [r!.city, r!.region, r!.postal_code].filter(Boolean).join(', ')]
      .filter((line): line is string => Boolean(line && line.trim())),
    country: r!.country, phone: r!.phone, email: r!.email, logoPath: r!.logo_path,
    taxRegistrationNo: r!.tax_registration_no, footer: r!.bill_footer,
  };
}

const writeTaxes = async (client: pg.PoolClient, restaurantId: string, billId: string, taxes: BillTotals['taxes']) => {
  for (const [index, tax] of taxes.entries()) {
    await client.query(
      `insert into bill_taxes (restaurant_id, bill_id, position, name, rate_bps, taxable_minor, amount_minor)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [restaurantId, billId, index + 1, tax.name, tax.rateBps, tax.taxableMinor, tax.amountMinor]);
  }
};

export function billingRoutes({ db, verify, cookieSecure }: BillingDeps): { bills: Router; payments: Router } {
  const bills = Router();
  const payments = Router();
  bills.use(authenticate({ db, verify, cookieSecure }));
  payments.use(authenticate({ db, verify, cookieSecure }));

  const audit = async (client: pg.PoolClient, req: Request, action: string, entityType: 'bill' | 'payment',
                       id: string, summary: Record<string, unknown>) => {
    const principal = staffPrincipal(req);
    await client.query(
      `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary, ip, request_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [principal.restaurantId, principal.userId, principal.role, action, entityType, id, JSON.stringify(summary),
       req.clientIp, req.requestId]);
  };

  /** Locks the bill for this transaction; checks the caller's version when given (FR-058 pattern). */
  const lockBill = async (client: pg.PoolClient, id: string, expectedVersion?: number) => {
    const found = await client.query<{ status: BillRow['status']; version: number; bill_ref: string | null; total_minor: string }>(
      'select status, version, bill_ref, total_minor from bills where id = $1 for update', [id]);
    const row = found.rows[0];
    if (!row) throw notFound();
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw conflict('STALE_VERSION', 'Someone else has just changed this bill. It has been refreshed; please check it and try again.');
    }
    return row;
  };

  const mustLoad = async (client: pg.PoolClient, id: string) => {
    const bill = await loadBill(client, id);
    if (!bill) throw notFound();
    return bill;
  };

  // --------------------------------------------------------------------- list
  bills.get('/', requirePermission('bill.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const query = parse(listQuery, req.query);
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const limit = query.limit ?? 50;
      const data = await db.asStaff(principal, async (client) => {
        const { rows: [info] } = await client.query<{ timezone: string; currency: string }>(
          'select timezone, currency from restaurants where id = $1', [principal.restaurantId]);
        const rows = await client.query<{
          id: string; status: BillRow['status']; bill_ref: string | null; total_minor: string; created_at: Date;
          finalized_at: Date | null; table_number: string; order_refs: string[]; paid: boolean; version: number;
        }>(
          `select b.id, b.status, b.bill_ref, b.total_minor, b.created_at, b.finalized_at, b.version, t.table_number,
                  array(select o.order_ref from bill_orders bo join orders o on o.id = bo.order_id
                         where bo.bill_id = b.id order by o.order_no) as order_refs,
                  exists (select 1 from payments p where p.bill_id = b.id and p.reversed_at is null) as paid
             from bills b join dining_tables t on t.id = b.table_id
            where ($1::bill_status is null or b.status = $1)
              and ($2::uuid is null or b.table_id = $2)
              -- Days are the restaurant's own, in its timezone (NFR-D05).
              and ($3::date is null or b.created_at >= ($3::date)::timestamp at time zone $8)
              and ($4::date is null or b.created_at < ($4::date + 1)::timestamp at time zone $8)
              and ($5::text is null or b.bill_ref = $5)
              and ($6::timestamptz is null or (b.created_at, b.id) < ($6::timestamptz, $7::uuid))
              and ($9::boolean is null or (b.status = 'finalized'
                   and exists (select 1 from payments p where p.bill_id = b.id and p.reversed_at is null) = $9))
            order by b.created_at desc, b.id desc
            limit $10`,
          [query.status ?? null, query.table ?? null, query.from ?? null, query.to ?? null, query.q ?? null,
           cursor?.[0] ?? null, cursor?.[1] ?? null, info!.timezone,
           query.payment ? query.payment === 'paid' : null, limit + 1]);
        return { ...info!, rows: rows.rows };
      });
      const page = data.rows.slice(0, limit);
      const last = page[page.length - 1];
      res.status(200).json({
        bills: page.map((b) => ({
          id: b.id, status: b.status, ref: b.bill_ref, totalMinor: Number(b.total_minor), tableNumber: b.table_number,
          orderRefs: b.order_refs, createdAt: b.created_at, finalizedAt: b.finalized_at,
          paymentStatus: b.status === 'finalized' ? (b.paid ? 'paid' : 'unpaid') : null, version: b.version,
        })),
        nextCursor: data.rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
        timezone: data.timezone,
        currency: data.currency,
      });
    } catch (error) {
      next(error);
    }
  });

  // ----------------------------------------------------------------- billable
  /**
   * What can be billed (approved decision 1: staff choose any unbilled, non-cancelled
   * orders of one table). Without `table`: the tables that have such orders. With it:
   * those orders.
   */
  bills.get('/billable', requirePermission('bill.create'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const query = parse(billableQuery, req.query);
      const unbilled = `o.status <> 'cancelled'
        and not exists (select 1 from bill_orders bo where bo.order_id = o.id and not bo.voided)`;
      const data = await db.asStaff(principal, async (client) => {
        const { rows: [info] } = await client.query<{ currency: string }>(
          'select currency from restaurants where id = $1', [principal.restaurantId]);
        if (!query.table) {
          const tables = await client.query<{ id: string; table_number: string; name: string | null; orders: number; subtotal: string }>(
            `select t.id, t.table_number, t.name, count(*)::int as orders, sum(o.subtotal_minor) as subtotal
               from orders o join dining_tables t on t.id = o.table_id
              where ${unbilled}
              group by t.id, t.table_number, t.name
              order by t.table_number`);
          return {
            currency: info!.currency,
            tables: tables.rows.map((t) => ({
              id: t.id, tableNumber: t.table_number, name: t.name, orderCount: t.orders, subtotalMinor: Number(t.subtotal),
            })),
          };
        }
        const orders = await client.query<{
          id: string; order_ref: string; status: string; placed_at: Date; subtotal_minor: string;
          items: { name: string; quantity: number }[];
        }>(
          `select o.id, o.order_ref, o.status, o.placed_at, o.subtotal_minor,
                  coalesce((select json_agg(json_build_object('name', i.name_snapshot, 'quantity', i.quantity) order by i.position)
                              from order_items i where i.order_id = o.id), '[]'::json) as items
             from orders o
            where o.table_id = $1 and ${unbilled}
            order by o.placed_at, o.order_no`, [query.table]);
        return {
          currency: info!.currency,
          orders: orders.rows.map((o) => ({
            id: o.id, ref: o.order_ref, status: o.status, placedAt: o.placed_at,
            subtotalMinor: Number(o.subtotal_minor), items: o.items,
          })),
        };
      });
      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- create
  /** A draft: a snapshot of the orders' lines and of the tax settings (FR-070, FR-074). */
  bills.post('/', requirePermission('bill.create'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(createBody, req.body);
      const orderIds = [...new Set(body.orderIds)].sort();
      const bill = await db.asStaff(principal, async (client) => {
        // Locked in id order, so two drafts over overlapping orders cannot deadlock,
        // and a cancel racing this bill waits for it.
        const orders = await client.query<{ id: string; table_id: string; status: string; order_ref: string; billed: boolean }>(
          `select o.id, o.table_id, o.status, o.order_ref,
                  exists (select 1 from bill_orders bo where bo.order_id = o.id and not bo.voided) as billed
             from orders o where o.id = any($1::uuid[]) order by o.id for update of o`, [orderIds]);
        if (orders.rows.length !== orderIds.length) throw notFound('One of those orders was not found.');
        if (new Set(orders.rows.map((o) => o.table_id)).size > 1) {
          throw badRequest('MIXED_TABLES', 'A bill covers orders of one table only.');
        }
        const cancelled = orders.rows.filter((o) => o.status === 'cancelled').map((o) => o.order_ref);
        if (cancelled.length) throw conflict('ORDER_CANCELLED', `Cancelled orders cannot be billed: ${cancelled.join(', ')}.`);
        const billed = orders.rows.filter((o) => o.billed).map((o) => o.order_ref);
        if (billed.length) throw conflict('ALREADY_BILLED', `Already on a bill: ${billed.join(', ')}.`);

        const { rows: [settings] } = await client.query<{
          currency: string; prices_include_tax: boolean; service_charge_bps: number; rounding_mode: RoundingMode;
        }>(`select r.currency, s.prices_include_tax, s.service_charge_bps, s.rounding_mode
              from restaurants r join restaurant_settings s on s.restaurant_id = r.id where r.id = $1`,
           [principal.restaurantId]);
        const taxes = await client.query<{ name: string; rate_bps: number }>(
          `select name, rate_bps from tax_components where active order by sort_order, name`);
        const items = await client.query<{ id: string; name_snapshot: string; quantity: number; unit_price_minor: string }>(
          `select i.id, i.name_snapshot, i.quantity, i.unit_price_minor
             from order_items i join orders o on o.id = i.order_id
            where i.order_id = any($1::uuid[])
            order by o.placed_at, o.order_no, i.position`, [orderIds]);
        const totals = (() => {
          try {
            return computeBill({
              lines: items.rows.map((i) => ({ unitPriceMinor: Number(i.unit_price_minor), quantity: i.quantity })),
              pricesIncludeTax: settings!.prices_include_tax,
              taxes: taxes.rows.map((t) => ({ name: t.name, rateBps: t.rate_bps })),
              serviceChargeBps: settings!.service_charge_bps, discount: null, roundingMode: settings!.rounding_mode,
            });
          } catch (error) {
            return billError(error);
          }
        })();

        const { rows: [created] } = await client.query<{ id: string }>(
          `insert into bills (restaurant_id, table_id, currency, prices_include_tax, service_charge_bps, rounding_mode,
                              subtotal_minor, service_charge_minor, tax_total_minor, rounding_minor, total_minor,
                              issuer_snapshot, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
          [principal.restaurantId, orders.rows[0]!.table_id, settings!.currency, settings!.prices_include_tax,
           settings!.service_charge_bps, settings!.rounding_mode, totals.subtotalMinor, totals.serviceChargeMinor,
           totals.taxTotalMinor, totals.roundingMinor, totals.totalMinor,
           await issuerSnapshot(client, principal.restaurantId), principal.userId]);
        const billId = created!.id;
        for (const order of orders.rows) {
          await client.query('insert into bill_orders (bill_id, order_id, restaurant_id) values ($1, $2, $3)',
            [billId, order.id, principal.restaurantId]).catch((error: { code?: string }) => {
            // A concurrent bill took the order after our check (BR-BILL-01).
            if (error.code === '23505') throw conflict('ALREADY_BILLED', `Already on a bill: ${order.order_ref}.`);
            throw error;
          });
        }
        for (const [index, item] of items.rows.entries()) {
          await client.query(
            `insert into bill_lines (restaurant_id, bill_id, order_item_id, position, name, quantity, unit_price_minor, line_total_minor)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [principal.restaurantId, billId, item.id, index + 1, item.name_snapshot, item.quantity, item.unit_price_minor,
             Number(item.unit_price_minor) * item.quantity]);
        }
        await writeTaxes(client, principal.restaurantId, billId, totals.taxes);
        await audit(client, req, 'bill.created', 'bill', billId, {
          orderRefs: orders.rows.map((o) => o.order_ref), totalMinor: totals.totalMinor,
        });
        return mustLoad(client, billId);
      });
      res.status(201).json({ bill });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- detail
  bills.get('/:id', requirePermission('bill.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const bill = await db.asStaff(principal, (client) => mustLoad(client, id));
      res.status(200).json({ bill });
    } catch (error) {
      next(error);
    }
  });

  // ----------------------------------------------------------------- discount
  /** Drafts only; owner and manager; a manager is capped (FR-075, BR-BILL-05, Q-12). */
  bills.patch('/:id/discount', requirePermission('bill.discount.apply'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const body = parse(discountBody, req.body);
      const bill = await db.asStaff(principal, async (client) => {
        const current = await lockBill(client, id, body.version);
        if (current.status !== 'draft') throw conflict('NOT_DRAFT', 'A discount can be changed only on a draft bill.');
        const before = await mustLoad(client, id);
        const discount = body.type === null ? null : { type: body.type, value: body.value };
        let totals: BillTotals;
        try {
          totals = computeBill({
            lines: before.lines, pricesIncludeTax: before.pricesIncludeTax, taxes: before.taxes,
            serviceChargeBps: before.serviceChargeBps, discount, roundingMode: before.roundingMode,
          });
        } catch (error) {
          return billError(error);
        }
        if (principal.role === 'manager' && totals.discountMinor > 0) {
          const { rows: [cap] } = await client.query<{ manager_discount_cap_bps: number }>(
            'select manager_discount_cap_bps from restaurant_settings where restaurant_id = $1', [principal.restaurantId]);
          if (totals.discountMinor * 10_000 > (cap?.manager_discount_cap_bps ?? 0) * totals.subtotalMinor) {
            throw new AppError(403, 'DISCOUNT_ABOVE_LIMIT',
              `Managers can give at most ${((cap?.manager_discount_cap_bps ?? 0) / 100).toFixed(2)} % off. Ask an owner.`);
          }
        }
        await client.query(
          `update bills set discount_type = $2, discount_value = $3, discount_minor = $4, discount_reason = $5,
                  service_charge_minor = $6, tax_total_minor = $7, rounding_minor = $8, total_minor = $9,
                  version = version + 1
            where id = $1`,
          [id, discount?.type ?? null, discount?.value ?? null, totals.discountMinor,
           body.type === null ? null : body.reason, totals.serviceChargeMinor, totals.taxTotalMinor,
           totals.roundingMinor, totals.totalMinor]).catch(guardRefusal);
        await client.query('delete from bill_taxes where bill_id = $1', [id]).catch(guardRefusal);
        await writeTaxes(client, principal.restaurantId, id, totals.taxes);
        await audit(client, req, 'bill.discount_applied', 'bill', id, {
          type: discount?.type ?? null, value: discount?.value ?? null, discountMinor: totals.discountMinor,
          reason: body.type === null ? null : body.reason, previousDiscountMinor: before.discountMinor,
          totalMinor: totals.totalMinor,
        });
        return mustLoad(client, id);
      });
      res.status(200).json({ bill });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------ discard
  /** A draft may be discarded; it never had a number (approved decision 7). */
  bills.delete('/:id', requirePermission('bill.create'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      await db.asStaff(principal, async (client) => {
        const current = await lockBill(client, id);
        if (current.status !== 'draft') {
          throw conflict('NOT_DRAFT', 'Only a draft can be discarded. An issued bill is corrected by voiding it.');
        }
        const bill = await mustLoad(client, id);
        await client.query('delete from bills where id = $1', [id]).catch(guardRefusal);
        await audit(client, req, 'bill.discarded', 'bill', id, {
          orderRefs: bill.orders.map((o) => o.ref), totalMinor: bill.totalMinor,
        });
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // ----------------------------------------------------------------- finalize
  /**
   * Issues the bill: draws the next number, refreshes the issuer details once more
   * and freezes everything with its content hash (FR-072, FR-076). Idempotent: a
   * bill that is already issued is returned as it is.
   */
  bills.post('/:id/finalize', requirePermission('bill.finalize'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const body = parse(finalizeBody, req.body);
      const result = await db.asStaff(principal, async (client) => {
        const current = await lockBill(client, id);
        if (current.status !== 'draft') return { bill: await mustLoad(client, id), repeated: true };
        if (current.version !== body.version) {
          throw conflict('STALE_VERSION', 'Someone else has just changed this bill. It has been refreshed; please check it and try again.');
        }
        // Approved decision 2: an order may have been cancelled since the draft.
        const cancelled = await client.query<{ order_ref: string }>(
          `select o.order_ref from bill_orders bo join orders o on o.id = bo.order_id
            where bo.bill_id = $1 and o.status = 'cancelled' order by o.order_no`, [id]);
        if (cancelled.rows.length) {
          throw conflict('ORDER_CANCELLED',
            `Order ${cancelled.rows.map((o) => o.order_ref).join(', ')} was cancelled after this draft was made. Discard it and bill again.`);
        }
        const { rows: [drawn] } = await client.query<{ n: number }>('select app.next_bill_no($1) as n', [BILL_SERIES]);
        const number = drawn!.n;
        const ref = String(number); // Approved decision 6: the plain sequential number.
        const issuer = await issuerSnapshot(client, principal.restaurantId);
        const draft = await mustLoad(client, id);
        const text = canonicalTextOf({ ...draft, number, ref, issuer }, principal.restaurantId);
        const hash = createHash('sha256').update(text).digest();
        await client.query(
          `update bills set status = 'finalized', bill_no = $2, bill_ref = $3, issuer_snapshot = $4, content_hash = $5,
                  finalized_by = $6, finalized_at = now(), version = version + 1
            where id = $1`, [id, number, ref, issuer, hash, principal.userId]).catch(guardRefusal);
        await audit(client, req, 'bill.finalized', 'bill', id, { ref, totalMinor: draft.totalMinor });
        return { bill: await mustLoad(client, id), repeated: false };
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------------------- void
  /** Owner and manager, with a reason; the number is kept and shown as VOID (FR-077). */
  bills.post('/:id/void', requirePermission('bill.void'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const body = parse(voidBody, req.body);
      const bill = await db.asStaff(principal, async (client) => {
        const current = await lockBill(client, id, body.version);
        if (current.status === 'draft') throw conflict('NOT_FINALIZED', 'A draft is discarded, not voided.');
        if (current.status === 'void') throw conflict('ALREADY_VOID', 'This bill is already void.');
        const { rows: [paid] } = await client.query<{ n: number }>(
          'select count(*)::int as n from payments where bill_id = $1 and reversed_at is null', [id]);
        if (paid!.n > 0) {
          throw conflict('PAYMENT_EXISTS', 'This bill has been paid. Reverse the payment before voiding it.');
        }
        await client.query(
          `update bills set status = 'void', voided_by = $2, voided_at = now(), void_reason = $3, version = version + 1
            where id = $1`, [id, principal.userId, body.reason]).catch(guardRefusal);
        await audit(client, req, 'bill.voided', 'bill', id, { ref: current.bill_ref, reason: body.reason });
        return mustLoad(client, id);
      });
      res.status(200).json({ bill });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- copies
  /**
   * Every copy of an issued bill — a print or a PDF — is recorded in the billing
   * ledger and numbered; the first is the original, later ones are marked as
   * duplicates (Stage-2 condition 5.3). These are POST, not GET, because producing
   * a copy changes state: the ledger and the next copy's number.
   */
  const recordCopy = async (client: pg.PoolClient, id: string, kind: 'pdf' | 'print') => {
    const bill = await mustLoad(client, id);
    if (bill.status === 'draft') throw conflict('NOT_FINALIZED', 'A draft cannot be printed or downloaded. Finalize it first.');
    const { rows: [recorded] } = await client.query<{ copy: number }>('select app.record_bill_copy($1, $2) as copy', [id, kind]);
    const { rows: [info] } = await client.query<{ timezone: string }>(
      'select timezone from restaurants where id = (select restaurant_id from bills where id = $1)', [id]);
    return { bill, copy: recorded!.copy, timezone: info!.timezone };
  };

  bills.post('/:id/print', requirePermission('bill.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const { bill, copy } = await db.asStaff(principal, (client) => recordCopy(client, id, 'print'));
      res.status(200).json({ bill, copy: { number: copy, duplicate: copy > 1, mark: copyMark(bill.status, copy) } });
    } catch (error) {
      next(error);
    }
  });

  bills.post('/:id/pdf', requirePermission('bill.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const { bill, copy, timezone } = await db.asStaff(principal, (client) => recordCopy(client, id, 'pdf'));
      const pdf = await billPdf(bill, copy, timezone);
      res.status(200)
        .type('application/pdf')
        .set('content-disposition', `attachment; filename="bill-${bill.ref}${copy > 1 ? `-copy-${copy}` : ''}.pdf"`)
        .set('cache-control', 'no-store')
        .set('x-bill-copy', String(copy))
        .send(pdf);
    } catch (error) {
      next(error);
    }
  });

  // ----------------------------------------------------------------- payments
  /**
   * Records the payment of a finalized bill: its exact total, once (FR-080, FR-081,
   * BR-BILL-06). Idempotent: repeating the same payment returns the existing one.
   */
  bills.post('/:id/payments', requirePermission('payment.record'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const body = parse(paymentBody, req.body);
      const result = await db.asStaff(principal, async (client) => {
        const current = await lockBill(client, id);
        if (current.status === 'draft') throw conflict('NOT_FINALIZED', 'Finalize the bill before recording its payment.');
        if (current.status === 'void') throw conflict('BILL_VOID', 'A void bill cannot be paid.');
        const { rows: [live] } = await client.query<{ method: string; amount_minor: string; reference: string | null }>(
          'select method, amount_minor, reference from payments where bill_id = $1 and reversed_at is null', [id]);
        if (live) {
          if (live.method === body.method && Number(live.amount_minor) === body.amountMinor
              && (live.reference ?? undefined) === body.reference) {
            return { bill: await mustLoad(client, id), repeated: true };
          }
          throw conflict('ALREADY_PAID', 'This bill has already been paid.');
        }
        if (body.amountMinor !== Number(current.total_minor)) {
          throw badRequest('AMOUNT_MISMATCH', 'The payment must be the bill total exactly. Partial payments are not supported.',
            [{ field: 'amountMinor', message: 'Enter the bill total.' }]);
        }
        const { rows: [payment] } = await client.query<{ id: string }>(
          `insert into payments (restaurant_id, bill_id, method, amount_minor, reference, recorded_by)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [principal.restaurantId, id, body.method, body.amountMinor, body.reference ?? null, principal.userId])
          .catch(guardRefusal);
        await audit(client, req, 'payment.recorded', 'payment', payment!.id, {
          billRef: current.bill_ref, method: body.method, amountMinor: body.amountMinor,
        });
        return { bill: await mustLoad(client, id), repeated: false };
      });
      res.status(result.repeated ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });

  /** Owner and manager, with a reason; the payment stays on record (FR-081). */
  payments.post('/:id/reverse', requirePermission('payment.reverse'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = idParam(req);
      const body = parse(reverseBody, req.body);
      const bill = await db.asStaff(principal, async (client) => {
        const found = await client.query<{ bill_id: string; reversed_at: Date | null; amount_minor: string; method: string }>(
          'select bill_id, reversed_at, amount_minor, method from payments where id = $1 for update', [id]);
        const payment = found.rows[0];
        if (!payment) throw notFound();
        if (payment.reversed_at) throw conflict('ALREADY_REVERSED', 'This payment has already been reversed.');
        await client.query(
          `update payments set reversed_at = now(), reversed_by = $2, reversal_reason = $3 where id = $1`,
          [id, principal.userId, body.reason]).catch(guardRefusal);
        const { rows: [billRow] } = await client.query<{ bill_ref: string | null }>(
          'select bill_ref from bills where id = $1', [payment.bill_id]);
        await audit(client, req, 'payment.reversed', 'payment', id, {
          billRef: billRow?.bill_ref ?? null, method: payment.method, amountMinor: Number(payment.amount_minor), reason: body.reason,
        });
        return mustLoad(client, payment.bill_id);
      });
      res.status(200).json({ bill });
    } catch (error) {
      next(error);
    }
  });

  return { bills, payments };
}
