// Request-scoped database context.
//
// Every query the API makes goes through one of these wrappers. They open a
// transaction, drop from the API's login role to a request role that cannot bypass
// RLS, and set the identity the policies read. If application code forgets a tenant
// filter, RLS returns nothing instead of another restaurant's rows (D-03).
//
// The tests use these same wrappers, so what they exercise is what production runs.
import type pg from 'pg';

export type StaffIdentity = {
  userId: string;
  /** Authentication assurance level from the verified session, not from the client. */
  aal?: 'aal1' | 'aal2';
};

export class UnsafeDatabaseRoleError extends Error {}

/**
 * Refuses to start against a connection that could bypass RLS. Called at API boot
 * (Part 7 §3, F-2): a superuser or BYPASSRLS login makes every isolation test
 * meaningless while appearing to pass.
 */
export async function assertSafeDbRole(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{
    role: string; is_super: boolean; bypass: boolean; owned: string | null;
  }>(`
    select current_user                                     as role,
           rolsuper                                         as is_super,
           rolbypassrls                                     as bypass,
           (select string_agg(c.relname, ', ')
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' and c.relowner = r.oid) as owned
      from pg_roles r
     where r.rolname = current_user`);

  const row = rows[0];
  if (!row) throw new UnsafeDatabaseRoleError('could not inspect the current database role');
  const problems: string[] = [];
  if (row.is_super) problems.push('is a superuser');
  if (row.bypass) problems.push('has BYPASSRLS');
  if (row.owned) problems.push(`owns tables (${row.owned}) and so is exempt from FORCE RLS`);
  if (problems.length) {
    throw new UnsafeDatabaseRoleError(
      `database role "${row.role}" ${problems.join(' and ')}; RLS would not be enforced`,
    );
  }
}

async function runInRole<T>(
  client: pg.ClientBase,
  setup: () => Promise<void>,
  body: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await setup();
    const value = await body();
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    // SET LOCAL and set_config(..., true) are transaction-scoped, so commit and
    // rollback both clear them. RESET ROLE is belt and braces for a pooled
    // connection that is about to serve a different user (ISO-07).
    await client.query('reset role');
  }
}

/** Runs `body` as an authenticated staff member (or platform admin). */
export function withStaffTx<T>(
  client: pg.ClientBase,
  identity: StaffIdentity,
  body: () => Promise<T>,
): Promise<T> {
  return runInRole(client, async () => {
    await client.query('set local role dineflow_staff');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: identity.userId, role: 'dineflow_staff', aal: identity.aal ?? 'aal1' }),
    ]);
  }, body);
}

/**
 * Runs `body` as an anonymous customer scoped to one restaurant. The caller passes
 * the restaurant resolved from a verified QR token — never a value from the request.
 */
export function withPublicTx<T>(
  client: pg.ClientBase,
  restaurantId: string | null,
  body: () => Promise<T>,
): Promise<T> {
  return runInRole(client, async () => {
    await client.query('set local role dineflow_public');
    await client.query('select set_config($1, $2, true)', [
      'app.public_restaurant_id',
      restaurantId ?? '',
    ]);
  }, body);
}

/** Runs `body` with no identity at all: used to prove the bare login role sees nothing. */
export function withNoContextTx<T>(client: pg.ClientBase, body: () => Promise<T>): Promise<T> {
  return runInRole(client, async () => {}, body);
}
