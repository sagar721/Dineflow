// Database access for the API.
//
// Every tenant query runs through the wrappers in @dineflow/db, which drop to a
// request role that cannot bypass RLS. The unscoped helpers below exist only for
// the pre-session paths (sign-in, invitation acceptance), and each one is a narrow
// SECURITY DEFINER function rather than direct table access.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { assertSafeDbRole, withPublicTx, withStaffTx } from '@dineflow/db/context';
import type { StaffRole } from '@dineflow/shared';

export type Membership = {
  restaurantId: string | null;
  role: StaffRole | null;
  staffStatus: 'active' | 'deactivated' | null;
  restaurantStatus: 'provisioning' | 'active' | 'suspended' | 'closed' | null;
  isPlatformAdmin: boolean;
};

export class Database {
  #pool: pg.Pool;

  constructor(connectionString: string) {
    this.#pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  /**
   * Refuses to serve traffic on a connection that could bypass RLS (Part 7 §3, F-2).
   * Called at boot: a superuser connection would make every isolation guarantee void
   * while every test still appeared to pass.
   */
  async assertSafeRole(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await assertSafeDbRole(client);
    } finally {
      client.release();
    }
  }

  /** Runs `body` as the given staff user, inside one RLS-scoped transaction. */
  async asStaff<T>(
    identity: { userId: string; aal: 'aal1' | 'aal2' },
    body: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await withStaffTx(client, identity, () => body(client));
    } finally {
      client.release();
    }
  }

  /**
   * Runs `body` as an anonymous customer scoped to one restaurant. The restaurant
   * must come from a verified capability (a QR token), never from the request.
   */
  async asPublic<T>(restaurantId: string, body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await withPublicTx(client, restaurantId, () => body(client));
    } finally {
      client.release();
    }
  }

  /**
   * Resolves a QR's random id to its table, only when the token, table and
   * restaurant are all live. Call it only after the token's MAC has verified.
   */
  async resolveTableQr(qrId: string): Promise<{
    restaurantId: string; tableId: string; tableNumber: string; tableName: string | null; keyId: number;
  } | null> {
    const { rows } = await this.#pool.query<{
      restaurant_id: string; table_id: string; table_number: string; table_name: string | null; key_id: number;
    }>('select * from app.resolve_table_qr($1)', [qrId]);
    const row = rows[0];
    return row
      ? { restaurantId: row.restaurant_id, tableId: row.table_id, tableNumber: row.table_number,
          tableName: row.table_name, keyId: row.key_id }
      : null;
  }

  /** The membership lookup that establishes tenant context on every request. */
  async lookupMembership(userId: string): Promise<Membership | null> {
    const { rows } = await this.#pool.query<{
      restaurant_id: string | null;
      role: StaffRole | null;
      staff_status: Membership['staffStatus'];
      restaurant_status: Membership['restaurantStatus'];
      is_platform_admin: boolean;
    }>('select * from app.lookup_membership($1)', [userId]);

    const row = rows[0];
    if (!row) return null;
    return {
      restaurantId: row.restaurant_id,
      role: row.role,
      staffStatus: row.staff_status,
      restaurantStatus: row.restaurant_status,
      isPlatformAdmin: row.is_platform_admin,
    };
  }

  // ---------------------------------------------------------- brute-force state

  async checkLock(key: string): Promise<Date | null> {
    const { rows } = await this.#pool.query<{ check_auth_lock: Date | null }>(
      'select app.check_auth_lock($1)', [hashKey(key)]);
    return rows[0]?.check_auth_lock ?? null;
  }

  async registerFailure(key: string, kind: 'account' | 'ip' | 'account_ip', threshold: number, windowMinutes: number): Promise<Date | null> {
    const { rows } = await this.#pool.query<{ register_auth_failure: Date | null }>(
      'select app.register_auth_failure($1, $2, $3, make_interval(mins => $4))',
      [hashKey(key), kind, threshold, windowMinutes]);
    return rows[0]?.register_auth_failure ?? null;
  }

  async clearFailures(key: string): Promise<void> {
    await this.#pool.query('select app.clear_auth_failures($1)', [hashKey(key)]);
  }

  // ------------------------------------------------------------- invitations

  async lookupInvitation(tokenHash: Buffer): Promise<{ id: string; restaurantId: string; email: string; role: StaffRole } | null> {
    const { rows } = await this.#pool.query<{ id: string; restaurant_id: string; email: string; role: StaffRole }>(
      'select * from app.lookup_invitation($1)', [tokenHash]);
    const row = rows[0];
    return row ? { id: row.id, restaurantId: row.restaurant_id, email: row.email, role: row.role } : null;
  }

  async acceptInvitation(tokenHash: Buffer, userId: string, displayName: string): Promise<string | null> {
    const { rows } = await this.#pool.query<{ accept_invitation: string | null }>(
      'select app.accept_invitation($1, $2, $3)', [tokenHash, userId, displayName]);
    return rows[0]?.accept_invitation ?? null;
  }

  // --------------------------------------------------------------- platform
  // These call SECURITY DEFINER functions that check the caller's platform rights
  // themselves, because provisioning happens before any tenant context exists.

  async createRestaurant(input: {
    adminUserId: string; slug: string; name: string; ownerEmail: string;
    tokenHash: Buffer; expiresAt: Date; currency: string; timezone: string;
  }): Promise<{ restaurantId: string; invitationId: string }> {
    const { rows } = await this.#pool.query<{ restaurant_id: string; invitation_id: string }>(
      'select * from app.create_restaurant($1, $2, $3, $4, $5, $6, $7, $8)',
      [input.adminUserId, input.slug, input.name, input.ownerEmail,
       input.tokenHash, input.expiresAt, input.currency, input.timezone]);
    const row = rows[0];
    if (!row) throw new Error('create_restaurant returned no row');
    return { restaurantId: row.restaurant_id, invitationId: row.invitation_id };
  }

  async listRestaurants(adminUserId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.#pool.query('select * from app.list_restaurants($1)', [adminUserId]);
    return rows;
  }

  /** Returns the previous status, or null when the restaurant does not exist. */
  async setRestaurantStatus(
    adminUserId: string, restaurantId: string, status: string, reason: string,
  ): Promise<string | null> {
    // No explicit ::restaurant_status cast: the API's login role has no USAGE on
    // schema public, by design, so it cannot name types declared there. Postgres
    // coerces the argument to the function's declared parameter type instead.
    const { rows } = await this.#pool.query<{ set_restaurant_status: string | null }>(
      'select app.set_restaurant_status($1, $2, $3, $4)',
      [adminUserId, restaurantId, status, reason]);
    return rows[0]?.set_restaurant_status ?? null;
  }

  // ------------------------------------------------------------------ audit

  /**
   * Records an authentication event that happens without a session (failed sign-in,
   * lockout, reset request). Session-scoped actions are audited inside their own
   * transaction instead, so the action and its audit row commit together.
   */
  async recordAuthEvent(event: {
    restaurantId?: string | null;
    userId?: string | null;
    action: string;
    summary?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
  }): Promise<void> {
    await this.#pool.query('select app.record_auth_event($1, $2, $3, $4, $5, $6, $7)', [
      event.restaurantId ?? null,
      event.userId ?? null,
      event.action,
      JSON.stringify(event.summary ?? {}),
      event.ip ?? null,
      event.userAgent?.slice(0, 300) ?? null,
      event.requestId ?? null,
    ]);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/**
 * Lockout rows are keyed by hash so the table cannot be read as a list of which
 * email addresses exist on the platform.
 */
function hashKey(key: string): Buffer {
  return createHash('sha256').update(key.toLowerCase()).digest();
}
