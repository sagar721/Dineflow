// Staff order workflow (PRD FR-050 … FR-059; design/02 §6.7, design/01 §4.1).
//
// The restaurant comes from the authenticated membership and RLS; no route accepts
// a restaurant id. Status changes are checked here against the shared state machine
// and again by the database guard (app.order_update_guard), so neither alone is the
// protection. Kitchen staff never receive customer contact details: this code does
// not fetch them for kitchen, and RLS would return nothing if it tried.
import { Router, type Request } from 'express';
import { z } from 'zod';
import type pg from 'pg';
import {
  canRevert, canTransition, can, ACTIVE_STATUSES, ORDER_STATUSES, revertTarget,
  type OrderStatus, type StaffRole,
} from '@dineflow/shared';
import type { Database } from '../../lib/db.ts';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.ts';
import { authenticate, requirePermission, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';

export type OrderDeps = { db: Database; verify: Verifier; cookieSecure: boolean };

const STAFF_ROLES: StaffRole[] = ['owner', 'manager', 'kitchen', 'billing'];
const MAX_PAGE = 100;
const KITCHEN_LIMIT = 200;
/**
 * A poll looks back this far past its cursor. A transaction can commit after a
 * later one, carrying an earlier timestamp; the overlap catches it. Clients
 * de-duplicate by order id and version, so a repeat costs only a refetch.
 */
const LIVE_OVERLAP_SECONDS = 5;

const statusEnum = z.enum(ORDER_STATUSES);
const version = z.number().int().min(1);
const reason = z.string().trim().min(3, 'Give a reason of at least 3 characters.').max(300);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listQuery = z.object({
  status: z.string().max(100).optional(),
  table: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(20).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  // The kitchen board: active orders only, oldest first (FR-056).
  view: z.enum(['list', 'kitchen']).optional(),
}).strict();
const liveQuery = z.object({ since: z.string().datetime({ offset: true }).optional() }).strict();
const statusBody = z.object({ to: statusEnum, version, reason: reason.optional() }).strict();
const revertBody = z.object({ version, reason }).strict();
const noteBody = z.object({ note: z.string().trim().max(500).nullable(), version }).strict();

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('VALIDATION_FAILED', 'Please check the details and try again.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  }
  return result.data;
}

const orderId = (req: Request): string => {
  const parsed = z.string().uuid().safeParse(req.params.id);
  // A malformed id is answered like a missing order, so probing learns nothing.
  if (!parsed.success) throw notFound();
  return parsed.data;
};

/** Keyset cursor over (placed_at, id), opaque to the client. */
const encodeCursor = (placedAt: Date, id: string) =>
  Buffer.from(JSON.stringify([placedAt.toISOString(), id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !z.string().uuid().safeParse(id).success) throw new Error();
    return [at, id];
  } catch {
    throw badRequest('VALIDATION_FAILED', 'That page link is not valid. Please reload.');
  }
}

type SummaryRow = {
  id: string; order_ref: string; order_no: number; status: OrderStatus; placed_at: Date; status_updated_at: Date;
  subtotal_minor: string; special_instructions: string | null; staff_note: string | null; version: number;
  cancel_reason: string | null; table_id: string; table_number: string; table_name: string | null;
  items: { name: string; quantity: number; note: string | null }[];
};

const SUMMARY_SELECT = `
  select o.id, o.order_ref, o.order_no, o.status, o.placed_at, o.status_updated_at, o.subtotal_minor,
         o.special_instructions, o.staff_note, o.version, o.cancel_reason,
         t.id as table_id, t.table_number, t.name as table_name,
         coalesce((select json_agg(json_build_object('name', i.name_snapshot, 'quantity', i.quantity, 'note', i.item_note)
                                   order by i.position)
                     from order_items i where i.order_id = o.id), '[]'::json) as items
    from orders o join dining_tables t on t.id = o.table_id`;

const presentSummary = (row: SummaryRow) => ({
  id: row.id,
  ref: row.order_ref,
  number: row.order_no,
  status: row.status,
  placedAt: row.placed_at,
  statusUpdatedAt: row.status_updated_at,
  subtotalMinor: Number(row.subtotal_minor),
  table: { id: row.table_id, tableNumber: row.table_number, name: row.table_name },
  items: row.items,
  itemCount: row.items.reduce((total, item) => total + item.quantity, 0),
  specialInstructions: row.special_instructions,
  staffNote: row.staff_note,
  cancelReason: row.cancel_reason,
  version: row.version,
});

export function orderRoutes({ db, verify, cookieSecure }: OrderDeps): Router {
  const router = Router();
  router.use(authenticate({ db, verify, cookieSecure }));

  const restaurantInfo = async (client: pg.PoolClient, restaurantId: string) =>
    (await client.query<{ timezone: string; currency: string }>(
      'select timezone, currency from restaurants where id = $1', [restaurantId])).rows[0]!;

  const audit = async (client: pg.PoolClient, req: Request, action: string, id: string, summary: Record<string, unknown>) => {
    const principal = staffPrincipal(req);
    await client.query(
      `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary, ip, request_id)
       values ($1, $2, $3, $4, 'order', $5, $6, $7, $8)`,
      [principal.restaurantId, principal.userId, principal.role, action, id, JSON.stringify(summary), req.clientIp, req.requestId]);
  };

  /** One order in full, as the caller's role may see it. */
  const loadDetail = async (client: pg.PoolClient, req: Request, id: string) => {
    const principal = staffPrincipal(req);
    const found = await client.query<SummaryRow>(`${SUMMARY_SELECT} where o.id = $1`, [id]);
    const row = found.rows[0];
    if (!row) return null;
    const lines = await client.query<{
      name_snapshot: string; quantity: number; unit_price_minor: string; line_total_minor: string; item_note: string | null;
    }>(`select name_snapshot, quantity, unit_price_minor, line_total_minor, item_note
          from order_items where order_id = $1 order by position`, [id]);
    const history = await client.query<{
      from_status: OrderStatus | null; to_status: OrderStatus; changed_by_role: StaffRole | null; reason: string | null; created_at: Date;
    }>(`select from_status, to_status, changed_by_role, reason, created_at
          from order_status_history where order_id = $1 order by id`, [id]);
    // Contact details only for the roles allowed them (PRD §8). Kitchen is not;
    // RLS would also return nothing if this ever ran for kitchen.
    const contact = can(principal, 'order.read.contact')
      ? (await client.query<{ mobile: string | null; email: string | null }>(
          'select mobile, email from order_customers where order_id = $1 and anonymized_at is null', [id])).rows[0] ?? null
      : undefined;
    const { timezone, currency } = await restaurantInfo(client, principal.restaurantId);
    return {
      ...presentSummary(row),
      lines: lines.rows.map((line) => ({
        name: line.name_snapshot, quantity: line.quantity, unitPriceMinor: Number(line.unit_price_minor),
        lineTotalMinor: Number(line.line_total_minor), note: line.item_note,
      })),
      history: history.rows.map((entry) => ({
        from: entry.from_status, to: entry.to_status, byRole: entry.changed_by_role, reason: entry.reason, at: entry.created_at,
      })),
      // Present only for roles that may see contact details; null when none were given.
      ...(contact === undefined ? {} : { contact: contact ? { mobile: contact.mobile, email: contact.email } : null }),
      timezone,
      currency,
    };
  };

  // --------------------------------------------------------------------- list
  router.get('/', requirePermission('order.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const query = parse(listQuery, req.query);
      const kitchen = query.view === 'kitchen';

      const statuses = query.status
        ? query.status.split(',').map((each) => statusEnum.safeParse(each.trim()))
        : null;
      if (statuses?.some((each) => !each.success)) throw badRequest('VALIDATION_FAILED', 'Unknown status filter.');
      const statusFilter = kitchen ? [...ACTIVE_STATUSES] : statuses?.map((each) => each.data!) ?? null;
      if (kitchen && query.cursor) throw badRequest('VALIDATION_FAILED', 'The kitchen view is not paged.');
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const limit = kitchen ? KITCHEN_LIMIT : query.limit ?? 50;
      // A number search matches the reference ("A-12") or the plain number ("12").
      const search = query.q ? query.q.replace(/[\\%_]/g, (char) => `\\${char}`) : null;

      const data = await db.asStaff(principal, async (client) => {
        const { timezone, currency } = await restaurantInfo(client, principal.restaurantId);
        const rows = await client.query<SummaryRow>(
          `${SUMMARY_SELECT}
            where ($1::order_status[] is null or o.status = any($1::order_status[]))
              and ($2::uuid is null or o.table_id = $2)
              -- Dates are the restaurant's own days, in its timezone (NFR-D05).
              and ($3::date is null or o.placed_at >= ($3::date)::timestamp at time zone $9)
              and ($4::date is null or o.placed_at < ($4::date + 1)::timestamp at time zone $9)
              and ($5::text is null or o.order_ref ilike $5 || '%' or o.order_no::text = $5)
              and ($6::timestamptz is null or (o.placed_at, o.id) < ($6::timestamptz, $7::uuid))
            order by ${kitchen ? 'o.placed_at asc, o.id asc' : 'o.placed_at desc, o.id desc'}
            limit $8`,
          [statusFilter, query.table ?? null, query.from ?? null, query.to ?? null, search,
           cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1, timezone]);
        return { timezone, currency, rows: rows.rows };
      });

      const page = data.rows.slice(0, limit);
      const last = page[page.length - 1];
      res.status(200).json({
        orders: page.map(presentSummary),
        nextCursor: !kitchen && data.rows.length > limit && last ? encodeCursor(last.placed_at, last.id) : null,
        truncated: kitchen && data.rows.length > limit,
        timezone: data.timezone,
        currency: data.currency,
      });
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------------------- live
  /**
   * Live updates (FR-050; design D-05: cursor polling every 3 s). Returns whether
   * anything changed since the cursor, which orders are new, and the next cursor.
   */
  router.get('/live', requirePermission('order.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const { since } = parse(liveQuery, req.query);
      const data = await db.asStaff(principal, async (client) => {
        const now = (await client.query<{ now: Date }>('select statement_timestamp() as now')).rows[0]!.now;
        if (!since) return { now, changed: [] as { id: string; version: number; placed_at: Date; order_ref: string; table_number: string }[] };
        const changed = await client.query<{ id: string; version: number; placed_at: Date; order_ref: string; table_number: string }>(
          `select o.id, o.version, o.placed_at, o.order_ref, t.table_number
             from orders o join dining_tables t on t.id = o.table_id
            where o.updated_at > $1::timestamptz - make_interval(secs => $2)
            order by o.updated_at
            limit 500`, [since, LIVE_OVERLAP_SECONDS]);
        return { now, changed: changed.rows };
      });
      const sinceTime = since ? Date.parse(since) - LIVE_OVERLAP_SECONDS * 1000 : Infinity;
      res.status(200).json({
        cursor: data.now.toISOString(),
        changes: data.changed.map((row) => ({ id: row.id, version: row.version })),
        newOrders: data.changed
          .filter((row) => row.placed_at.getTime() > sinceTime)
          .map((row) => ({ id: row.id, ref: row.order_ref, tableNumber: row.table_number })),
      });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- detail
  router.get('/:id', requirePermission('order.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = orderId(req);
      const order = await db.asStaff(principal, (client) => loadDetail(client, req, id));
      if (!order) throw notFound();
      res.status(200).json({ order });
    } catch (error) {
      next(error);
    }
  });

  /** Locks the order for this transaction and checks the caller's version (FR-058). */
  const lockForChange = async (client: pg.PoolClient, id: string, expectedVersion: number) => {
    const found = await client.query<{ status: OrderStatus; version: number; order_ref: string }>(
      'select status, version, order_ref from orders where id = $1 for update', [id]);
    const row = found.rows[0];
    if (!row) throw notFound();
    if (row.version !== expectedVersion) {
      throw conflict('STALE_VERSION', 'Someone else has just updated this order. It has been refreshed; please check it and try again.');
    }
    return row;
  };

  /** The database guard is the second line: if it refuses, answer as the API would have. */
  const guardRefusal = (error: unknown): never => {
    const code = (error as { code?: string }).code;
    if (code === '23514') throw conflict('ILLEGAL_TRANSITION', 'That status change is not allowed.');
    if (code === '42501') throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do that.');
    throw error;
  };

  // ------------------------------------------------------------------- status
  router.post('/:id/status', requirePermission('order.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = orderId(req);
      const body = parse(statusBody, req.body);

      const order = await db.asStaff(principal, async (client) => {
        const current = await lockForChange(client, id, body.version);
        const from = current.status;
        const legalForAnyone = STAFF_ROLES.some((role) => canTransition(role, from, body.to));
        if (!legalForAnyone) {
          throw conflict('ILLEGAL_TRANSITION', `An order that is ${from} cannot be marked ${body.to}.`);
        }
        if (!canTransition(principal.role, from, body.to)) {
          throw new AppError(403, 'FORBIDDEN', 'Your role cannot make that change.');
        }
        const cancelling = body.to === 'cancelled';
        if (cancelling && !body.reason) {
          throw badRequest('REASON_REQUIRED', 'Give a reason for cancelling this order.',
            [{ field: 'reason', message: 'Give a reason for cancelling this order.' }]);
        }
        await client.query(`select set_config('app.status_reason', $1, true)`, [cancelling ? body.reason! : '']);
        await client.query(
          `update orders set status = $2::order_status, version = version + 1,
                  cancel_reason = case when $2::order_status = 'cancelled' then $3 else cancel_reason end,
                  cancelled_by = case when $2::order_status = 'cancelled' then $4::uuid else cancelled_by end
            where id = $1`,
          [id, body.to, cancelling ? body.reason : null, principal.userId]).catch(guardRefusal);
        if (cancelling) {
          await audit(client, req, 'order.cancelled', id, { ref: current.order_ref, from, reason: body.reason });
        }
        return loadDetail(client, req, id);
      });
      res.status(200).json({ order });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- revert
  /** One step back, owner and manager only, with a reason; audited (FR-053). */
  router.post('/:id/revert', requirePermission('order.revert'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = orderId(req);
      const body = parse(revertBody, req.body);
      const order = await db.asStaff(principal, async (client) => {
        const current = await lockForChange(client, id, body.version);
        const to = revertTarget(current.status);
        if (!to || !canRevert(principal.role, current.status)) {
          throw conflict('ILLEGAL_TRANSITION', `An order that is ${current.status} cannot be taken back a step.`);
        }
        await client.query(`select set_config('app.status_reason', $1, true)`, [body.reason]);
        await client.query('update orders set status = $2::order_status, version = version + 1 where id = $1', [id, to])
          .catch(guardRefusal);
        await audit(client, req, 'order.reverted', id, { ref: current.order_ref, from: current.status, to, reason: body.reason });
        return loadDetail(client, req, id);
      });
      res.status(200).json({ order });
    } catch (error) {
      next(error);
    }
  });

  // --------------------------------------------------------------- staff note
  /** An internal note, never shown to the customer (FR-059). */
  router.patch('/:id/staff-note', requirePermission('order.staffNote'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = orderId(req);
      const body = parse(noteBody, req.body);
      const order = await db.asStaff(principal, async (client) => {
        await lockForChange(client, id, body.version);
        await client.query('update orders set staff_note = $2, version = version + 1 where id = $1',
          [id, body.note || null]).catch(guardRefusal);
        return loadDetail(client, req, id);
      });
      res.status(200).json({ order });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
