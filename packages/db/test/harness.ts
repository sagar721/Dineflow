// The isolation harness (ISO-04 … ISO-11).
//
// Probes run through the same transaction wrappers the API uses, as the same
// non-privileged login role, so a pass here is evidence about production behaviour
// rather than about the test's own privileges.
import pg from 'pg';
import { withNoContextTx, withPublicTx, withStaffTx } from '../src/context.ts';
import { listPublicTables, isTenantTable } from '../src/schema-guard.ts';
import { MARKER, type Fixtures } from './fixtures.ts';
import { PRINCIPALS, TABLES, type Cell, type Principal, type TableSpec } from './isolation-matrix.ts';

export type Check = { name: string; passed: boolean; detail?: string };

/** Thrown to unwind a probe transaction: write probes must never leave data behind. */
class Rollback extends Error {
  payload: unknown;
  constructor(payload: unknown) {
    super('probe rollback');
    this.payload = payload;
  }
}

type Probe<T> = (run: <R>(body: () => Promise<R>) => Promise<R>) => Promise<T>;

/** Runs `probe` under the identity of `principal`, always rolling back. */
async function asPrincipal<T>(client: pg.Client, principal: Principal, fx: Fixtures, probe: Probe<T>): Promise<T> {
  const wrap = <R,>(body: () => Promise<R>): Promise<R> => {
    switch (principal.how.kind) {
      case 'staff':
        return withStaffTx(client, { userId: fx[principal.how.userOf] as string, aal: principal.how.aal }, body);
      case 'public':
        return withPublicTx(client, principal.how.restaurantOf ? (fx[principal.how.restaurantOf] as string) : null, body);
      case 'none':
        return withNoContextTx(client, body);
    }
  };
  return probe(wrap);
}

/** Reads every visible row of a table and reports which tenants they belong to. */
async function readProbe(client: pg.Client, principal: Principal, fx: Fixtures, spec: TableSpec) {
  try {
    return await asPrincipal(client, principal, fx, async (run) =>
      run(async () => {
        const markerColumn = principal.how.kind === 'public' && spec.publicMarkerColumn
          ? spec.publicMarkerColumn
          : spec.markerColumn;
        const { rows } = await client.query<{ tenant: string | null; marker: string | null }>(
          `select ${spec.tenantColumn}::text as tenant, ${markerColumn} as marker from ${spec.table}`,
        );
        return { denied: false, rows };
      }));
  } catch (error) {
    return { denied: true, rows: [] as { tenant: string | null; marker: string | null }[], error: (error as Error).message };
  }
}

async function writeProbe(client: pg.Client, principal: Principal, fx: Fixtures, sql: string, params: unknown[]) {
  try {
    await asPrincipal(client, principal, fx, async (run) =>
      run(async () => {
        const result = await client.query(sql, params);
        // Always unwind: probes must not change the fixture set.
        throw new Rollback(result.rowCount);
      }));
    return { allowed: true, rows: 0 };
  } catch (error) {
    if (error instanceof Rollback) return { allowed: (error.payload as number) > 0, rows: error.payload as number };
    return { allowed: false, error: (error as Error).message };
  }
}

/** SQL that inserts one row of `spec` belonging to `restaurantId`. */
function insertFor(spec: TableSpec, restaurantId: string, userId: string, actingUserId: string, fx: Fixtures): { sql: string; params: unknown[] } {
  const target = fx.probeTargets[restaurantId];
  switch (spec.table) {
    case 'restaurants':
      return { sql: `insert into restaurants (slug, name) values ($1, $2)`,
               params: [`probe-${Math.random().toString(36).slice(2, 10)}`, 'PROBE Restaurant'] };
    case 'restaurant_users':
      return { sql: `insert into restaurant_users (restaurant_id, user_id, role, email, display_name)
                     values ($1, $2, 'kitchen', 'probe@example.test', 'PROBE staff')`,
               params: [restaurantId, userId] };
    case 'support_grants':
      return { sql: `insert into support_grants (restaurant_id, admin_user_id, reason, expires_at)
                     values ($1, $2, 'PROBE support access reason', now() + interval '1 hour')`,
               // A grant records who is looking, so it can only ever name the caller.
               params: [restaurantId, actingUserId] };
    case 'audit_log':
      return { sql: `insert into audit_log (restaurant_id, action, entity_type) values ($1, 'probe.write', 'probe')`,
               params: [restaurantId] };
    case 'platform_admins':
      return { sql: `insert into platform_admins (user_id) values ($1)`, params: [userId] };
    case 'invitations':
      return { sql: `insert into invitations (restaurant_id, email, role, token_hash, invited_by, expires_at)
                     values ($1, 'probe-invite@example.test', 'kitchen', $2, $3, now() + interval '72 hours')`,
               // The inviter can only ever be the caller: the policy requires it.
               params: [restaurantId, Buffer.from(`probe-${Math.random()}`), actingUserId] };
    case 'auth_lockouts':
      return { sql: `insert into auth_lockouts (key_hash, key_kind) values ($1, 'ip')`,
               params: [Buffer.from(`probe-${Math.random()}`)] };
    case 'dining_tables':
      return { sql: `insert into dining_tables (restaurant_id, table_number, capacity)
                     values ($1, $2, 4)`,
               params: [restaurantId, `P${Math.random().toString(36).slice(2, 9)}`] };
    case 'table_qr_tokens':
      // Aims at a table of that restaurant without a live QR, so the one-live-QR
      // index is not what refuses it. Under RLS a principal who cannot see the
      // tenant's tables gets a null table_id, which is itself a refusal.
      return { sql: `insert into table_qr_tokens (restaurant_id, table_id, key_id, created_by)
                     values ($1, (select t.id from dining_tables t
                                   where t.restaurant_id = $1
                                     and not exists (select 1 from table_qr_tokens q
                                                      where q.table_id = t.id and q.revoked_at is null)
                                   limit 1), 1, $2)`,
               params: [restaurantId, actingUserId] };
    case 'restaurant_settings':
      // One row per restaurant already exists, so any insert is a duplicate; the
      // probe still proves the policy refuses before the constraint would.
      return { sql: `insert into restaurant_settings (restaurant_id) values ($1)`, params: [restaurantId] };
    case 'tax_components':
      return { sql: `insert into tax_components (restaurant_id, name, rate_bps)
                     values ($1, 'PROBE-${Math.random().toString(36).slice(2, 8)}', 500)`,
               params: [restaurantId] };
    // Order probes name the restaurant's own table, item and order directly: a
    // customer cannot look them up, and must still be refused for a foreign tenant.
    case 'order_counters':
      return { sql: `insert into order_counters (restaurant_id, next_no) values ($1, 1)`, params: [restaurantId] };
    case 'orders':
      return { sql: `insert into orders (restaurant_id, table_id, order_no, order_ref, subtotal_minor,
                                         public_token_hash, idempotency_key, request_hash)
                     values ($1, $2, 900000, 'PROBE', 100,
                             decode(md5(random()::text) || md5(random()::text), 'hex'), gen_random_uuid(),
                             decode(md5(random()::text) || md5(random()::text), 'hex'))`,
               params: [restaurantId, target?.table ?? null] };
    case 'order_items':
      return { sql: `insert into order_items (restaurant_id, order_id, menu_item_id, position, name_snapshot, unit_price_minor, quantity)
                     values ($1, $2, $3, 150, 'PROBE', 100, 1)`,
               params: [restaurantId, target?.order ?? null, target?.menuItem ?? null] };
    case 'order_customers':
      return { sql: `insert into order_customers (order_id, restaurant_id, mobile) values ($1, $2, '9811111111')`,
               params: [target?.order ?? null, restaurantId] };
    case 'order_status_history':
      return { sql: `insert into order_status_history (restaurant_id, order_id, to_status) values ($1, $2, 'served')`,
               params: [restaurantId, target?.order ?? null] };
    // Billing probes aim at that restaurant's own empty draft, finalized unpaid bill
    // and unbilled order, so a refusal comes from the policy, not from a rule.
    case 'bills':
      return { sql: `insert into bills (restaurant_id, table_id, currency, prices_include_tax, service_charge_bps,
                                        rounding_mode, subtotal_minor, total_minor, issuer_snapshot, created_by)
                     values ($1, $2, 'INR', true, 0, 'none', 0, 0, '{"name": "PROBE"}', $3)`,
               params: [restaurantId, target?.table ?? null, actingUserId] };
    case 'bill_orders':
      return { sql: `insert into bill_orders (bill_id, order_id, restaurant_id) values ($2, $3, $1)`,
               params: [restaurantId, target?.draftBill ?? null, target?.order ?? null] };
    case 'bill_lines':
      return { sql: `insert into bill_lines (restaurant_id, bill_id, order_item_id, position, name, quantity,
                                             unit_price_minor, line_total_minor)
                     values ($1, $2, $3, 1, 'PROBE line', 1, 100, 100)`,
               params: [restaurantId, target?.draftBill ?? null, target?.orderItem ?? null] };
    case 'bill_taxes':
      return { sql: `insert into bill_taxes (restaurant_id, bill_id, position, name, rate_bps, taxable_minor, amount_minor)
                     values ($1, $2, 1, 'PROBE tax', 500, 0, 0)`,
               params: [restaurantId, target?.draftBill ?? null] };
    case 'bill_counters':
      return { sql: `insert into bill_counters (restaurant_id, series, next_no) values ($1, 'probe', 1)`, params: [restaurantId] };
    case 'payments':
      return { sql: `insert into payments (restaurant_id, bill_id, method, amount_minor, recorded_by)
                     values ($1, $2, 'cash', $3, $4)`,
               params: [restaurantId, target?.unpaidBill ?? null, target?.unpaidTotal ?? 0, actingUserId] };
    case 'bill_ledger':
      return { sql: `insert into bill_ledger (restaurant_id, seq, event, bill_id, prev_hash, entry_hash)
                     values ($1, 999999, 'bill_printed', $2, $3, $3)`,
               params: [restaurantId, target?.unpaidBill ?? null, Buffer.alloc(32)] };
    case 'bill_ledger_heads':
      return { sql: `insert into bill_ledger_heads (restaurant_id, seq, last_hash) values ($1, 0, $2)
                     on conflict (restaurant_id) do update set seq = 0`, params: [restaurantId, Buffer.alloc(32)] };
    case 'menu_categories':
      return { sql: `insert into menu_categories (restaurant_id, name) values ($1, $2)`,
               params: [restaurantId, `PROBE-${Math.random().toString(36).slice(2, 8)}`] };
    case 'menu_items':
      // Aims at that restaurant's own category; under RLS a principal who cannot
      // see it gets a null category_id, which is itself a refusal.
      return { sql: `insert into menu_items (restaurant_id, category_id, name, price_minor)
                     values ($1, (select id from menu_categories where restaurant_id = $1 limit 1), $2, 100)`,
               params: [restaurantId, `PROBE-${Math.random().toString(36).slice(2, 8)}`] };
    default:
      throw new Error(`no insert probe declared for ${spec.table}`);
  }
}

function updateFor(spec: TableSpec, restaurantId: string, fx: Fixtures): { sql: string; params: unknown[] } {
  const target = fx.probeTargets[restaurantId];
  switch (spec.table) {
    case 'restaurants':
      return { sql: `update restaurants set name = name || ' (probe)' where id = $1`, params: [restaurantId] };
    case 'restaurant_users':
      return { sql: `update restaurant_users set display_name = 'probe' where restaurant_id = $1`, params: [restaurantId] };
    case 'support_grants':
      return { sql: `update support_grants set revoked_at = now() where restaurant_id = $1`, params: [restaurantId] };
    case 'audit_log':
      return { sql: `update audit_log set action = 'probe.tampered' where restaurant_id = $1`, params: [restaurantId] };
    case 'platform_admins':
      return { sql: `update platform_admins set created_at = now() where user_id is not null`, params: [] };
    case 'invitations':
      return { sql: `update invitations set revoked_at = now() where restaurant_id = $1`, params: [restaurantId] };
    case 'auth_lockouts':
      return { sql: `update auth_lockouts set failures = failures + 1 where key_kind = 'ip'`, params: [] };
    case 'dining_tables':
      return { sql: `update dining_tables set capacity = capacity + 1 where restaurant_id = $1`, params: [restaurantId] };
    case 'table_qr_tokens':
      return { sql: `update table_qr_tokens set revoked_at = now() where restaurant_id = $1 and revoked_at is null`,
               params: [restaurantId] };
    case 'restaurant_settings':
      return { sql: `update restaurant_settings set bill_footer = 'probe' where restaurant_id = $1`, params: [restaurantId] };
    case 'tax_components':
      return { sql: `update tax_components set rate_bps = 999 where restaurant_id = $1`, params: [restaurantId] };
    case 'order_counters':
      return { sql: `update order_counters set next_no = next_no + 1 where restaurant_id = $1`, params: [restaurantId] };
    // The staff note: a change every staff role may make (FR-059). The amounts,
    // items and table of a placed order can never change (tested in the API suite).
    case 'orders':
      return { sql: `update orders set staff_note = 'PROBE note' where restaurant_id = $1`, params: [restaurantId] };
    case 'order_status_history':
      return { sql: `update order_status_history set reason = 'tampered' where restaurant_id = $1`, params: [restaurantId] };
    case 'order_items':
      return { sql: `update order_items set unit_price_minor = 1 where restaurant_id = $1`, params: [restaurantId] };
    case 'order_customers':
      return { sql: `update order_customers set mobile = '9822222222' where restaurant_id = $1`, params: [restaurantId] };
    // A draft's version: a change any billing role may make. Finalized bills are
    // immutable except for voiding (tested in the API suite).
    case 'bills':
      return { sql: `update bills set version = version + 1 where id = $1`, params: [target?.draftBill ?? null] };
    case 'bill_orders':
      return { sql: `update bill_orders set voided = true where restaurant_id = $1`, params: [restaurantId] };
    case 'bill_lines':
      return { sql: `update bill_lines set unit_price_minor = 1, line_total_minor = quantity where restaurant_id = $1`,
               params: [restaurantId] };
    case 'bill_taxes':
      return { sql: `update bill_taxes set amount_minor = 0 where restaurant_id = $1`, params: [restaurantId] };
    case 'bill_counters':
      return { sql: `update bill_counters set next_no = next_no + 1 where restaurant_id = $1`, params: [restaurantId] };
    // A reversal (FR-081): owner and manager only.
    case 'payments':
      return { sql: `update payments set reversed_at = now(), reversed_by = app.uid(), reversal_reason = 'PROBE reversal'
                     where restaurant_id = $1 and reversed_at is null`, params: [restaurantId] };
    case 'bill_ledger':
      return { sql: `update bill_ledger set payload = '{"tampered": true}' where restaurant_id = $1`, params: [restaurantId] };
    case 'bill_ledger_heads':
      return { sql: `update bill_ledger_heads set seq = seq + 1 where restaurant_id = $1`, params: [restaurantId] };
    case 'menu_categories':
      return { sql: `update menu_categories set sort_order = sort_order + 1 where restaurant_id = $1`,
               params: [restaurantId] };
    case 'menu_items':
      // A price change: the edit kitchen staff must never be able to make, even
      // though they may update the row's availability.
      return { sql: `update menu_items set price_minor = price_minor + 1 where restaurant_id = $1`,
               params: [restaurantId] };
    default:
      throw new Error(`no update probe declared for ${spec.table}`);
  }
}

function deleteFor(spec: TableSpec, restaurantId: string, fx: Fixtures): { sql: string; params: unknown[] } {
  const target = fx.probeTargets[restaurantId];
  switch (spec.table) {
    // Discarding a draft (approved decision 7).
    case 'bills':
      return { sql: `delete from bills where id = $1`, params: [target?.draftBill ?? null] };
    default:
      throw new Error(`no targeted delete probe declared for ${spec.table}`);
  }
}

export async function runIsolationMatrix(client: pg.Client, fx: Fixtures): Promise<{ checks: Check[]; cells: number }> {
  const checks: Check[] = [];
  let cells = 0;

  // ISO-01: every table in the catalog must appear in the declared matrix.
  const live = (await listPublicTables(client)).filter((t) => t.table_name !== 'schema_migrations');
  for (const t of live) {
    const declared = TABLES.some((spec) => spec.table === t.table_name);
    checks.push({
      name: `matrix covers table ${t.table_name}`,
      passed: declared,
      detail: declared ? undefined : `table ${t.table_name} (tenant data: ${isTenantTable(t)}) has no declared isolation expectations`,
    });
  }

  for (const spec of TABLES) {
    for (const principal of PRINCIPALS) {
      const cell: Cell | undefined = spec.cells[principal.id];
      if (!cell) {
        checks.push({ name: `${spec.table} × ${principal.id}`, passed: false, detail: 'unspecified cell: no expectation declared' });
        continue;
      }
      cells += 3; // read, insert, update

      // ---- read ----------------------------------------------------------
      const read = await readProbe(client, principal, fx, spec);
      const ownTenant = principal.tenantOf ? (fx[principal.tenantOf] as string) : null;
      const tenants = new Set(read.rows.map((r) => r.tenant));
      const markers = read.rows.map((r) => r.marker ?? '').join(' | ');
      const foreignMarkers = Object.entries(MARKER)
        .filter(([key]) => {
          const id = fx[`restaurant${key}` as keyof Fixtures] as string;
          return id !== ownTenant;
        })
        .filter(([, marker]) => markers.includes(marker))
        .map(([key]) => key);

      let readOk: boolean;
      let readDetail = `rows=${read.rows.length} tenants=${[...tenants].length}${read.denied ? ' (denied)' : ''}`;
      switch (cell.read) {
        case 'own':
          readOk = !read.denied && read.rows.length > 0 && [...tenants].every((t) => t === ownTenant) && foreignMarkers.length === 0;
          break;
        case 'none':
          readOk = read.rows.length === 0;
          break;
        case 'all':
          readOk = !read.denied && tenants.size > 1;
          break;
        case 'self':
          readOk = read.rows.length === 1;
          break;
        case 'platform':
          readOk = !read.denied && read.rows.length > 0 && [...tenants].every((t) => t === null);
          break;
      }
      if (foreignMarkers.length > 0 && cell.read !== 'all' && cell.read !== 'platform') {
        readOk = false;
        readDetail += ` LEAK: markers from ${foreignMarkers.join(', ')} visible`;
      }
      checks.push({ name: `read ${spec.table} as ${principal.id} (expect ${cell.read})`, passed: readOk, detail: readOk ? undefined : readDetail });

      // ---- insert into own tenant -----------------------------------------
      const actingUser = principal.how.kind === 'staff' ? (fx[principal.how.userOf] as string) : (fx.adminPlain as string);
      const ownIns = insertFor(spec, ownTenant ?? (fx.restaurantA as string), fx.spareUser as string, actingUser, fx);
      const ownInsert = await writeProbe(client, principal, fx, ownIns.sql, ownIns.params);
      const insertOk = cell.insertOwn === 'allow' ? ownInsert.allowed : !ownInsert.allowed;
      checks.push({
        name: `insert into ${spec.table} (own tenant) as ${principal.id} (expect ${cell.insertOwn})`,
        passed: insertOk,
        detail: insertOk ? undefined : `allowed=${ownInsert.allowed} ${ownInsert.error ?? ''}`,
      });

      // ---- insert into ANOTHER tenant: always forbidden --------------------
      const foreignTenant = ownTenant === fx.restaurantB ? (fx.restaurantA as string) : (fx.restaurantB as string);
      if (spec.table !== 'restaurants' && spec.table !== 'platform_admins') {
        const foreignIns = insertFor(spec, foreignTenant, fx.spareUser as string, actingUser, fx);
        const foreignInsert = await writeProbe(client, principal, fx, foreignIns.sql, foreignIns.params);
        // Platform admins are not tenant-scoped: they open support grants and record
        // their own platform actions against any restaurant, both of which are audited.
        const isAdmin = principal.id === 'admin' || principal.id === 'admin-granted';
        const allowedByDesign = isAdmin && (spec.table === 'support_grants' || spec.table === 'audit_log');
        const ok = allowedByDesign ? true : !foreignInsert.allowed;
        checks.push({
          name: `insert into ${spec.table} for ANOTHER tenant as ${principal.id} (expect deny)`,
          passed: ok,
          detail: ok ? undefined : 'cross-tenant insert succeeded',
        });
      }

      // ---- update own / foreign -------------------------------------------
      const ownUpd = updateFor(spec, ownTenant ?? (fx.restaurantA as string), fx);
      const ownUpdate = await writeProbe(client, principal, fx, ownUpd.sql, ownUpd.params);
      const updateOk = cell.updateOwn === 'allow' ? ownUpdate.allowed : !ownUpdate.allowed;
      checks.push({
        name: `update ${spec.table} (own tenant) as ${principal.id} (expect ${cell.updateOwn})`,
        passed: updateOk,
        detail: updateOk ? undefined : `allowed=${ownUpdate.allowed} ${ownUpdate.error ?? ''}`,
      });

      const foreignUpd = updateFor(spec, foreignTenant, fx);
      const foreignUpdate = await writeProbe(client, principal, fx, foreignUpd.sql, foreignUpd.params);
      const foreignUpdateAllowedByDesign = principal.id === 'admin' || principal.id === 'admin-granted'
        ? spec.table === 'restaurants' || spec.table === 'support_grants'
        : false;
      const fUpdOk = foreignUpdateAllowedByDesign ? true : !foreignUpdate.allowed;
      checks.push({
        name: `update ${spec.table} for ANOTHER tenant as ${principal.id} (expect deny)`,
        passed: fUpdOk,
        detail: fUpdOk ? undefined : 'cross-tenant update succeeded',
      });

      // ---- ISO-06: move a row to another tenant ---------------------------
      if (spec.tenantColumn === 'restaurant_id') {
        const move = await writeProbe(client, principal, fx,
          `update ${spec.table} set restaurant_id = $1 where restaurant_id = $2`,
          [foreignTenant, ownTenant ?? (fx.restaurantA as string)]);
        checks.push({
          name: `re-parent ${spec.table} row to another tenant as ${principal.id} (expect deny)`,
          passed: !move.allowed,
          detail: move.allowed ? 'row was moved across tenants' : undefined,
        });
      }

      // ---- delete: deleting everything is refused everywhere ---------------
      // (Where a table has rows that may never be deleted — finalized bills — the
      // statement fails as a whole.)
      const del = await writeProbe(client, principal, fx, `delete from ${spec.table}`, []);
      checks.push({
        name: `delete from ${spec.table} as ${principal.id} (expect deny)`,
        passed: !del.allowed,
        detail: del.allowed ? 'delete succeeded' : undefined,
      });

      // ---- targeted delete, where some delete is legitimate ------------------
      if (cell.deleteOwn) {
        const ownDel = deleteFor(spec, ownTenant ?? (fx.restaurantA as string), fx);
        const ownDelete = await writeProbe(client, principal, fx, ownDel.sql, ownDel.params);
        const ownDelOk = cell.deleteOwn === 'allow' ? ownDelete.allowed : !ownDelete.allowed;
        checks.push({
          name: `targeted delete from ${spec.table} (own tenant) as ${principal.id} (expect ${cell.deleteOwn})`,
          passed: ownDelOk,
          detail: ownDelOk ? undefined : `allowed=${ownDelete.allowed} ${ownDelete.error ?? ''}`,
        });
        const foreignDel = deleteFor(spec, foreignTenant, fx);
        const foreignDelete = await writeProbe(client, principal, fx, foreignDel.sql, foreignDel.params);
        checks.push({
          name: `targeted delete from ${spec.table} for ANOTHER tenant as ${principal.id} (expect deny)`,
          passed: !foreignDelete.allowed,
          detail: foreignDelete.allowed ? 'cross-tenant delete succeeded' : undefined,
        });
      }
    }
  }

  return { checks, cells };
}

/**
 * ISO-07: identity must not survive on a pooled connection. Runs two requests on the
 * same physical connection and checks the second cannot see the first one's tenant.
 */
export async function runContextLeakChecks(client: pg.Client, fx: Fixtures): Promise<Check[]> {
  const checks: Check[] = [];

  const first = await withStaffTx(client, { userId: fx.ownerA }, async () => {
    const { rows } = await client.query<{ id: string }>('select id::text from restaurants');
    return rows.map((r) => r.id);
  });

  const second = await withStaffTx(client, { userId: fx.ownerB }, async () => {
    const { rows } = await client.query<{ id: string }>('select id::text from restaurants');
    return rows.map((r) => r.id);
  });

  checks.push({
    name: 'reused connection does not carry the previous tenant',
    passed: first.length === 1 && second.length === 1 && first[0] !== second[0],
    detail: `first=${first.join(',')} second=${second.join(',')}`,
  });

  // After a failed request the context must be gone, not merely unused.
  await withStaffTx(client, { userId: fx.ownerA }, async () => {
    await client.query('select 1');
  }).catch(() => undefined);
  try {
    await client.query('select 1 from restaurants');
    checks.push({ name: 'bare connection cannot read tenant tables after a request', passed: false, detail: 'select succeeded outside any request context' });
  } catch (error) {
    // Either answer proves the point: the bare login role has no rights on the schema,
    // so it cannot even resolve the table name.
    const message = (error as Error).message;
    checks.push({
      name: 'bare connection cannot read tenant tables after a request',
      passed: /permission denied|does not exist/i.test(message),
      detail: message,
    });
  }

  const role = await client.query<{ role: string }>('select current_user as role');
  checks.push({
    name: 'connection returns to the API login role between requests',
    passed: role.rows[0]?.role === 'dineflow_api',
    detail: `current_user=${role.rows[0]?.role}`,
  });

  return checks;
}
