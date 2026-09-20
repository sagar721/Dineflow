// Two-tenant fixtures with unique markers (ISO-04).
//
// Every restaurant's rows carry a marker string. Read probes assert not just "the
// right number of rows" but "no marker belonging to another tenant appears
// anywhere in the result", which catches leaks that a count-based assertion misses.
import pg from 'pg';

export const MARKER = {
  A: 'MARKER-TENANT-A',
  B: 'MARKER-TENANT-B',
  S: 'MARKER-TENANT-SUSPENDED',
} as const;

export type Fixtures = {
  restaurantA: string; restaurantB: string; restaurantS: string;
  ownerA: string; managerA: string; kitchenA: string; billingA: string;
  deactivatedA: string; ownerB: string; ownerS: string;
  adminPlain: string; adminGranted: string;
  /** An auth user with no membership anywhere, so insert probes do not collide. */
  spareUser: string;
  grantIdA: string;
};

/** Truncates DineFlow data (never the schema) and rebuilds the fixture set. */
export async function seed(admin: pg.Client): Promise<Fixtures> {
  await admin.query(`
    truncate audit_log, support_grants, restaurant_users, platform_admins, restaurants restart identity cascade;
    delete from auth.users;
  `);

  const user = async (email: string) => {
    const { rows } = await admin.query<{ id: string }>(
      'insert into auth.users (email) values ($1) returning id', [email]);
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

  const ownerA = await user('owner-a@example.test');
  const managerA = await user('manager-a@example.test');
  const kitchenA = await user('kitchen-a@example.test');
  const billingA = await user('billing-a@example.test');
  const deactivatedA = await user('gone-a@example.test');
  const ownerB = await user('owner-b@example.test');
  const ownerS = await user('owner-s@example.test');
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

  for (const [rid, marker] of [[restaurantA, MARKER.A], [restaurantB, MARKER.B], [restaurantS, MARKER.S]] as const) {
    await admin.query(
      `insert into audit_log (restaurant_id, action, entity_type, entity_id, summary)
       values ($1::uuid, 'fixture.seeded', 'restaurant', $2::text, jsonb_build_object('marker', $3::text))`,
      [rid, rid, marker]);
  }
  await admin.query(
    `insert into audit_log (restaurant_id, action, entity_type, summary)
     values (null, 'platform.fixture', 'platform', jsonb_build_object('marker', 'MARKER-PLATFORM'))`);

  return {
    restaurantA, restaurantB, restaurantS,
    ownerA, managerA, kitchenA, billingA, deactivatedA, ownerB, ownerS,
    adminPlain, adminGranted, spareUser, grantIdA: grant[0]!.id,
  };
}
