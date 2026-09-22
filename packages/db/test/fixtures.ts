// Two-tenant fixtures with unique markers (ISO-04).
//
// Every restaurant's rows carry a marker string. Read probes assert not just "the
// right number of rows" but "no marker belonging to another tenant appears
// anywhere in the result", which catches leaks that a count-based assertion misses.
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { canonicalBillText, computeBill } from '../../shared/src/bill.ts';

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
  probeTargets: Record<string, {
    table: string; menuItem: string; order: string;
    /** Billing (011): an empty draft, a finalized unpaid bill and its total, and an order line. */
    draftBill?: string; unpaidBill?: string; unpaidTotal?: number; orderItem?: string;
  }>;
  grantIdA: string;
};

/** Truncates DineFlow data (never the schema) and rebuilds the fixture set. */
export async function seed(admin: pg.Client): Promise<Fixtures> {
  await admin.query(`
    truncate audit_log, invitations, auth_lockouts, support_grants, restaurant_users,
             bill_ledger, bill_ledger_heads, payments, bill_taxes, bill_lines, bill_orders, bills, bill_counters,
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
  // Billing (011): per restaurant, bill 1 (finalized and paid, for order 1), bill 2
  // (finalized, unpaid, for a third order) and an empty draft — so every billing
  // table has rows that could leak, and insert probes have legitimate targets.
  for (const [rid, owner, marker] of [[restaurantA, ownerA, MARKER.A], [restaurantB, ownerB, MARKER.B],
                                      [restaurantS, ownerS, MARKER.S], [restaurantP, ownerP, MARKER.P]] as const) {
    const target = probeTargets[rid]!;
    const { rows: [orderOne] } = await admin.query<{ id: string }>(
      `select id from orders where restaurant_id = $1 and order_no = 1`, [rid]);
    const { rows: [paneer] } = await admin.query<{ id: string }>(
      `select id from menu_items where restaurant_id = $1 and name like '%Paneer Tikka'`, [rid]);
    await admin.query('begin');
    const { rows: [orderThree] } = await admin.query<{ id: string }>(
      `insert into orders (restaurant_id, table_id, order_no, order_ref, subtotal_minor, special_instructions,
                           public_token_hash, idempotency_key, request_hash)
       values ($1, $2, 3, '3', 24900, $3, $4, gen_random_uuid(), $5) returning id`,
      [rid, target.table, marker, randomBytes(32), randomBytes(32)]);
    await admin.query(
      `insert into order_items (restaurant_id, order_id, menu_item_id, position, name_snapshot, unit_price_minor, quantity)
       values ($1, $2, $3, 1, $4, 24900, 1)`, [rid, orderThree!.id, paneer!.id, `${marker} Paneer Tikka`]);
    await admin.query('commit');
    await admin.query(`update order_counters set next_no = 4 where restaurant_id = $1`, [rid]);

    const issuer = { name: `${marker} Restaurant`, address: null, phone: null, taxRegistrationNo: null, footer: null };
    const makeBill = async (orderId: string, billNo: number | null) => {
      const { rows: lines } = await admin.query<{ id: string; name_snapshot: string; quantity: number; unit_price_minor: string }>(
        `select id, name_snapshot, quantity, unit_price_minor from order_items where order_id = $1 order by position`, [orderId]);
      const totals = computeBill({
        lines: lines.map((l) => ({ unitPriceMinor: Number(l.unit_price_minor), quantity: l.quantity })),
        pricesIncludeTax: true, taxes: [{ name: `${marker} GST`, rateBps: 500 }], serviceChargeBps: 0,
        discount: null, roundingMode: 'none',
      });
      const { rows: [bill] } = await admin.query<{ id: string }>(
        `insert into bills (restaurant_id, table_id, currency, prices_include_tax, service_charge_bps, rounding_mode,
                            subtotal_minor, service_charge_minor, tax_total_minor, rounding_minor, total_minor,
                            issuer_snapshot, created_by)
         values ($1, $2, 'INR', true, 0, 'none', $3, 0, $4, 0, $5, $6, $7) returning id`,
        [rid, target.table, totals.subtotalMinor, totals.taxTotalMinor, totals.totalMinor, issuer, owner]);
      await admin.query(`insert into bill_orders (bill_id, order_id, restaurant_id) values ($1, $2, $3)`, [bill!.id, orderId, rid]);
      for (const [index, line] of lines.entries()) {
        await admin.query(
          `insert into bill_lines (restaurant_id, bill_id, order_item_id, position, name, quantity, unit_price_minor, line_total_minor)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [rid, bill!.id, line.id, index + 1, line.name_snapshot, line.quantity, line.unit_price_minor,
           Number(line.unit_price_minor) * line.quantity]);
      }
      for (const [index, tax] of totals.taxes.entries()) {
        await admin.query(
          `insert into bill_taxes (restaurant_id, bill_id, position, name, rate_bps, taxable_minor, amount_minor)
           values ($1, $2, $3, $4, $5, $6, $7)`, [rid, bill!.id, index + 1, tax.name, tax.rateBps, tax.taxableMinor, tax.amountMinor]);
      }
      if (billNo !== null) {
        await admin.query(
          `insert into bill_counters (restaurant_id, series, next_no) values ($1, 'main', $2)
           on conflict (restaurant_id, series) do update set next_no = excluded.next_no`, [rid, billNo + 1]);
        const hash = createHash('sha256').update(canonicalBillText({
          restaurantId: rid, billNo, billRef: String(billNo), series: 'main', currency: 'INR', pricesIncludeTax: true,
          issuer, tableNumber: 'T1', orderRefs: [orderId === orderOne!.id ? '1' : '3'],
          lines: lines.map((l) => ({ name: l.name_snapshot, quantity: l.quantity, unitPriceMinor: Number(l.unit_price_minor),
                                      lineTotalMinor: Number(l.unit_price_minor) * l.quantity })),
          taxes: totals.taxes, subtotalMinor: totals.subtotalMinor, discountType: null, discountValue: null,
          discountMinor: 0, discountReason: null, serviceChargeBps: 0, serviceChargeMinor: 0,
          taxTotalMinor: totals.taxTotalMinor, roundingMode: 'none', roundingMinor: 0, totalMinor: totals.totalMinor,
        })).digest();
        await admin.query(
          `update bills set status = 'finalized', bill_no = $2, bill_ref = $3, content_hash = $4,
                  finalized_by = $5, finalized_at = now(), version = version + 1 where id = $1`,
          [bill!.id, billNo, String(billNo), hash, owner]);
      }
      return { id: bill!.id, total: totals.totalMinor };
    };
    const paid = await makeBill(orderOne!.id, 1);
    await admin.query(
      `insert into payments (restaurant_id, bill_id, method, amount_minor, reference, recorded_by)
       values ($1, $2, 'cash', $3, $4, $5)`, [rid, paid.id, paid.total, marker, owner]);
    const unpaid = await makeBill(orderThree!.id, 2);
    const { rows: [draft] } = await admin.query<{ id: string }>(
      `insert into bills (restaurant_id, table_id, currency, prices_include_tax, service_charge_bps, rounding_mode,
                          subtotal_minor, total_minor, issuer_snapshot, created_by)
       values ($1, $2, 'INR', true, 0, 'none', 0, 0, $3, $4) returning id`, [rid, target.table, issuer, owner]);
    const { rows: [orderItem] } = await admin.query<{ id: string }>(
      `select id from order_items where order_id = $1 limit 1`, [target.order]);
    Object.assign(target, { draftBill: draft!.id, unpaidBill: unpaid.id, unpaidTotal: unpaid.total, orderItem: orderItem!.id });
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
