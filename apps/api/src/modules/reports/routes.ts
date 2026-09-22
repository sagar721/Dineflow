// Sales report (PRD FR-084; design/02 §6.8; approved billing decision 8): sales by
// day and by payment method, on the restaurant's own days (its timezone), as JSON or
// as a CSV download.
//
// Owners and managers see all sales. Billing staff see the sales they billed
// themselves (bills they finalized, payments they recorded), per design/02 §6.8.
// Void bills are not sales; they are counted separately so they stay visible.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { minorToDecimal, type Currency } from '@dineflow/shared';
import type { Database } from '../../lib/db.ts';
import { badRequest } from '../../lib/errors.ts';
import { authenticate, requirePermission, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';

export type ReportDeps = { db: Database; verify: Verifier; cookieSecure: boolean };

const MAX_DAYS = 366;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a date.');
const salesQuery = z.object({
  from: isoDate,
  to: isoDate,
  groupBy: z.enum(['day', 'method']).default('day'),
}).strict();

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starting with =, +,
 * -, @, tab or carriage return) is prefixed with an apostrophe; every text cell is
 * quoted. Numbers are written as they are.
 */
export function csvCell(value: string | number): string {
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
const csvRow = (cells: (string | number)[]) => cells.map(csvCell).join(',');

type DayRow = {
  day: string; bills: number; voided: number; subtotal: string; discount: string; service: string; tax: string;
  rounding: string; total: string;
};
type MethodRow = { method: string; payments: number; amount: string };

export function reportRoutes({ db, verify, cookieSecure }: ReportDeps): Router {
  const router = Router();
  router.use(authenticate({ db, verify, cookieSecure }));

  /**
   * The report itself is a plain read (GET). The CSV **export** is a POST: it is
   * recorded in the activity log, and a write must not sit behind a GET, which the
   * CSRF guard deliberately exempts. Both take the same parameters.
   */
  const sales = (csv: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = staffPrincipal(req);
      const parsed = salesQuery.safeParse(req.query);
      if (!parsed.success) {
        throw badRequest('VALIDATION_FAILED', 'Choose a start and end date.',
          parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
      }
      const query = parsed.data;
      const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 + 1;
      if (days < 1) throw badRequest('VALIDATION_FAILED', 'The end date is before the start date.');
      if (days > MAX_DAYS) throw badRequest('VALIDATION_FAILED', `Choose at most ${MAX_DAYS} days.`);
      // Billing staff: only what they billed themselves.
      const onlyUser = principal.role === 'billing' ? principal.userId : null;

      const data = await db.asStaff(principal, async (client) => {
        const { rows: [info] } = await client.query<{ timezone: string; currency: Currency; name: string }>(
          'select timezone, currency, name from restaurants where id = $1', [principal.restaurantId]);
        const range = [query.from, query.to, info!.timezone, onlyUser] as const;
        if (query.groupBy === 'day') {
          const { rows } = await client.query<DayRow>(
            `select to_char((b.finalized_at at time zone $3)::date, 'YYYY-MM-DD') as day,
                    count(*) filter (where b.status = 'finalized')::int as bills,
                    count(*) filter (where b.status = 'void')::int as voided,
                    coalesce(sum(b.subtotal_minor) filter (where b.status = 'finalized'), 0) as subtotal,
                    coalesce(sum(b.discount_minor) filter (where b.status = 'finalized'), 0) as discount,
                    coalesce(sum(b.service_charge_minor) filter (where b.status = 'finalized'), 0) as service,
                    coalesce(sum(b.tax_total_minor) filter (where b.status = 'finalized'), 0) as tax,
                    coalesce(sum(b.rounding_minor) filter (where b.status = 'finalized'), 0) as rounding,
                    coalesce(sum(b.total_minor) filter (where b.status = 'finalized'), 0) as total
               from bills b
              where b.status in ('finalized', 'void')
                and b.finalized_at >= ($1::date)::timestamp at time zone $3
                and b.finalized_at < ($2::date + 1)::timestamp at time zone $3
                and ($4::uuid is null or b.finalized_by = $4)
              group by 1 order by 1`, [...range]);
          return { info: info!, rows: rows.map((r) => ({
            day: r.day, bills: r.bills, voidedBills: r.voided, subtotalMinor: Number(r.subtotal), discountMinor: Number(r.discount),
            serviceChargeMinor: Number(r.service), taxMinor: Number(r.tax), roundingMinor: Number(r.rounding), totalMinor: Number(r.total),
          })) };
        }
        const { rows } = await client.query<MethodRow>(
          `select p.method::text as method, count(*)::int as payments, sum(p.amount_minor) as amount
             from payments p
            where p.reversed_at is null
              and p.recorded_at >= ($1::date)::timestamp at time zone $3
              and p.recorded_at < ($2::date + 1)::timestamp at time zone $3
              and ($4::uuid is null or p.recorded_by = $4)
            group by 1 order by 1`, [...range]);
        return { info: info!, rows: rows.map((r) => ({ method: r.method, payments: r.payments, amountMinor: Number(r.amount) })) };
      });

      const totals = data.rows.reduce<Record<string, number>>((sum, row) => {
        for (const [key, value] of Object.entries(row)) if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value;
        return sum;
      }, {});

      if (!csv) {
        res.status(200).json({
          from: query.from, to: query.to, groupBy: query.groupBy, timezone: data.info.timezone, currency: data.info.currency,
          scope: onlyUser ? 'mine' : 'all', rows: data.rows, totals,
        });
        return;
      }

      const money = (minor: number) => minorToDecimal(minor, data.info.currency);
      const lines = query.groupBy === 'day'
        ? [
          csvRow(['Day', 'Bills', 'Voided bills', 'Subtotal', 'Discounts', 'Service charge', 'Tax', 'Rounding', 'Total']),
          ...(data.rows as { day: string; bills: number; voidedBills: number; subtotalMinor: number; discountMinor: number;
            serviceChargeMinor: number; taxMinor: number; roundingMinor: number; totalMinor: number }[]).map((r) => csvRow([
            r.day, r.bills, r.voidedBills, money(r.subtotalMinor), money(r.discountMinor), money(r.serviceChargeMinor),
            money(r.taxMinor), money(r.roundingMinor), money(r.totalMinor)])),
        ]
        : [
          csvRow(['Payment method', 'Payments', 'Amount']),
          ...(data.rows as { method: string; payments: number; amountMinor: number }[])
            .map((r) => csvRow([r.method, r.payments, money(r.amountMinor)])),
        ];
      // Money columns are plain decimals, so a spreadsheet reads them as numbers; the
      // currency is stated in the filename and the header comment row.
      const body = [csvRow([`${data.info.name} — sales ${query.from} to ${query.to} (${data.info.timezone}, ${data.info.currency})`]),
        ...lines].join('\r\n');

      await db.asStaff(principal, (client) => client.query(
        `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary, ip, request_id)
         values ($1, $2, $3, 'report.sales.exported', 'report', null, $4, $5, $6)`,
        [principal.restaurantId, principal.userId, principal.role,
         JSON.stringify({ from: query.from, to: query.to, groupBy: query.groupBy, scope: onlyUser ? 'mine' : 'all' }),
         req.clientIp, req.requestId]));

      res.status(200)
        .type('text/csv; charset=utf-8')
        .set('content-disposition', `attachment; filename="sales-by-${query.groupBy}-${query.from}-to-${query.to}-${data.info.currency}.csv"`)
        .set('cache-control', 'no-store')
        .send(`﻿${body}\r\n`);
    } catch (error) {
      next(error);
    }
  };

  router.get('/sales', requirePermission('report.sales'), sales(false));
  router.post('/sales/export', requirePermission('report.sales'), sales(true));

  return router;
}
