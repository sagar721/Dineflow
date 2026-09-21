// Dining tables and their QR codes (PRD FR-010 … FR-017; design/07 §5).
//
// Tenant scope comes from the authenticated membership and RLS, never from the
// request: none of these routes accept a restaurant id.
import { Router, type Request } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { can } from '@dineflow/shared';
import type pg from 'pg';
import type { Database } from '../../lib/db.ts';
import { badRequest, conflict, notFound } from '../../lib/errors.ts';
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

const createBody = z.object({ tableNumber, name: tableName.nullish(), capacity }).strict();
const updateBody = z
  .object({ tableNumber: tableNumber.optional(), name: tableName.nullish(), capacity: capacity.optional(),
            version: z.number().int().min(1) })
  .strict();
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
  id: string; table_number: string; name: string | null; capacity: number;
  status: 'active' | 'inactive'; version: number; created_at: Date; updated_at: Date;
  qr_issued_at?: Date | null;
};

const present = (row: TableRow, withQr: boolean) => ({
  id: row.id,
  tableNumber: row.table_number,
  name: row.name,
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

  /** The printable form of a live QR. The token is derived here and never stored. */
  const qrPayload = async (row: { qr_id: string; key_id: number; created_at: Date }) => {
    const url = `${appBaseUrl.replace(/\/$/, '')}/t/${signQrToken(qrKeys, row.qr_id, row.key_id)}`;
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
          `select t.id, t.table_number, t.name, t.capacity, t.status, t.version, t.created_at, t.updated_at,
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

  // ---------------------------------------------------------------------- one
  router.get('/:id', requirePermission('table.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = tableId(req);
      const row = await db.asStaff(principal, async (client) => {
        const result = await client.query<TableRow>(
          `select t.id, t.table_number, t.name, t.capacity, t.status, t.version, t.created_at, t.updated_at,
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
            `insert into dining_tables (restaurant_id, table_number, name, capacity)
             values ($1, $2, $3, $4)
             returning id, table_number, name, capacity, status, version, created_at, updated_at`,
            [principal.restaurantId, body.tableNumber, body.name ?? null, body.capacity])
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
               version = version + 1
             where id = $1 and version = $6
             returning id, table_number, name, capacity, status, version, created_at, updated_at`,
            [id, body.tableNumber ?? null, body.name !== undefined, body.name ?? null,
             body.capacity ?? null, body.version])
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
            returning id, table_number, name, capacity, status, version, created_at, updated_at`,
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
      `insert into table_qr_tokens (restaurant_id, table_id, key_id, created_by)
       values ($1, $2, $3, $4) returning qr_id, key_id, created_at`,
      [principal.restaurantId, id, qrKeys.currentKid, principal.userId]);
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

/** Search text is matched literally: % and _ typed by a user are not wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
