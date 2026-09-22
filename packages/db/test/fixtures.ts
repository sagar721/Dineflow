// Two-tenant fixtures with unique markers (ISO-04).
//
// Every restaurant's rows carry a marker string. Read probes assert not just "the
// right number of rows" but "no marker belonging to another tenant appears
// anywhere in the result", which catches leaks that a count-based assertion misses.
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';

export const MARKER = {
  A: 'MARKER-TENANT-A',
  B: 'MARKER-TENANT-B',
  S: 'MARKER-TENANT-SUSPENDED',
  P: 'MARKER-TENANT-PROVISIONING',
} as const;

export type Fixtures = {
  restaurantA: string; restaurantB: string; restaurantS: string;
  /** Still being set up: its owner must be able to work, its customers must not. */
  restaurantP: string;
  ownerA: string; managerA: string; kitchenA: string; billingA: string;
  deactivatedA: string; ownerB: string; ownerS: string; ownerP: string;
  adminPlain: string; adminGranted: string;
  /** An auth user with no membership anywhere, so insert probes do not collide. */
  spareUser: string;
  /**
   * Per restaurant: rows insert probes can aim at. Customers cannot look these up
   * themselves (they reach tables only through a QR), so the probe is given them.
   * `order` has no contact row, so a contact insert probe does not collide.
   */
  probeTargets: Record<string, { table: string; menuItem: string; order: string }>;
  grantIdA: string;
};

/** Truncates DineFlow data (never the schema) and rebuilds the fixture set. */
export async function seed(admin: pg.Client): Promise<Fixtures> {
  await admin.query(`
    truncate audit_log, invitations, auth_lockouts, support_grants, restaurant_users,
             order_status_history, order_customers, order_items, orders, order_counters,
             menu_items, menu_categories,
             table_qr_tokens, dining_tables, tax_components, restaurant_settings,
             platform_admins, restaurants restart identity cascade;
  `);
  // Only ever remove the fixture accounts. A blanket delete here would wipe every
  // real user when the harness is pointed at a live project.
  await admin.query(`delete from auth.users where email like '%@example.test'`);

  const user = async (email: string) => {
    // The id is supplied explicitly: Supabase's real `auth.users.id` has no default,
    // because GoTrue always provides one.
    const { rows } = await admin.query<{ id: string }>(
      'insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id', [email]);
    return rows[0]!.id;
  };
  const restaurant = async (slug: string, marker: string, status: string) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into restaurants (slug, name, status, accepting_orders)
       values ($1, $2, $3::restaurant_status, true) returning id`,
      [slug, `${marker} Restaurant`, status]);
    return rows[0]!.id;
  };
  const staff = async (rid: string, uid: string, role: string, email: string, marker: string, status = 'active') => {
    await admin.query(
      `insert into restaurant_users (restaurant_id, user_id, role, status, email, display_name)
       values ($1, $2, $3::staff_role, $4::staff_status, $5, $6)`,
      [rid, uid, role, status, email, `${marker} ${role}`]);
  };

  const restaurantA = await restaurant('tenant-a', MARKER.A, 'active');
  const restaurantB = await restaurant('tenant-b', MARKER.B, 'active');
  const restaurantS = await restaurant('tenant-s', MARKER.S, 'suspended');
  const restaurantP = await restaurant('tenant-p', MARKER.P, 'provisioning');

  const ownerA = await user('owner-a@example.test');
  const managerA = await user('manager-a@example.test');
  const kitchenA = await user('kitchen-a@example.test');
  const billingA = await user('billing-a@example.test');
  const deactivatedA = await user('gone-a@example.test');
  const ownerB = await user('owner-b@example.test');
  const ownerS = await user('owner-s@example.test');
  const ownerP = await user('owner-p@example.test');
  const adminPlain = await user('admin@example.test');
  const adminGranted = await user('admin-grant@example.test');
  const spareUser = await user('spare@example.test');

  await staff(restaurantA, ownerA, 'owner', 'owner-a@example.test', MARKER.A);
  await staff(restaurantA, managerA, 'manager', 'manager-a@example.test', MARKER.A);
  await staff(restaurantA, kitchenA, 'kitchen', 'kitchen-a@example.test', MARKER.A);
  await staff(restaurantA, billingA, 'billing', 'billing-a@example.test', MARKER.A);
  await staff(restaurantA, deactivatedA, 'manager', 'gone-a@example.test', MARKER.A, 'deactivated');
  await staff(restaurantB, ownerB, 'owner', 'owner-b@example.test', MARKER.B);
  await staff(restaurantS, ownerS, 'owner', 'owner-s@example.test', MARKER.S);
  await staff(restaurantP, ownerP, 'owner', 'owner-p@example.test', MARKER.P);

  await admin.query('insert into platform_admins (user_id) values ($1), ($2)', [adminPlain, adminGranted]);

  const { rows: grant } = await admin.query<{ id: string }>(
    `insert into support_grants (restaurant_id, admin_user_id, reason, expires_at)
     values ($1, $2, $3, now() + interval '1 hour') returning id`,
    [restaurantA, adminGranted, `${MARKER.A} investigating a billing question`]);

  // An expired grant, to prove expiry is honoured rather than merely recorded.
  await admin.query(
    `insert into support_grants (restaurant_id, admin_user_id, reason, created_at, expires_at)
     values ($1, $2, $3, now() - interval '5 hours', now() - interval '1 hour')`,
    [restaurantB, adminPlain, `${MARKER.B} expired support access`]);

  // Settings rows are created by a trigger; give each a marker and a tax line so
  // isolation probes have something that could leak.
  for (const [rid, marker] of [[restaurantA, MARKER.A], [restaurantB, MARKER.B],
                               [restaurantS, MARKER.S], [restaurantP, MARKER.P]] as const) {
    await admin.query(`update restaurant_settings set bill_footer = $2 where restaurant_id = $1`, [rid, marker]);
    await admin.query(
      `insert into tax_components (restaurant_id, name, rate_bps) values ($1, $2, 500)`,
      [rid, `${marker} GST`]);
  }

  // Two tables per restaurant: one with a live QR code, one without, so probes
  // can create a QR without colliding with the one-live-QR-per-table rule.
  for (const [rid, owner, marker] of [[restaurantA, ownerA, MARKER.A], [restaurantB, ownerB, MARKER.B],
                                      [restaurantS, ownerS, MARKER.S], [restaurantP, ownerP, MARKER.P]] as const) {
    const { rows: tbl } = await admin.query<{ id: string }>(
      `insert into dining_tables (restaurant_id, table_number, name, capacity)
       values ($1, 'T1', $2, 4) returning id`, [rid, marker]);
    await admin.query(
      `insert into dining_tables (restaurant_id, table_number, name, capacity)
       values ($1, 'T2', $2, 2)`, [rid, marker]);
    await admin.query(
      `insert into table_qr_tokens (restaurant_id, table_id, key_id, created_by) values ($1, $2, 1, $3)`,
      [rid, tbl[0]!.id, owner]);
  }

  // One shown category with one shown item per restaurant, carrying the marker, so
  // both staff and customer probes have a menu row that could leak.
  const probeTargets: Fixtures['probeTargets'] = {};
  for (const [rid, marker] of [[restaurantA, MARKER.A], [restaurantB, MARKER.B],
                               [restaurantS, MARKER.S], [restaurantP, MARKER.P]] as const) {
    const { rows: cat } = await admin.query<{ id: string }>(
      `insert into menu_categories (restaurant_id, name, sort_order) values ($1, $2, 1) returning id`,
      [rid, `${marker} Starters`]);
    const { rows: item } = await admin.query<{ id: string }>(
      `insert into menu_items (restaurant_id, category_id, name, price_minor, diet)
       values ($1, $2, $3, 24900, 'veg') returning id`, [rid, cat[0]!.id, `${marker} Paneer Tikka`]);
    // Not on any order, so an order-line insert probe does not hit the one-line-per-item rule.
    const { rows: spare } = await admin.query<{ id: string }>(
      `insert into menu_items (restaurant_id, category_id, name, price_minor, diet)
       values ($1, $2, $3, 3000, 'veg') returning id`, [rid, cat[0]!.id, `${marker} Masala Chai`]);

    // Two placed orders per restaurant, written in one transaction each because the
    // order-total check runs at commit. The first has contact details.
    const { rows: table } = await admin.query<{ id: string }>(
      `select id from dining_tables where restaurant_id = $1 and table_number = 'T1'`, [rid]);
    const orderIds: string[] = [];
    for (const [no, withContact] of [[1, true], [2, false]] as const) {
      await admin.query('begin');
      const { rows: order } = await admin.query<{ id: string }>(
        `insert into orders (restaurant_id, table_id, order_no, order_ref, subtotal_minor, special_instructions,
                             public_token_hash, idempotency_key, request_hash)
         values ($1, $2, $3, $4, 49800, $5, $6, gen_random_uuid(), $7) returning id`,
        [rid, table[0]!.id, no, String(no), marker, randomBytes(32), randomBytes(32)]);
      await admin.query(
        `insert into order_items (restaurant_id, order_id, menu_item_id, position, name_snapshot, unit_price_minor, quantity)
         values ($1, $2, $3, 1, $4, 24900, 2)`, [rid, order[0]!.id, item[0]!.id, `${marker} Paneer Tikka`]);
      if (withContact) {
        await admin.query(
          `insert into order_customers (order_id, restaurant_id, mobile, email) values ($1, $2, '9800000000', $3)`,
          [order[0]!.id, rid, `${marker.toLowerCase()}@example.test`]);
      }
      await admin.query('commit');
      orderIds.push(order[0]!.id);
    }
    await admin.query(`insert into order_counters (restaurant_id, next_no) values ($1, 3)`, [rid]);
    probeTargets[rid] = { table: table[0]!.id, menuItem: spare[0]!.id, order: orderIds[1]! };
  }
  // Live restaurants take orders, so a customer insert is refused for the right
  // reason (wrong restaurant) rather than because ordering is paused.
  await admin.query(`update restaurants set accepting_orders = true where id = any($1::uuid[])`, [[restaurantA, restaurantB]]);

  // A pending invitation per restaurant, so isolation probes have something to leak.
  for (const [rid, inviter, marker] of [
    [restaurantA, ownerA, 'a'], [restaurantB, ownerB, 'b'],
    [restaurantS, ownerS, 's'], [restaurantP, ownerP, 'p'],
  ] as const) {
    await admin.query(
      `insert into invitations (restaurant_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'kitchen', $3, $4, now() + interval '72 hours')`,
      [rid, `invited-${marker}@example.test`, createHash('sha256').update(`fixture-token-${marker}`).digest(), inviter]);
  }

  for (const [rid, marker] of [[restaurantA, MARKER.A], [restaurantB, MARKER.B],
                               [restaurantS, MARKER.S], [restaurantP, MARKER.P]] as const) {
    await admin.query(
      `insert into audit_log (restaurant_id, action, entity_type, entity_id, summary)
       values ($1::uuid, 'fixture.seeded', 'restaurant', $2::text, jsonb_build_object('marker', $3::text))`,
      [rid, rid, marker]);
  }
  await admin.query(
    `insert into audit_log (restaurant_id, action, entity_type, summary)
     values (null, 'platform.fixture', 'platform', jsonb_build_object('marker', 'MARKER-PLATFORM'))`);

  return {
    restaurantA, restaurantB, restaurantS, restaurantP,
    ownerA, managerA, kitchenA, billingA, deactivatedA, ownerB, ownerS, ownerP,
    adminPlain, adminGranted, spareUser, grantIdA: grant[0]!.id, probeTargets,
  };
}
