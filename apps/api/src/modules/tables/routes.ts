// Dining tables and their QR codes (PRD FR-010 … FR-018; design/07 §5).
//
// Tenant scope comes from the authenticated membership and RLS, never from the
// request: none of these routes accept a restaurant id.
import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { can } from '@dineflow/shared';
import type pg from 'pg';
import type { Database } from '../../lib/db.ts';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.ts';
import { authenticate, requirePermission, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';
import { signQrToken, type QrKeyring } from '../../lib/qr-token.ts';

export type TableDeps = {
  db: Database;
  verify: Verifier;
  cookieSecure: boolean;
  appBaseUrl: string;
  qrKeys: QrKeyring;
  /** See config QR_DOMAIN_FINAL: until true, QR cards are provisional. */
  qrDomainFinal: boolean;
};

// Trimmed, then checked: surrounding spaces would make "T1" and "T1 " different
// tables to a person and the same table to nobody.
const tableNumber = z.string().trim().min(1).max(20);
const tableName = z.string().trim().min(1).max(60);
const capacity = z.number().int().min(1).max(100);
// Staff-only notes (FR-011). Never part of anything a customer can reach.
const tableNotes = z.string().trim().min(1).max(500);

const createBody = z.object({ tableNumber, name: tableName.nullish(), notes: tableNotes.nullish(), capacity }).strict();
const updateBody = z
  .object({ tableNumber: tableNumber.optional(), name: tableName.nullish(), notes: tableNotes.nullish(),
            capacity: capacity.optional(), version: z.number().int().min(1) })
  .strict();

// Bulk creation (FR-018): "T" + 1…20 makes T1 … T20. Capped so one request stays one
// quick transaction, and all-or-nothing so a clash leaves no half-made range behind.
const MAX_BULK_TABLES = 100;
const bulkBody = z
  .object({
    prefix: z.string().trim().max(10).default(''),
    from: z.number().int().min(0).max(9999),
    to: z.number().int().min(0).max(9999),
    capacity,
  })
  .strict()
  .refine((body) => body.to >= body.from, { path: ['to'], message: 'Must not be less than the first number.' })
  .refine((body) => body.to - body.from + 1 <= MAX_BULK_TABLES,
    { path: ['to'], message: `At most ${MAX_BULK_TABLES} tables at a time.` });
const statusBody = z
  .object({ status: z.enum(['active', 'inactive']), reason: z.string().trim().max(200).optional(),
            version: z.number().int().min(1) })
  .strict();
const listQuery = z
  .object({ status: z.enum(['active', 'inactive']).optional(), search: z.string().trim().max(40).optional() })
  .strict();

const MAX_TABLES_LISTED = 500;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('VALIDATION_FAILED', 'Please check the details you entered.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  }
  return result.data;
}

const tableId = (req: Request): string => {
  const id = z.string().uuid().safeParse(req.params.id);
  // A malformed id is treated like a missing table rather than a validation error,
  // so probing with junk ids learns nothing different from probing with real ones.
  if (!id.success) throw notFound();
  return id.data;
};

/** Postgres unique violations on the table-number index become a clear 409. */
function duplicateNumber(error: unknown): never {
  if ((error as { code?: string }).code === '23505') {
    throw conflict('TABLE_NUMBER_TAKEN', 'Another table already uses that number.');
  }
  throw error;
}

type TableRow = {
  id: string; table_number: string; name: string | null; notes: string | null; capacity: number;
  status: 'active' | 'inactive'; version: number; created_at: Date; updated_at: Date;
  qr_issued_at?: Date | null;
};

const present = (row: TableRow, withQr: boolean) => ({
  id: row.id,
  tableNumber: row.table_number,
  name: row.name,
  notes: row.notes,
  capacity: row.capacity,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // Only roles that may see QR codes learn whether one exists. For others the
  // answer would be a guess, since RLS hides the QR rows from them.
  ...(withQr ? { qr: row.qr_issued_at ? { issuedAt: row.qr_issued_at } : null } : {}),
});

export function tableRoutes(deps: TableDeps): Router {
  const { db, verify, cookieSecure, appBaseUrl, qrKeys, qrDomainFinal } = deps;
  const router = Router();
  router.use(authenticate({ db, verify, cookieSecure }));

  const audit = async (
    client: pg.PoolClient, req: Request, action: string, entityId: string, summary: Record<string, unknown>,
  ) => {
    const principal = staffPrincipal(req);
    await client.query(
      `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary, ip, request_id)
       values ($1, $2, $3, $4, 'table', $5, $6, $7, $8)`,
      [principal.restaurantId, principal.userId, principal.role, action, entityId,
       JSON.stringify(summary), req.clientIp, req.requestId]);
  };

  /** The link a live QR encodes. The token is derived here and never stored. */
  const qrUrl = (row: { qr_id: string; key_id: number }) =>
    `${appBaseUrl.replace(/\/$/, '')}/t/${signQrToken(qrKeys, row.qr_id, row.key_id)}`;

  /** The printable form of a live QR. */
  const qrPayload = async (row: { qr_id: string; key_id: number; created_at: Date }) => {
    const url = qrUrl(row);
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'H', margin: 2 });
    return { url, svg, issuedAt: row.created_at, provisional: !qrDomainFinal };
  };

  // --------------------------------------------------------------------- list
  router.get('/', requirePermission('table.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const query = parse(listQuery, req.query);
      const withQr = can(principal, 'qr.read');

      const rows = await db.asStaff(principal, async (client) => {
        const result = await client.query<TableRow>(
          `select t.id, t.table_number, t.name, t.notes, t.capacity, t.status, t.version, t.created_at, t.updated_at,
                  (select q.created_at from table_qr_tokens q
                    where q.table_id = t.id and q.revoked_at is null) as qr_issued_at
             from dining_tables t
            where ($1::table_status is null or t.status = $1::table_status)
              and ($2::text is null or t.table_number ilike '%' || $2 || '%' or t.name ilike '%' || $2 || '%')
            order by t.created_at, t.id
            limit $3`,
          [query.status ?? null, query.search ? escapeLike(query.search) : null, MAX_TABLES_LISTED + 1]);
        return result.rows;
      });

      res.status(200).json({
        tables: rows.slice(0, MAX_TABLES_LISTED).map((row) => present(row, withQr)),
        truncated: rows.length > MAX_TABLES_LISTED,
      });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------ QR sheet
  /**
   * Every printable code, for the A4 sheet (FR-015): active tables with a live QR,
   * in this restaurant only. Also says how many active tables still lack a code, so
   * the sheet can offer to generate them rather than silently leaving gaps.
   */
  router.get('/qr-sheet', requirePermission('qr.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const data = await db.asStaff(principal, async (client) => {
        const restaurant = await client.query<{ name: string }>(
          'select name from restaurants where id = $1', [principal.restaurantId]);
        const codes = await client.query<{
          table_number: string; name: string | null; qr_id: string; key_id: number; created_at: Date;
        }>(
          `select t.table_number, t.name, q.qr_id, q.key_id, q.created_at
             from dining_tables t
             join table_qr_tokens q on q.table_id = t.id and q.revoked_at is null
            where t.status = 'active'
            order by t.created_at, t.id
            limit $1`, [MAX_TABLES_LISTED]);
        const missing = await client.query<{ count: string }>(
          `select count(*) from dining_tables t
            where t.status = 'active'
              and not exists (select 1 from table_qr_tokens q where q.table_id = t.id and q.revoked_at is null)`);
        return { restaurantName: restaurant.rows[0]?.name ?? '', codes: codes.rows, missing: Number(missing.rows[0]!.count) };
      });

      const cards = await Promise.all(data.codes.map(async (row) => {
        const qr = await qrPayload(row);
        return { tableNumber: row.table_number, name: row.name, url: qr.url, svg: qr.svg };
      }));
      res.status(200).json({
        restaurantName: data.restaurantName,
        provisional: !qrDomainFinal,
        cards,
        activeTablesWithoutQr: data.missing,
      });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------------- bulk
  router.post('/bulk', requirePermission('table.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(bulkBody, req.body);
      const numbers = Array.from({ length: body.to - body.from + 1 }, (_, i) => `${body.prefix}${body.from + i}`);
      if (numbers.some((number) => number.length > 20)) {
        throw badRequest('VALIDATION_FAILED', 'Please check the details you entered.',
          [{ field: 'prefix', message: 'Table numbers must be 20 characters or fewer.' }]);
      }

      const rows = await db.asStaff(principal, async (client) => {
        // Named up front, so the answer can say which numbers clash. The unique
        // index still decides if another request slips in between.
        const clashes = await client.query<{ table_number: string }>(
          `select table_number from dining_tables where lower(table_number) = any($1::text[])`,
          [numbers.map((number) => number.toLowerCase())]);
        if ((clashes.rowCount ?? 0) > 0) {
          throw new AppError(409, 'TABLE_NUMBER_TAKEN', 'Some of those table numbers are already used.',
            clashes.rows.map((row) => ({ field: 'tableNumber', message: row.table_number })));
        }
        const created = await client
          .query<TableRow>(
            `insert into dining_tables (restaurant_id, table_number, capacity)
             select $1, number, $3 from unnest($2::text[]) with ordinality as n(number, position)
              order by position
             returning id, table_number, name, notes, capacity, status, version, created_at, updated_at`,
            [principal.restaurantId, numbers, body.capacity])
          .catch(duplicateNumber);
        for (const table of created.rows) {
          await audit(client, req, 'table.created', table.id,
            { tableNumber: table.table_number, capacity: table.capacity, bulk: true });
        }
        return created.rows;
      });

      const withQr = can(principal, 'qr.read');
      res.status(201).json({ tables: rows.map((row) => present({ ...row, qr_issued_at: null }, withQr)) });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------- generate missing QRs
  /** Issues a code for every active table that has none. Existing codes are untouched. */
  router.post('/qr/issue-missing', requirePermission('qr.rotate'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const issued = await db.asStaff(principal, async (client) => {
        // Locks the tables it will issue for, in a fixed order, so it cannot race a
        // single-table generate into a second live code (the unique index backs this).
        const needing = await client.query<{ id: string }>(
          `select t.id from dining_tables t
            where t.status = 'active'
              and not exists (select 1 from table_qr_tokens q where q.table_id = t.id and q.revoked_at is null)
            order by t.id
            for update of t`);
        let count = 0;
        for (const { id } of needing.rows) {
          if (await liveQr(client, id)) continue;
          await issueQr(client, req, id);
          await audit(client, req, 'table.qr.issued', id, { bulk: true });
          count += 1;
        }
        return count;
      });
      res.status(200).json({ issued });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------------- one
  router.get('/:id', requirePermission('table.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const row = await db.asStaff(principal, async (client) => {
        const result = await client.query<TableRow>(
          `select t.id, t.table_number, t.name, t.notes, t.capacity, t.status, t.version, t.created_at, t.updated_at,
                  (select q.created_at from table_qr_tokens q
                    where q.table_id = t.id and q.revoked_at is null) as qr_issued_at
             from dining_tables t where t.id = $1`, [id]);
        return result.rows[0];
      });
      if (!row) throw notFound();
      res.status(200).json({ table: present(row, can(principal, 'qr.read')) });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- create
  router.post('/', requirePermission('table.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(createBody, req.body);

      const row = await db.asStaff(principal, async (client) => {
        const result = await client
          .query<TableRow>(
            `insert into dining_tables (restaurant_id, table_number, name, notes, capacity)
             values ($1, $2, $3, $4, $5)
             returning id, table_number, name, notes, capacity, status, version, created_at, updated_at`,
            [principal.restaurantId, body.tableNumber, body.name ?? null, body.notes ?? null, body.capacity])
          .catch(duplicateNumber);
        const created = result.rows[0]!;
        await audit(client, req, 'table.created', created.id,
          { tableNumber: created.table_number, capacity: created.capacity });
        return created;
      });

      res.status(201).json({ table: present({ ...row, qr_issued_at: null }, can(principal, 'qr.read')) });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- update
  router.patch('/:id', requirePermission('table.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const body = parse(updateBody, req.body);

      const row = await db.asStaff(principal, async (client) => {
        // Status is deliberately not settable here: an edit to a name must never
        // quietly reactivate a table someone took out of service.
        const result = await client
          .query<TableRow>(
            `update dining_tables set
               table_number = coalesce($2, table_number),
               name = case when $3::boolean then $4 else name end,
               capacity = coalesce($5, capacity),
               notes = case when $7::boolean then $8 else notes end,
               version = version + 1
             where id = $1 and version = $6
             returning id, table_number, name, notes, capacity, status, version, created_at, updated_at`,
            [id, body.tableNumber ?? null, body.name !== undefined, body.name ?? null,
             body.capacity ?? null, body.version, body.notes !== undefined, body.notes ?? null])
          .catch(duplicateNumber);

        if (result.rowCount === 0) {
          const exists = await client.query('select 1 from dining_tables where id = $1', [id]);
          if (exists.rowCount === 0) throw notFound();
          throw conflict('STALE_VERSION', 'Someone else changed this table. Reload and try again.');
        }
        const updated = result.rows[0]!;
        await audit(client, req, 'table.updated', id, {
          fields: Object.keys(body).filter((key) => key !== 'version'),
          tableNumber: updated.table_number,
        });
        return updated;
      });

      res.status(200).json({ table: present(row, false) });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------------- status
  router.patch('/:id/status', requirePermission('table.write'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const body = parse(statusBody, req.body);

      const row = await db.asStaff(principal, async (client) => {
        const result = await client.query<TableRow>(
          `update dining_tables set status = $2, version = version + 1
            where id = $1 and version = $3
            returning id, table_number, name, notes, capacity, status, version, created_at, updated_at`,
          [id, body.status, body.version]);

        if (result.rowCount === 0) {
          const exists = await client.query('select 1 from dining_tables where id = $1', [id]);
          if (exists.rowCount === 0) throw notFound();
          throw conflict('STALE_VERSION', 'Someone else changed this table. Reload and try again.');
        }
        const updated = result.rows[0]!;
        // Deactivating does not revoke the QR: the printed card stops working while
        // the table is out of service and works again when it comes back.
        await audit(client, req, body.status === 'active' ? 'table.activated' : 'table.deactivated', id,
          { tableNumber: updated.table_number, reason: body.reason ?? null });
        return updated;
      });

      res.status(200).json({ table: present(row, false) });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------------- QR
  /** Reads the live QR for a table, or returns null. Caller holds the table lock if needed. */
  const liveQr = async (client: pg.PoolClient, id: string) => {
    const result = await client.query<{ qr_id: string; key_id: number; created_at: Date }>(
      `select qr_id, key_id, created_at from table_qr_tokens where table_id = $1 and revoked_at is null`, [id]);
    return result.rows[0] ?? null;
  };

  /** Locks the table so QR changes for it are serialised. Returns false if hidden or absent. */
  const lockTable = async (client: pg.PoolClient, id: string) => {
    const result = await client.query('select id from dining_tables where id = $1 for update', [id]);
    return (result.rowCount ?? 0) > 0;
  };

  const issueQr = async (client: pg.PoolClient, req: Request, id: string) => {
    const principal = staffPrincipal(req);
    const result = await client.query<{ qr_id: string; key_id: number; created_at: Date }>(
      `insert into table_qr_tokens (restaurant_id, table_id, qr_id, key_id, created_by)
       values ($1, $2, $3, $4, $5) returning qr_id, key_id, created_at`,
      [principal.restaurantId, id, randomQrId(), qrKeys.currentKid, principal.userId]);
    return result.rows[0]!;
  };

  router.get('/:id/qr', requirePermission('qr.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const qr = await db.asStaff(principal, async (client) => {
        const exists = await client.query('select 1 from dining_tables where id = $1', [id]);
        if (exists.rowCount === 0) throw notFound();
        return liveQr(client, id);
      });
      if (!qr) throw notFound('This table has no QR code yet.');
      res.status(200).json({ qr: await qrPayload(qr) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * The live QR as a PNG file (FR-015), for print shops and apps that do not take
   * SVG. Same code, same link; only the file format differs.
   */
  router.get('/:id/qr/png', requirePermission('qr.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const found = await db.asStaff(principal, async (client) => {
        const table = await client.query<{ table_number: string }>(
          'select table_number from dining_tables where id = $1', [id]);
        if (table.rowCount === 0) throw notFound();
        return { tableNumber: table.rows[0]!.table_number, qr: await liveQr(client, id) };
      });
      if (!found.qr) throw notFound('This table has no QR code yet.');

      const png = await QRCode.toBuffer(qrUrl(found.qr),
        { type: 'png', errorCorrectionLevel: 'H', margin: 2, width: 1024 });
      const fileName = `table-${found.tableNumber.replace(/[^A-Za-z0-9-]+/g, '-')}-qr.png`;
      res.status(200)
        .set('content-type', 'image/png')
        .set('content-disposition', `attachment; filename="${fileName}"`)
        .send(png);
    } catch (error) {
      next(error);
    }
  });

  /** Issues a QR if the table has none; otherwise returns the existing one. */
  router.post('/:id/qr', requirePermission('qr.rotate'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const { qr, created } = await db.asStaff(principal, async (client) => {
        if (!(await lockTable(client, id))) throw notFound();
        const existing = await liveQr(client, id);
        if (existing) return { qr: existing, created: false };
        const issued = await issueQr(client, req, id);
        await audit(client, req, 'table.qr.issued', id, {});
        return { qr: issued, created: true };
      });
      res.status(created ? 201 : 200).json({ qr: await qrPayload(qr), created });
    } catch (error) {
      next(error);
    }
  });

  /** Replaces the live QR. The old card stops working the moment this commits. */
  router.post('/:id/qr/regenerate', requirePermission('qr.rotate'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const qr = await db.asStaff(principal, async (client) => {
        // The row lock serialises concurrent regenerations of one table, so two
        // clicks produce two sequential rotations and never two live codes.
        if (!(await lockTable(client, id))) throw notFound();
        const revoked = await client.query(
          `update table_qr_tokens set revoked_at = now(), revoked_by = $2
            where table_id = $1 and revoked_at is null`, [id, principal.userId]);
        const issued = await issueQr(client, req, id);
        await audit(client, req, 'table.qr.regenerated', id, { replacedPrevious: (revoked.rowCount ?? 0) > 0 });
        return issued;
      });
      res.status(201).json({ qr: await qrPayload(qr) });
    } catch (error) {
      next(error);
    }
  });

  /** Revokes the live QR. Repeating it is harmless and says whether anything changed. */
  router.post('/:id/qr/revoke', requirePermission('qr.rotate'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const revoked = await db.asStaff(principal, async (client) => {
        if (!(await lockTable(client, id))) throw notFound();
        const result = await client.query(
          `update table_qr_tokens set revoked_at = now(), revoked_by = $2
            where table_id = $1 and revoked_at is null`, [id, principal.userId]);
        const changed = (result.rowCount ?? 0) > 0;
        if (changed) await audit(client, req, 'table.qr.revoked', id, {});
        return changed;
      });
      res.status(200).json({ revoked });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * A fresh qr_id: 128 random bits in uuid form (NFR-S13). gen_random_uuid() would
 * give a version-4 uuid, which fixes 6 of those bits and leaves only 122 random.
 */
function randomQrId(): string {
  const hex = randomBytes(16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Search text is matched literally: % and _ typed by a user are not wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
