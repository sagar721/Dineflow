// Staff order workflow (PRD FR-050 … FR-059): the list and its filters, detail,
// every status transition by role, cancel and revert with reasons, optimistic
// concurrency, history, audit, the staff note, live updates, the customer's view,
// contact privacy and tenant isolation — plus a contract test that the database
// guard and the shared state machine agree for every (role, from, to).
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  canRevert, canTransition, ORDER_STATUSES, revertTarget, type OrderStatus, type StaffRole,
} from '@dineflow/shared';
import { createTestContext, signToken, TEST_QR_KEYS, type TestContext } from './helpers.ts';
import { parseKeyring, signQrToken } from '../src/lib/qr-token.ts';

let ctx: TestContext;
const keyring = parseKeyring(TEST_QR_KEYS);
const HIGH = { limit: 100_000, windowSeconds: 600 };

let ipCounter = 0;
const nextIp = () => `198.19.${Math.floor((ipCounter += 1) / 250) % 250}.${ipCounter % 250 + 1}`;
const web = (req: request.Test) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', nextIp());

type Row = Record<string, unknown>;
const q = async <T extends Row = Row>(sql: string, params: unknown[] = []) => (await ctx.owner.query<T>(sql, params)).rows;
const cookie = async (userId: string) => `df_at=${await signToken({ sub: userId })}`;
const get = async (userId: string, path: string) =>
  request(ctx.app).get(`/api/v1/restaurant/orders${path}`).set('cookie', await cookie(userId));
const send = async (method: 'post' | 'patch', userId: string, path: string, body: unknown) =>
  web(request(ctx.app)[method](`/api/v1/restaurant/orders${path}`)).set('cookie', await cookie(userId)).send(body as object);

let tokenA = '';
let tokenB = '';
let chaiA = '';
let chaiB = '';

before(async () => {
  ctx = await createTestContext({ orderLimits: { perIp: HIGH, perTable: HIGH, perRestaurant: HIGH } });
  const token = async (rid: string) => {
    const [row] = await q<{ qr_id: string; key_id: number }>(
      `select q.qr_id, q.key_id from table_qr_tokens q join dining_tables t on t.id = q.table_id
        where q.restaurant_id = $1 and t.table_number = 'T1' and q.revoked_at is null`, [rid]);
    return signQrToken(keyring, row!.qr_id, row!.key_id);
  };
  const item = async (rid: string) =>
    (await q<{ id: string }>(`select id from menu_items where restaurant_id = $1 and name like '%Masala Chai'`, [rid]))[0]!.id;
  tokenA = await token(ctx.fixtures.restaurantA);
  tokenB = await token(ctx.fixtures.restaurantB);
  chaiA = await item(ctx.fixtures.restaurantA);
  chaiB = await item(ctx.fixtures.restaurantB);
});
after(async () => { await ctx.close(); });

/** Places a real order through the customer API; returns its id, ref and status token. */
const placeOrder = async (restaurant: 'A' | 'B' = 'A', contact?: { mobile: string }) => {
  const res = await web(request(ctx.app).post(`/api/v1/public/tables/${restaurant === 'A' ? tokenA : tokenB}/orders`))
    .set('idempotency-key', randomUUID())
    .send({ items: [{ menuItemId: restaurant === 'A' ? chaiA : chaiB, quantity: 2, note: 'Less sugar' }], ...(contact ? { contact } : {}) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const [row] = await q<{ id: string }>(
    'select id from orders where restaurant_id = $1 and order_ref = $2',
    [restaurant === 'A' ? ctx.fixtures.restaurantA : ctx.fixtures.restaurantB, res.body.order.ref]);
  return { id: row!.id, ref: res.body.order.ref as string, statusToken: res.body.statusToken as string };
};
const detail = async (userId: string, id: string) => (await get(userId, `/${id}`)).body.order;
const move = async (userId: string, id: string, to: OrderStatus, reason?: string) => {
  const current = await detail(ctx.fixtures.ownerA, id);
  return send('post', userId, `/${id}/status`, { to, version: current.version, ...(reason ? { reason } : {}) });
};
/**
 * A setup step that must succeed: asserts the response, the resulting status and the
 * version bump, and fails at once with the full response if not. A test must never
 * carry on from a state it did not intend.
 */
const step = async (userId: string, id: string, to: OrderStatus, reason?: string) => {
  const before = await detail(ctx.fixtures.ownerA, id);
  assert.ok(before, `setup: order ${id} could not be read before moving to ${to}`);
  const res = await send('post', userId, `/${id}/status`, { to, version: before.version, ...(reason ? { reason } : {}) });
  assert.equal(res.status, 200, `setup: ${before.status} → ${to} returned ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.order.status, to, `setup: expected ${to}, got ${res.body.order.status}`);
  assert.equal(res.body.order.version, before.version + 1, 'setup: version did not advance by one');
  return res.body.order;
};
const publicStatus = async (statusToken: string) =>
  (await request(ctx.app).get(`/api/v1/public/orders/${statusToken}`).set('x-forwarded-for', nextIp())).body.order;

// =============================================================================== list
describe('order list (FR-051, FR-057)', () => {
  test('shows this restaurant’s orders, newest first, with an item summary and no contact details', async () => {
    const placed = await placeOrder('A', { mobile: '9876543210' });
    const res = await get(ctx.fixtures.managerA, '');
    assert.equal(res.status, 200);
    assert.equal(res.body.timezone, 'Asia/Kolkata');
    const first = res.body.orders[0];
    assert.equal(first.ref, placed.ref);
    assert.deepEqual(first.items, [{ name: 'MARKER-TENANT-A Masala Chai', quantity: 2, note: 'Less sugar' }]);
    assert.equal(first.itemCount, 2);
    assert.equal(first.table.tableNumber, 'T1');
    const text = JSON.stringify(res.body);
    assert.equal(text.includes('MARKER-TENANT-B'), false);
    assert.equal(text.includes('9876543210'), false, 'the list never carries contact details');
  });

  test('filters by status, table, number and date, and pages without repeats', async () => {
    const one = await placeOrder();
    await step(ctx.fixtures.kitchenA, one.id, 'accepted');
    const accepted = await get(ctx.fixtures.ownerA, '?status=accepted');
    assert.ok(accepted.body.orders.length >= 1);
    assert.ok(accepted.body.orders.every((o: { status: string }) => o.status === 'accepted'));

    const byNumber = await get(ctx.fixtures.ownerA, `?q=${encodeURIComponent(one.ref)}`);
    assert.deepEqual(byNumber.body.orders.map((o: { ref: string }) => o.ref), [one.ref]);

    const [t2] = await q<{ id: string }>(`select id from dining_tables where restaurant_id = $1 and table_number = 'T2'`,
      [ctx.fixtures.restaurantA]);
    assert.equal((await get(ctx.fixtures.ownerA, `?table=${t2!.id}`)).body.orders.length, 0);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const todays = await get(ctx.fixtures.ownerA, `?from=${today}&to=${today}`);
    assert.ok(todays.body.orders.some((o: { ref: string }) => o.ref === one.ref));
    assert.equal((await get(ctx.fixtures.ownerA, '?from=2000-01-01&to=2000-01-02')).body.orders.length, 0);

    const seen: string[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const page = await get(ctx.fixtures.ownerA, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(page.status, 200);
      seen.push(...page.body.orders.map((o: { id: string }) => o.id));
      cursor = page.body.nextCursor;
    }
    assert.equal(new Set(seen).size, seen.length, 'no order appears on two pages');
    const [total] = await q<{ n: number }>('select count(*)::int as n from orders where restaurant_id = $1', [ctx.fixtures.restaurantA]);
    assert.equal(seen.length, total!.n);
  });

  test('invalid filters are refused', async () => {
    for (const query of ['?status=eaten', '?limit=0', '?limit=1000', '?from=yesterday', '?cursor=%%%', '?restaurantId=x']) {
      assert.equal((await get(ctx.fixtures.ownerA, query)).status, 400, query);
    }
  });

  test('the kitchen view lists active orders only, oldest first', async () => {
    const res = await get(ctx.fixtures.kitchenA, '?view=kitchen');
    assert.equal(res.status, 200);
    const orders = res.body.orders as { status: string; placedAt: string }[];
    assert.ok(orders.every((o) => ['pending', 'accepted', 'preparing', 'ready'].includes(o.status)));
    const times = orders.map((o) => Date.parse(o.placedAt));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });
});

// ============================================================================= detail
describe('order detail (FR-051)', () => {
  test('uses the order snapshot, shows history, and shows contact details only to permitted roles', async () => {
    const placed = await placeOrder('A', { mobile: '9123456780' });
    await q(`update menu_items set name = 'Renamed Chai', price_minor = 99999 where id = $1`, [chaiA]);
    try {
      const owner = await detail(ctx.fixtures.ownerA, placed.id);
      assert.equal(owner.lines[0].name, 'MARKER-TENANT-A Masala Chai');
      assert.equal(owner.lines[0].unitPriceMinor, 3000);
      assert.deepEqual(owner.contact, { mobile: '9123456780', email: null });
      assert.deepEqual(owner.history.map((h: { to: string }) => h.to), ['pending']);

      assert.deepEqual((await detail(ctx.fixtures.billingA, placed.id)).contact, { mobile: '9123456780', email: null });
      const kitchen = await get(ctx.fixtures.kitchenA, `/${placed.id}`);
      assert.equal(kitchen.status, 200);
      assert.equal('contact' in kitchen.body.order, false, 'kitchen never receives contact details');
      assert.equal(JSON.stringify(kitchen.body).includes('9123456780'), false);
    } finally {
      await q(`update menu_items set name = 'MARKER-TENANT-A Masala Chai', price_minor = 3000 where id = $1`, [chaiA]);
    }
  });

  test("another restaurant's order, a missing one and a malformed id all return not found", async () => {
    const theirs = await placeOrder('B');
    assert.equal((await get(ctx.fixtures.ownerA, `/${theirs.id}`)).status, 404);
    assert.equal((await get(ctx.fixtures.ownerA, `/${randomUUID()}`)).status, 404);
    assert.equal((await get(ctx.fixtures.ownerA, '/not-an-id')).status, 404);
  });

  test('platform admins, even with support access, and signed-out callers get nothing', async () => {
    assert.equal((await get(ctx.fixtures.adminGranted, '')).status, 403);
    assert.equal((await request(ctx.app).get('/api/v1/restaurant/orders')).status, 401);
  });
});

// ======================================================================== transitions
describe('status transitions (FR-052, FR-053, FR-055)', () => {
  test('kitchen moves an order through its steps; billing serves it; each step is in the history', async () => {
    const order = await placeOrder();
    for (const to of ['accepted', 'preparing', 'ready'] as const) {
      const res = await move(ctx.fixtures.kitchenA, order.id, to);
      assert.equal(res.status, 200, `${to}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.order.status, to);
    }
    assert.equal((await move(ctx.fixtures.kitchenA, order.id, 'served')).status, 403, 'kitchen does not serve');
    assert.equal((await move(ctx.fixtures.billingA, order.id, 'served')).status, 200);

    const history = (await detail(ctx.fixtures.ownerA, order.id)).history as { from: string | null; to: string; byRole: string | null }[];
    assert.deepEqual(history.map((h) => [h.from, h.to, h.byRole]), [
      [null, 'pending', null], ['pending', 'accepted', 'kitchen'], ['accepted', 'preparing', 'kitchen'],
      ['preparing', 'ready', 'kitchen'], ['ready', 'served', 'billing'],
    ]);
  });

  test('skipping, going backwards and leaving a finished order are refused', async () => {
    const order = await placeOrder();
    assert.equal((await move(ctx.fixtures.ownerA, order.id, 'ready')).status, 409, 'no skipping');
    assert.equal((await move(ctx.fixtures.ownerA, order.id, 'pending')).status, 409, 'no staying put');
    await step(ctx.fixtures.ownerA, order.id, 'accepted');
    await step(ctx.fixtures.ownerA, order.id, 'preparing');
    assert.equal((await move(ctx.fixtures.ownerA, order.id, 'accepted')).status, 409, 'no going back by status');
    await step(ctx.fixtures.ownerA, order.id, 'ready');
    await step(ctx.fixtures.ownerA, order.id, 'served');
    for (const to of ['pending', 'accepted', 'ready', 'cancelled'] as const) {
      assert.equal((await move(ctx.fixtures.ownerA, order.id, to, 'Changed my mind')).status, 409, `served → ${to}`);
    }
  });

  test('billing cannot do kitchen steps; kitchen cannot cancel once preparing', async () => {
    const order = await placeOrder();
    assert.equal((await move(ctx.fixtures.billingA, order.id, 'accepted')).status, 403);
    await step(ctx.fixtures.kitchenA, order.id, 'accepted');
    await step(ctx.fixtures.kitchenA, order.id, 'preparing');
    assert.equal((await move(ctx.fixtures.kitchenA, order.id, 'cancelled', 'Out of stock')).status, 403);
    assert.equal((await move(ctx.fixtures.managerA, order.id, 'cancelled', 'Out of stock')).status, 200);
  });

  test('a stale version is refused with a clear conflict (FR-058)', async () => {
    const order = await placeOrder();
    const { version } = await detail(ctx.fixtures.ownerA, order.id);
    assert.equal((await send('post', ctx.fixtures.kitchenA, `/${order.id}/status`, { to: 'accepted', version })).status, 200);
    const stale = await send('post', ctx.fixtures.managerA, `/${order.id}/status`, { to: 'accepted', version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VERSION');
  });

  test('eight devices pressing Accept at once leave exactly one change', async () => {
    const order = await placeOrder();
    const { version } = await detail(ctx.fixtures.ownerA, order.id);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      send('post', ctx.fixtures.kitchenA, `/${order.id}/status`, { to: 'accepted', version })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 7);
    const history = (await detail(ctx.fixtures.ownerA, order.id)).history as { to: string }[];
    assert.equal(history.filter((h) => h.to === 'accepted').length, 1);
  });

  test("another restaurant's order cannot be moved, and nothing changes", async () => {
    const theirs = await placeOrder('B');
    const res = await send('post', ctx.fixtures.ownerA, `/${theirs.id}/status`, { to: 'accepted', version: 1 });
    assert.equal(res.status, 404);
    assert.equal((await q<{ status: string }>('select status from orders where id = $1', [theirs.id]))[0]!.status, 'pending');
  });
});

// =========================================================================== cancelling
describe('cancelling (FR-054)', () => {
  test('needs a reason; is audited; the customer sees it only in general terms', async () => {
    const order = await placeOrder();
    const bare = await move(ctx.fixtures.kitchenA, order.id, 'cancelled');
    assert.equal(bare.status, 400);
    assert.equal(bare.body.error.code, 'REASON_REQUIRED');

    const res = await move(ctx.fixtures.kitchenA, order.id, 'cancelled', 'Kitchen closed early');
    assert.equal(res.status, 200);
    assert.equal(res.body.order.cancelReason, 'Kitchen closed early');
    const [entry] = await q<{ summary: { reason: string; from: string } }>(
      `select summary from audit_log where action = 'order.cancelled' and entity_id = $1`, [order.id]);
    assert.deepEqual([entry!.summary.from, entry!.summary.reason], ['pending', 'Kitchen closed early']);
    const history = (await detail(ctx.fixtures.ownerA, order.id)).history as { to: string; reason: string | null }[];
    assert.equal(history.at(-1)!.reason, 'Kitchen closed early');

    const seen = await publicStatus(order.statusToken);
    assert.equal(seen.status, 'cancelled');
    assert.equal(JSON.stringify(seen).includes('Kitchen closed early'), false, "staff's words stay internal");
  });
});

// ============================================================================ revert
describe('revert one step (FR-053, BR-ORD-03)', () => {
  test('owners and managers take an order back one step, with a reason, audited', async () => {
    const order = await placeOrder();
    await step(ctx.fixtures.kitchenA, order.id, 'accepted');
    await step(ctx.fixtures.kitchenA, order.id, 'preparing');
    await step(ctx.fixtures.kitchenA, order.id, 'ready');
    const current = await detail(ctx.fixtures.ownerA, order.id);

    assert.equal((await send('post', ctx.fixtures.kitchenA, `/${order.id}/revert`,
      { version: current.version, reason: 'Wrong table' })).status, 403);
    assert.equal((await send('post', ctx.fixtures.ownerA, `/${order.id}/revert`, { version: current.version })).status, 400,
      'a reason is required');

    const res = await send('post', ctx.fixtures.managerA, `/${order.id}/revert`, { version: current.version, reason: 'Marked ready too soon' });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.status, 'preparing');
    assert.equal(res.body.order.history.at(-1).reason, 'Marked ready too soon');
    const [entry] = await q<{ summary: { from: string; to: string } }>(
      `select summary from audit_log where action = 'order.reverted' and entity_id = $1`, [order.id]);
    assert.deepEqual([entry!.summary.from, entry!.summary.to], ['ready', 'preparing']);
  });

  test('served can go back to ready; pending and cancelled cannot be reverted', async () => {
    const served = await placeOrder();
    for (const to of ['accepted', 'preparing', 'ready', 'served'] as const) await step(ctx.fixtures.ownerA, served.id, to);
    let current = await detail(ctx.fixtures.ownerA, served.id);
    const back = await send('post', ctx.fixtures.ownerA, `/${served.id}/revert`, { version: current.version, reason: 'Not served yet' });
    assert.equal(back.body.order.status, 'ready');

    const pending = await placeOrder();
    current = await detail(ctx.fixtures.ownerA, pending.id);
    assert.equal((await send('post', ctx.fixtures.ownerA, `/${pending.id}/revert`, { version: current.version, reason: 'x x x' })).status, 409);
    await step(ctx.fixtures.ownerA, pending.id, 'cancelled', 'Duplicate order');
    current = await detail(ctx.fixtures.ownerA, pending.id);
    assert.equal((await send('post', ctx.fixtures.ownerA, `/${pending.id}/revert`, { version: current.version, reason: 'Undo cancel' })).status, 409);
  });
});

// ======================================================================= database guard
describe('the database enforces the workflow on its own (design/01 §4.1)', () => {
  const asRole = (userId: string, fn: (c: import('pg').PoolClient) => Promise<unknown>) =>
    ctx.db.asStaff({ userId, aal: 'aal1' }, fn);

  test('contract: the database guard and the shared state machine agree for every role, from and to', async () => {
    const order = await placeOrder();
    const roles: [StaffRole, string][] = [['owner', ctx.fixtures.ownerA], ['manager', ctx.fixtures.managerA],
      ['kitchen', ctx.fixtures.kitchenA], ['billing', ctx.fixtures.billingA]];
    const disagreements: string[] = [];
    for (const [role, userId] of roles) {
      for (const from of ORDER_STATUSES) {
        for (const to of ORDER_STATUSES) {
          if (from === to) continue;
          // Set the starting state as the table owner (no role checks apply to it).
          await ctx.owner.query(`update orders set status = $2::order_status,
                                   cancel_reason = case when $2::order_status = 'cancelled' then 'setup' end where id = $1`,
            [order.id, from]);
          const expected = canTransition(role, from, to) || (canRevert(role, from) && revertTarget(from) === to);
          let allowed = true;
          try {
            await asRole(userId, async (c) => {
              await c.query(`select set_config('app.status_reason', 'contract test', true)`);
              const result = await c.query(`update orders set status = $2::order_status,
                                              cancel_reason = case when $2::order_status = 'cancelled' then 'contract test' end
                                            where id = $1`, [order.id, to]);
              assert.equal(result.rowCount, 1, 'the row was visible and updated');
            });
          } catch (error) {
            // Only the guard's own refusals count as "not allowed". Anything else is
            // a broken test, and must not pass as agreement.
            const code = (error as { code?: string }).code;
            if (code !== '23514' && code !== '42501') throw error;
            allowed = false;
          }
          if (allowed !== expected) disagreements.push(`${role}: ${from} → ${to} (db ${allowed}, shared ${expected})`);
        }
      }
    }
    assert.deepEqual(disagreements, []);
  });

  test('a placed order’s amounts, items, table and number cannot be changed by anyone on staff', async () => {
    const order = await placeOrder();
    for (const statement of [
      'update orders set subtotal_minor = 1 where id = $1', 'update orders set order_ref = $$X$$ where id = $1',
      `update orders set special_instructions = 'x' where id = $1`,
    ]) {
      await assert.rejects(() => asRole(ctx.fixtures.ownerA, (c) => c.query(statement, [order.id])), /permission denied|cannot be edited/, statement);
    }
    await assert.rejects(() => asRole(ctx.fixtures.ownerA, (c) => c.query('update order_items set quantity = 9 where order_id = $1', [order.id])),
      /permission denied/);
    await assert.rejects(() => asRole(ctx.fixtures.ownerA, (c) => c.query('delete from orders where id = $1', [order.id])), /permission denied/);
  });

  test('cancelling without a reason is refused by the database too', async () => {
    const order = await placeOrder();
    await assert.rejects(() => asRole(ctx.fixtures.ownerA, (c) =>
      c.query(`update orders set status = 'cancelled', cancel_reason = 'Out of stock' where id = $1`, [order.id])), /reason is required/);
  });

  test("a cancelled order's reason and author cannot be changed afterwards", async () => {
    const order = await placeOrder();
    await step(ctx.fixtures.kitchenA, order.id, 'cancelled', 'Out of paneer');
    for (const role of [ctx.fixtures.ownerA, ctx.fixtures.managerA, ctx.fixtures.kitchenA]) {
      await assert.rejects(() => asRole(role, (c) =>
        c.query(`update orders set cancel_reason = 'Customer left' where id = $1`, [order.id])), /cannot be changed/);
      await assert.rejects(() => asRole(role, (c) =>
        c.query('update orders set cancelled_by = $2 where id = $1', [order.id, ctx.fixtures.ownerA])), /cannot be changed/);
    }
    const [row] = await q<{ cancel_reason: string; cancelled_by: string }>(
      'select cancel_reason, cancelled_by from orders where id = $1', [order.id]);
    assert.deepEqual([row!.cancel_reason, row!.cancelled_by], ['Out of paneer', ctx.fixtures.kitchenA]);
  });

  test('cancelled_by cannot be set on an order that is not being cancelled', async () => {
    const order = await placeOrder();
    await assert.rejects(() => asRole(ctx.fixtures.ownerA, (c) =>
      c.query('update orders set cancelled_by = $2 where id = $1', [order.id, ctx.fixtures.ownerA])), /set only by cancelling/);
  });

  test('status history cannot be written, changed or deleted by staff', async () => {
    const order = await placeOrder();
    for (const statement of [
      `insert into order_status_history (restaurant_id, order_id, to_status) select restaurant_id, id, 'served' from orders where id = $1`,
      `update order_status_history set reason = 'x' where order_id = $1`,
      'delete from order_status_history where order_id = $1',
    ]) {
      await assert.rejects(() => asRole(ctx.fixtures.ownerA, (c) => c.query(statement, [order.id])), /permission denied/, statement);
    }
    await assert.rejects(() => ctx.owner.query('delete from order_status_history where order_id = $1', [order.id]), /append-only|not allowed|denied/i);
  });

  test("restaurant A's staff cannot change restaurant B's orders at the database level", async () => {
    const theirs = await placeOrder('B');
    const result = await asRole(ctx.fixtures.ownerA, (c) =>
      c.query(`update orders set staff_note = 'x' where id = $1`, [theirs.id])) as { rowCount: number };
    assert.equal(result.rowCount, 0);
  });
});

// ========================================================================== staff note
describe('staff note (FR-059)', () => {
  test('any staff role can keep an internal note the customer never sees', async () => {
    const order = await placeOrder();
    const { version } = await detail(ctx.fixtures.ownerA, order.id);
    const res = await send('patch', ctx.fixtures.kitchenA, `/${order.id}/staff-note`, { note: ' Regular — extra chutney ', version });
    assert.equal(res.status, 200);
    assert.equal(res.body.order.staffNote, 'Regular — extra chutney');
    assert.equal(JSON.stringify(await publicStatus(order.statusToken)).includes('chutney'), false);
    assert.equal((await send('patch', ctx.fixtures.kitchenA, `/${order.id}/staff-note`, { note: 'again', version })).status, 409);
    assert.equal((await send('patch', ctx.fixtures.ownerA, `/${order.id}/staff-note`,
      { note: 'x'.repeat(501), version: version + 1 })).status, 400);
  });
});

// ================================================================================ live
describe('live updates (FR-050, design D-05)', () => {
  test('reports new and changed orders since a cursor, for this restaurant only', async () => {
    const start = await get(ctx.fixtures.kitchenA, '/live');
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.changes, []);

    const mine = await placeOrder();
    const theirs = await placeOrder('B');
    const next = await get(ctx.fixtures.kitchenA, `/live?since=${encodeURIComponent(start.body.cursor)}`);
    assert.ok(next.body.newOrders.some((o: { ref: string }) => o.ref === mine.ref));
    const ids = next.body.changes.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(mine.id));
    assert.equal(ids.includes(theirs.id), false, "never another restaurant's orders");
    assert.ok(Date.parse(next.body.cursor) >= Date.parse(start.body.cursor));

    await step(ctx.fixtures.kitchenA, mine.id, 'accepted');
    const after = await get(ctx.fixtures.kitchenA, `/live?since=${encodeURIComponent(next.body.cursor)}`);
    assert.ok(after.body.changes.some((c: { id: string; version: number }) => c.id === mine.id && c.version === 2));
  });

  test('a malformed cursor is refused', async () => {
    assert.equal((await get(ctx.fixtures.kitchenA, '/live?since=yesterday')).status, 400);
  });
});

// ====================================================================== customer view
describe("the customer's status page follows the real lifecycle (FR-041)", () => {
  test('each staff step shows on the status page, with nothing internal', async () => {
    const order = await placeOrder('A', { mobile: '9000000001' });
    assert.equal((await publicStatus(order.statusToken)).status, 'pending');
    await step(ctx.fixtures.kitchenA, order.id, 'accepted');
    await step(ctx.fixtures.kitchenA, order.id, 'preparing');
    const seen = await publicStatus(order.statusToken);
    assert.equal(seen.status, 'preparing');
    const text = JSON.stringify(seen);
    for (const internal of ['9000000001', 'version', 'staffNote', 'history', 'cancelReason']) {
      assert.equal(text.includes(internal), false, `leaks ${internal}`);
    }
  });
});
