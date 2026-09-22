// Billing (PRD FR-070 … FR-084, BR-BILL-01 … 06, BR-ORD-03/04): drafts as snapshots,
// discounts and the manager cap, gap-free numbering under concurrency, the content
// hash, immutability enforced by the database on its own, voiding, payments and
// reversals, the order-workflow rules that depend on bills, audit, isolation — and
// the hash-chained ledger, numbered copies (PDF and print) and the sales report.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { computeBill, type OrderStatus } from '@dineflow/shared';
import { auditActions, createTestContext, signToken, TEST_QR_KEYS, type TestContext } from './helpers.ts';
import { parseKeyring, signQrToken } from '../src/lib/qr-token.ts';
import { canonicalTextOf, loadBill } from '../src/modules/billing/routes.ts';
import { csvCell } from '../src/modules/reports/routes.ts';
import { verifyBillingLedger } from '@dineflow/db/billing-ledger';

let ctx: TestContext;
const keyring = parseKeyring(TEST_QR_KEYS);
const HIGH = { limit: 100_000, windowSeconds: 600 };

let ipCounter = 0;
const nextIp = () => `198.18.${Math.floor((ipCounter += 1) / 250) % 250}.${ipCounter % 250 + 1}`;
const web = (req: request.Test) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', nextIp());

type Row = Record<string, unknown>;
const q = async <T extends Row = Row>(sql: string, params: unknown[] = []) => (await ctx.owner.query<T>(sql, params)).rows;
const cookie = async (userId: string) => `df_at=${await signToken({ sub: userId })}`;
const get = async (userId: string, path: string) =>
  request(ctx.app).get(`/api/v1/restaurant${path}`).set('cookie', await cookie(userId));
const send = async (method: 'post' | 'patch' | 'delete', userId: string, path: string, body?: unknown) =>
  web(request(ctx.app)[method](`/api/v1/restaurant${path}`)).set('cookie', await cookie(userId)).send(body as object);

const tokens: Record<'A' | 'B', string> = { A: '', B: '' };
const chai: Record<'A' | 'B', string> = { A: '', B: '' };

before(async () => {
  ctx = await createTestContext({ orderLimits: { perIp: HIGH, perTable: HIGH, perRestaurant: HIGH } });
  for (const [key, rid] of [['A', ctx.fixtures.restaurantA], ['B', ctx.fixtures.restaurantB]] as const) {
    const [qr] = await q<{ qr_id: string; key_id: number }>(
      `select q.qr_id, q.key_id from table_qr_tokens q join dining_tables t on t.id = q.table_id
        where q.restaurant_id = $1 and t.table_number = 'T1' and q.revoked_at is null`, [rid]);
    tokens[key] = signQrToken(keyring, qr!.qr_id, qr!.key_id);
    chai[key] = (await q<{ id: string }>(`select id from menu_items where restaurant_id = $1 and name like '%Masala Chai'`, [rid]))[0]!.id;
  }
});
after(async () => { await ctx.close(); });

/** Places a real order at table T1 through the customer API: 2 × Masala Chai (₹30). */
const placeOrder = async (restaurant: 'A' | 'B' = 'A', quantity = 2) => {
  const res = await web(request(ctx.app).post(`/api/v1/public/tables/${tokens[restaurant]}/orders`))
    .set('idempotency-key', randomUUID())
    .send({ items: [{ menuItemId: chai[restaurant], quantity }] });
  assert.equal(res.status, 201, `setup: placing an order returned ${res.status} ${JSON.stringify(res.body)}`);
  const rid = restaurant === 'A' ? ctx.fixtures.restaurantA : ctx.fixtures.restaurantB;
  const [row] = await q<{ id: string }>('select id from orders where restaurant_id = $1 and order_ref = $2', [rid, res.body.order.ref]);
  return { id: row!.id, ref: res.body.order.ref as string };
};

/** An order at table T2 (which has no QR code), written directly. */
const orderAtT2 = async () => {
  const rid = ctx.fixtures.restaurantA;
  const [table] = await q<{ id: string }>(`select id from dining_tables where restaurant_id = $1 and table_number = 'T2'`, [rid]);
  const [counter] = await q<{ n: number }>(
    'update order_counters set next_no = next_no + 1 where restaurant_id = $1 returning next_no - 1 as n', [rid]);
  await ctx.owner.query('begin');
  try {
    const [order] = await q<{ id: string }>(
      `insert into orders (restaurant_id, table_id, order_no, order_ref, subtotal_minor, public_token_hash, idempotency_key, request_hash)
       values ($1, $2, $3, $4, 3000, $5, gen_random_uuid(), $6) returning id`,
      [rid, table!.id, counter!.n, String(counter!.n), randomBytes(32), randomBytes(32)]);
    await q(`insert into order_items (restaurant_id, order_id, menu_item_id, position, name_snapshot, unit_price_minor, quantity)
             values ($1, $2, $3, 1, 'Masala Chai', 3000, 1)`, [rid, order!.id, chai.A]);
    await ctx.owner.query('commit');
    return order!.id;
  } catch (error) {
    await ctx.owner.query('rollback');
    throw error;
  }
};

type Bill = {
  id: string; status: string; number: number | null; ref: string | null; version: number; totalMinor: number;
  subtotalMinor: number; discountMinor: number; taxTotalMinor: number; paymentStatus: string | null;
  lines: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
  taxes: { name: string; rateBps: number; taxableMinor: number; amountMinor: number }[];
  payments: { id: string; reversedAt: string | null }[]; orders: { id: string; ref: string; released: boolean }[];
  contentHash: string | null;
};

/** Setup step: a draft for the given orders. Fails at once, with the response, if refused. */
const draft = async (orderIds: string[], userId = ctx.fixtures.billingA): Promise<Bill> => {
  const res = await send('post', userId, '/bills', { orderIds });
  assert.equal(res.status, 201, `setup: creating a draft returned ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.bill;
};
const finalize = async (bill: Bill, userId = ctx.fixtures.billingA): Promise<Bill> => {
  const res = await send('post', userId, `/bills/${bill.id}/finalize`, { version: bill.version });
  assert.equal(res.status, 200, `setup: finalizing returned ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.bill.status, 'finalized');
  return res.body.bill;
};
const issued = async (restaurant: 'A' | 'B' = 'A') => {
  const order = await placeOrder(restaurant);
  const userId = restaurant === 'A' ? ctx.fixtures.billingA : ctx.fixtures.ownerB;
  return finalize(await draft([order.id], userId), userId);
};
const pay = async (bill: Bill, userId = ctx.fixtures.billingA) => {
  const res = await send('post', userId, `/bills/${bill.id}/payments`, { method: 'cash', amountMinor: bill.totalMinor });
  assert.equal(res.status, 201, `setup: paying returned ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.bill as Bill;
};
const orderStep = async (id: string, to: OrderStatus, reason?: string) => {
  const current = (await get(ctx.fixtures.ownerA, `/orders/${id}`)).body.order;
  const res = await send('post', ctx.fixtures.ownerA, `/orders/${id}/status`, { to, version: current.version, ...(reason ? { reason } : {}) });
  assert.equal(res.status, 200, `setup: ${current.status} → ${to} returned ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
};
/** Downloads a bill's PDF (a POST, since each copy is recorded), keeping the body as bytes. */
const pdfOf = async (userId: string, billId: string) =>
  web(request(ctx.app).post(`/api/v1/restaurant/bills/${billId}/pdf`)).set('cookie', await cookie(userId)).buffer(true)
    .parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); });
const counterA = async () =>
  (await q<{ next_no: number }>(`select next_no from bill_counters where restaurant_id = $1 and series = 'main'`,
    [ctx.fixtures.restaurantA]))[0]?.next_no ?? 1;

// ============================================================================ drafts
describe('drafts (FR-070, FR-074)', () => {
  test('a draft covers the chosen orders of one table, with snapshot lines and taxes', async () => {
    const one = await placeOrder();
    const two = await placeOrder('A', 3);
    const bill = await draft([one.id, two.id]);
    assert.equal(bill.status, 'draft');
    assert.equal(bill.number, null, 'no number until finalization (FR-072)');
    assert.deepEqual(bill.orders.map((o) => o.ref).sort(), [one.ref, two.ref].sort());
    assert.deepEqual(bill.lines.map((l) => [l.quantity, l.unitPriceMinor, l.lineTotalMinor]), [[2, 3000, 6000], [3, 3000, 9000]]);
    // The fixture restaurant: prices include a single 5 % tax.
    const expected = computeBill({
      lines: [{ unitPriceMinor: 3000, quantity: 2 }, { unitPriceMinor: 3000, quantity: 3 }], pricesIncludeTax: true,
      taxes: [{ name: 'MARKER-TENANT-A GST', rateBps: 500 }], serviceChargeBps: 0, discount: null, roundingMode: 'none',
    });
    assert.equal(bill.subtotalMinor, 15_000);
    assert.equal(bill.taxTotalMinor, expected.taxTotalMinor);
    assert.equal(bill.totalMinor, 15_000, 'inclusive tax does not change the total');
    assert.deepEqual(bill.taxes, expected.taxes);
    assert.deepEqual(await auditActions(ctx.owner, 'bill.created').then((a) => a.length > 0), true);
  });

  test('refuses cancelled, already-billed, mixed-table and unknown orders', async () => {
    const cancelled = await placeOrder();
    await orderStep(cancelled.id, 'cancelled', 'Customer left');
    let res = await send('post', ctx.fixtures.billingA, '/bills', { orderIds: [cancelled.id] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ORDER_CANCELLED');

    const billed = await placeOrder();
    await draft([billed.id]);
    res = await send('post', ctx.fixtures.billingA, '/bills', { orderIds: [billed.id] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ALREADY_BILLED', 'an order is on at most one live bill (BR-BILL-01)');

    const here = await placeOrder();
    res = await send('post', ctx.fixtures.billingA, '/bills', { orderIds: [here.id, await orderAtT2()] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'MIXED_TABLES');

    res = await send('post', ctx.fixtures.billingA, '/bills', { orderIds: [randomUUID()] });
    assert.equal(res.status, 404);
  });

  test('two staff billing the same order at once: exactly one draft', async () => {
    const order = await placeOrder();
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      send('post', ctx.fixtures.billingA, '/bills', { orderIds: [order.id] })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
    const [count] = await q<{ n: number }>('select count(*)::int as n from bill_orders where order_id = $1', [order.id]);
    assert.equal(count!.n, 1);
  });

  test('later menu and tax changes never alter a bill (FR-074)', async () => {
    const order = await placeOrder();
    const bill = await draft([order.id]);
    await q(`update menu_items set price_minor = 99900 where id = $1`, [chai.A]);
    await q(`update tax_components set rate_bps = 1800 where restaurant_id = $1`, [ctx.fixtures.restaurantA]);
    try {
      const after = (await get(ctx.fixtures.billingA, `/bills/${bill.id}`)).body.bill;
      assert.deepEqual([after.lines, after.taxes, after.totalMinor], [bill.lines, bill.taxes, bill.totalMinor]);
      const done = await finalize(after);
      assert.deepEqual([done.lines, done.taxes, done.totalMinor], [bill.lines, bill.taxes, bill.totalMinor]);
    } finally {
      await q(`update menu_items set price_minor = 3000 where id = $1`, [chai.A]);
      await q(`update tax_components set rate_bps = 500 where restaurant_id = $1`, [ctx.fixtures.restaurantA]);
    }
  });

  test('service charge, exclusive tax and rounding follow the settings in force (FR-073, FR-082)', async () => {
    const rid = ctx.fixtures.restaurantB;
    await q(`update restaurant_settings set prices_include_tax = false, service_charge_bps = 1000, rounding_mode = 'nearest_1'
              where restaurant_id = $1`, [rid]);
    await q(`insert into tax_components (restaurant_id, name, rate_bps, sort_order) values ($1, 'Second', 250, 9)`, [rid]);
    try {
      const order = await placeOrder('B', 7);
      const bill = await draft([order.id], ctx.fixtures.ownerB);
      const expected = computeBill({
        lines: [{ unitPriceMinor: 3000, quantity: 7 }], pricesIncludeTax: false,
        taxes: [{ name: 'MARKER-TENANT-B GST', rateBps: 500 }, { name: 'Second', rateBps: 250 }],
        serviceChargeBps: 1000, discount: null, roundingMode: 'nearest_1',
      });
      assert.equal(bill.totalMinor, expected.totalMinor);
      assert.deepEqual(bill.taxes, expected.taxes);
      assert.equal(bill.totalMinor % 100, 0);
    } finally {
      await q(`update restaurant_settings set prices_include_tax = true, service_charge_bps = 0, rounding_mode = 'none'
                where restaurant_id = $1`, [rid]);
      await q(`delete from tax_components where restaurant_id = $1 and name = 'Second'`, [rid]);
    }
  });

  test('a draft can be discarded; its orders are free again and no number is used (decision 7)', async () => {
    const order = await placeOrder();
    const bill = await draft([order.id]);
    const before = await counterA();
    const res = await send('delete', ctx.fixtures.billingA, `/bills/${bill.id}`);
    assert.equal(res.status, 204);
    assert.equal((await get(ctx.fixtures.billingA, `/bills/${bill.id}`)).status, 404);
    assert.equal(await counterA(), before);
    await draft([order.id]);
    const [entry] = await q<{ summary: { orderRefs: string[] } }>(
      `select summary from audit_log where action = 'bill.discarded' and entity_id = $1`, [bill.id]);
    assert.deepEqual(entry!.summary.orderRefs, [order.ref]);
  });
});

// ========================================================================= discount
describe('discounts (FR-075, BR-BILL-05)', () => {
  test('owner and manager only, with a reason; managers are capped; never above the subtotal', async () => {
    const bill = await draft([(await placeOrder('A', 10)).id]); // ₹300.00
    const discount = (userId: string, body: object) => send('patch', userId, `/bills/${bill.id}/discount`, body);
    const version = async () => (await get(ctx.fixtures.ownerA, `/bills/${bill.id}`)).body.bill.version as number;

    assert.equal((await discount(ctx.fixtures.billingA, { type: 'fixed', value: 100, reason: 'Regular', version: bill.version })).status, 403);
    assert.equal((await discount(ctx.fixtures.managerA, { type: 'fixed', value: 100, version: bill.version })).status, 400,
      'a reason is required');

    // The fixture cap is 20 %: ₹60.00 of ₹300.00 is allowed, ₹60.01 is not.
    const over = await discount(ctx.fixtures.managerA, { type: 'fixed', value: 6001, reason: 'Regular guest', version: bill.version });
    assert.equal(over.status, 403);
    assert.equal(over.body.error.code, 'DISCOUNT_ABOVE_LIMIT');
    const ok = await discount(ctx.fixtures.managerA, { type: 'percent', value: 2000, reason: 'Regular guest', version: bill.version });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.bill.discountMinor, 6000);
    assert.equal(ok.body.bill.totalMinor, 24_000);

    const stale = await discount(ctx.fixtures.ownerA, { type: 'fixed', value: 1, reason: 'Late change', version: bill.version });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_VERSION');

    const tooMuch = await discount(ctx.fixtures.ownerA, { type: 'fixed', value: 30_001, reason: 'Oops', version: await version() });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.error.code, 'DISCOUNT_TOO_LARGE');
    const all = await discount(ctx.fixtures.ownerA, { type: 'fixed', value: 30_000, reason: 'On the house', version: await version() });
    assert.equal(all.status, 200, 'an owner is not capped; total may reach zero');
    assert.equal(all.body.bill.totalMinor, 0);
    const removed = await discount(ctx.fixtures.ownerA, { type: null, version: await version() });
    assert.equal(removed.body.bill.totalMinor, 30_000);
    assert.equal((await auditActions(ctx.owner, 'bill.discount_applied')).length >= 3, true);
  });

  test('the database caps a manager even without the API', async () => {
    const bill = await draft([(await placeOrder('A', 10)).id]);
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.managerA, aal: 'aal1' }, (c) => c.query(
      `update bills set discount_type = 'fixed', discount_value = 9000, discount_minor = 9000, discount_reason = 'Too much',
              total_minor = total_minor - 9000 where id = $1`, [bill.id])), /manager limit/);
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.billingA, aal: 'aal1' }, (c) => c.query(
      `update bills set discount_type = 'fixed', discount_value = 100, discount_minor = 100, discount_reason = 'Sneaky',
              total_minor = total_minor - 100 where id = $1`, [bill.id])), /owner or manager/);
  });

  test('a finalized bill takes no discount', async () => {
    const bill = await issued();
    const res = await send('patch', ctx.fixtures.ownerA, `/bills/${bill.id}/discount`,
      { type: 'fixed', value: 100, reason: 'Too late', version: bill.version });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NOT_DRAFT');
  });
});

// ======================================================================= finalize
describe('finalization and numbering (FR-072, FR-076, BR-BILL-03)', () => {
  test('numbers are sequential, the reference is the plain number, and a repeat returns the same bill', async () => {
    const first = await issued();
    const second = await issued();
    assert.equal(second.number, first.number! + 1);
    assert.equal(second.ref, String(second.number));
    const again = await send('post', ctx.fixtures.billingA, `/bills/${second.id}/finalize`, { version: 1 });
    assert.equal(again.status, 200);
    assert.equal(again.body.repeated, true);
    assert.equal(again.body.bill.number, second.number);
    assert.equal(await counterA(), second.number! + 1, 'a repeat draws no number');
  });

  test('the content hash is the SHA-256 of the canonical bill text', async () => {
    const bill = await issued();
    const text = await ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' },
      async (c) => canonicalTextOf((await loadBill(c, bill.id))!, ctx.fixtures.restaurantA));
    assert.equal(bill.contentHash, createHash('sha256').update(text).digest('hex'));
  });

  test('concurrent finalizations: every number used once, no gaps; one bill finalized many times gets one number', async () => {
    const start = await counterA();
    const drafts = await Promise.all(Array.from({ length: 8 }, async () => draft([(await placeOrder()).id])));
    const results = await Promise.all(drafts.map((d) =>
      send('post', ctx.fixtures.billingA, `/bills/${d.id}/finalize`, { version: d.version })));
    assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
    const numbers = results.map((r) => r.body.bill.number as number).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 8 }, (_, i) => start + i));

    const one = await draft([(await placeOrder()).id]);
    const same = await Promise.all(Array.from({ length: 5 }, () =>
      send('post', ctx.fixtures.billingA, `/bills/${one.id}/finalize`, { version: one.version })));
    assert.deepEqual(same.map((r) => r.status), Array(5).fill(200));
    assert.equal(new Set(same.map((r) => r.body.bill.number)).size, 1);
    assert.equal(same.filter((r) => r.body.repeated === false).length, 1);
    assert.equal(await counterA(), start + 9);
  });

  test('an order cancelled after the draft stops finalization, and no number is used (decision 2)', async () => {
    const order = await placeOrder();
    const bill = await draft([order.id]);
    await orderStep(order.id, 'cancelled', 'Customer left'); // allowed: the bill is only a draft
    const before = await counterA();
    const res = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/finalize`, { version: bill.version });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ORDER_CANCELLED');
    assert.equal(await counterA(), before);
  });

  test('a stale draft version is refused', async () => {
    const bill = await draft([(await placeOrder('A', 10)).id]);
    await send('patch', ctx.fixtures.ownerA, `/bills/${bill.id}/discount`, { type: 'fixed', value: 100, reason: 'Regular', version: bill.version });
    const res = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/finalize`, { version: bill.version });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STALE_VERSION');
  });

  test('kitchen staff have no access to bills', async () => {
    const bill = await issued();
    assert.equal((await get(ctx.fixtures.kitchenA, '/bills')).status, 403);
    assert.equal((await get(ctx.fixtures.kitchenA, `/bills/${bill.id}`)).status, 403);
    assert.equal((await send('post', ctx.fixtures.kitchenA, '/bills', { orderIds: [(await placeOrder()).id] })).status, 403);
  });
});

// ================================================================ immutability (DB)
describe('an issued bill is immutable in the database itself (FR-076, BR-BILL-02)', () => {
  test('even the table owner cannot change amounts, lines, taxes or links, or delete it', async () => {
    const bill = await issued();
    const refused = async (sql: string) => {
      await assert.rejects(ctx.owner.query(sql, [bill.id]), /cannot|only|issued/, sql);
    };
    await refused(`update bills set total_minor = total_minor + 1, subtotal_minor = subtotal_minor + 1 where id = $1`);
    await refused(`update bills set bill_no = bill_no + 1000 where id = $1`);
    await refused(`update bills set issuer_snapshot = '{"name": "Forged"}' where id = $1`);
    await refused(`delete from bills where id = $1`);
    await refused(`update bill_lines set name = 'Forged' where bill_id = $1`);
    await refused(`delete from bill_lines where bill_id = $1`);
    await refused(`update bill_taxes set amount_minor = 0 where bill_id = $1`);
    await refused(`insert into bill_lines (restaurant_id, bill_id, order_item_id, position, name, quantity, unit_price_minor, line_total_minor)
                   select restaurant_id, bill_id, order_item_id, 99, 'Extra', 1, 1, 1 from bill_lines where bill_id = $1 limit 1`);
    await refused(`delete from bill_orders where bill_id = $1`);
    const [still] = await q<{ total_minor: string }>('select total_minor from bills where id = $1', [bill.id]);
    assert.equal(Number(still!.total_minor), bill.totalMinor);
  });

  test('a number can only come from the counter, in order', async () => {
    const bill = await draft([(await placeOrder()).id]);
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' }, (c) => c.query(
      `update bills set status = 'finalized', bill_no = 999999, bill_ref = '999999', content_hash = $2,
              finalized_by = app.uid(), finalized_at = now() where id = $1`, [bill.id, Buffer.alloc(32)])),
    /from the counter/);
  });

  test('staff cannot draw bill numbers or touch the counter directly', async () => {
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.kitchenA, aal: 'aal1' },
      (c) => c.query(`select app.next_bill_no('main')`)), /not permitted/);
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' },
      (c) => c.query(`update bill_counters set next_no = 1`)), /permission denied/);
  });
});

// ============================================================================= void
describe('voiding (FR-077, BR-BILL-06)', () => {
  test('owner or manager, with a reason; the number stays; the orders can be billed again', async () => {
    const order = await placeOrder();
    const bill = await finalize(await draft([order.id]));
    assert.equal((await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/void`, { reason: 'Wrong table', version: bill.version })).status, 403);
    assert.equal((await send('post', ctx.fixtures.managerA, `/bills/${bill.id}/void`, { version: bill.version })).status, 400);
    const res = await send('post', ctx.fixtures.managerA, `/bills/${bill.id}/void`, { reason: 'Wrong table', version: bill.version });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.bill.status, 'void');
    assert.equal(res.body.bill.number, bill.number, 'the number is kept (BR-BILL-03)');
    assert.equal(res.body.bill.orders[0].released, true);

    const pay = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'cash', amountMinor: bill.totalMinor });
    assert.equal(pay.status, 409);
    assert.equal(pay.body.error.code, 'BILL_VOID');

    const again = await finalize(await draft([order.id]));
    assert.ok(again.number! > bill.number!, 'a new bill gets a new number');
    const [entry] = await q<{ summary: { reason: string } }>(`select summary from audit_log where action = 'bill.voided' and entity_id = $1`, [bill.id]);
    assert.equal(entry!.summary.reason, 'Wrong table');
  });

  test('a paid bill cannot be voided until its payment is reversed', async () => {
    const bill = await pay(await issued());
    const res = await send('post', ctx.fixtures.ownerA, `/bills/${bill.id}/void`, { reason: 'Mistake', version: bill.version });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PAYMENT_EXISTS');
    // The database refuses on its own too.
    await assert.rejects(ctx.owner.query(
      `update bills set status = 'void', voided_by = created_by, voided_at = now(), void_reason = 'Direct' where id = $1`, [bill.id]),
    /reverse the payment/);
  });

  test('a draft is discarded, not voided; a void bill cannot be changed', async () => {
    const d = await draft([(await placeOrder()).id]);
    const res = await send('post', ctx.fixtures.ownerA, `/bills/${d.id}/void`, { reason: 'Nope', version: d.version });
    assert.equal(res.status, 409);
    const bill = await issued();
    const voided = await send('post', ctx.fixtures.ownerA, `/bills/${bill.id}/void`, { reason: 'Mistake', version: bill.version });
    assert.equal(voided.status, 200);
    await assert.rejects(ctx.owner.query(`update bills set void_reason = 'Edited' where id = $1`, [bill.id]), /void bill/);
    assert.equal((await send('delete', ctx.fixtures.ownerA, `/bills/${bill.id}`)).status, 409);
  });
});

// ========================================================================= payments
describe('payments (FR-080, FR-081, BR-BILL-06)', () => {
  test('only for a finalized bill, only its exact total, only once; repeating is harmless', async () => {
    const d = await draft([(await placeOrder()).id]);
    let res = await send('post', ctx.fixtures.billingA, `/bills/${d.id}/payments`, { method: 'cash', amountMinor: d.totalMinor });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'NOT_FINALIZED');

    const bill = await finalize(d);
    res = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'cash', amountMinor: bill.totalMinor - 1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'AMOUNT_MISMATCH');

    res = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'upi', amountMinor: bill.totalMinor, reference: 'UPI-123' });
    assert.equal(res.status, 201);
    assert.equal(res.body.bill.paymentStatus, 'paid');
    res = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'upi', amountMinor: bill.totalMinor, reference: 'UPI-123' });
    assert.equal(res.status, 200);
    assert.equal(res.body.repeated, true);
    res = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'cash', amountMinor: bill.totalMinor });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ALREADY_PAID');
    const [n] = await q<{ n: number }>('select count(*)::int as n from payments where bill_id = $1', [bill.id]);
    assert.equal(n!.n, 1);
  });

  test('the amount must be the bill total exactly: partial, over and zero are all refused', async () => {
    const bill = await issued();
    assert.ok(bill.totalMinor > 0, 'setup: this bill has a positive total');
    const attempt = (amountMinor: number) =>
      send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'cash', amountMinor });
    for (const [amount, what] of [[bill.totalMinor - 1, 'a partial payment'], [1, 'a token payment'],
                                  [bill.totalMinor + 1, 'an overpayment'], [0, 'a zero payment']] as const) {
      const res = await attempt(amount);
      assert.equal(res.status, 400, `${what} was not refused: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'AMOUNT_MISMATCH', what);
    }
    assert.equal((await attempt(-1)).status, 400, 'a negative amount is refused by validation');
    const detail = (await get(ctx.fixtures.billingA, `/bills/${bill.id}`)).body.bill;
    assert.equal(detail.paymentStatus, 'unpaid', 'none of those attempts marked the bill paid');
    assert.equal(detail.payments.length, 0);
  });

  test('the database refuses a wrong amount on its own, for every role and for the table owner', async () => {
    const bill = await issued();
    const insert = (userId: string, amount: number) => ctx.db.asStaff({ userId, aal: 'aal1' }, (c) => c.query(
      `insert into payments (restaurant_id, bill_id, method, amount_minor, recorded_by)
       values ($1, $2, 'cash', $3, app.uid())`, [ctx.fixtures.restaurantA, bill.id, amount]));
    for (const userId of [ctx.fixtures.ownerA, ctx.fixtures.managerA, ctx.fixtures.billingA]) {
      for (const amount of [0, 1, bill.totalMinor - 1, bill.totalMinor + 1]) {
        await assert.rejects(insert(userId, amount), /must equal the bill total/, `role could pay ${amount}`);
      }
      // The guard's equality check fires first (a BEFORE trigger), so a negative
      // amount is refused by it rather than by the amount_minor >= 0 constraint.
      await assert.rejects(insert(userId, -1), /must equal the bill total/, 'a negative amount is refused');
    }
    await assert.rejects(ctx.owner.query(
      `insert into payments (restaurant_id, bill_id, method, amount_minor, recorded_by)
       values ($1, $2, 'cash', 0, $3)`, [ctx.fixtures.restaurantA, bill.id, ctx.fixtures.ownerA]),
    /must equal the bill total/, 'not even the table owner can close a bill with zero');
    const [count] = await q<{ n: number }>('select count(*)::int as n from payments where bill_id = $1', [bill.id]);
    assert.equal(count!.n, 0);
  });

  test('a bill discounted to zero is closed with a zero payment, and only with zero', async () => {
    const order = await placeOrder();
    const d = await draft([order.id]);
    const discounted = await send('patch', ctx.fixtures.ownerA, `/bills/${d.id}/discount`,
      { type: 'percent', value: 10_000, reason: 'On the house', version: d.version });
    assert.equal(discounted.status, 200, JSON.stringify(discounted.body));
    assert.equal(discounted.body.bill.totalMinor, 0);
    const bill = await finalize(discounted.body.bill);
    assert.equal(bill.totalMinor, 0);
    const wrong = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'cash', amountMinor: 1 });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'AMOUNT_MISMATCH');
    const res = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method: 'cash', amountMinor: 0 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.bill.paymentStatus, 'paid', 'a zero-total bill can still be closed');
  });

  test('concurrent payments of one bill: exactly one recorded', async () => {
    const bill = await issued();
    const results = await Promise.all(['cash', 'card', 'upi', 'other'].map((method) =>
      send('post', ctx.fixtures.billingA, `/bills/${bill.id}/payments`, { method, amountMinor: bill.totalMinor })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409]);
  });

  test('reversal: owner or manager, with a reason; the payment stays on record; the bill can then be paid or voided', async () => {
    const bill = await pay(await issued());
    const paymentId = bill.payments[0]!.id;
    assert.equal((await send('post', ctx.fixtures.billingA, `/payments/${paymentId}/reverse`, { reason: 'Wrong method' })).status, 403);
    const res = await send('post', ctx.fixtures.managerA, `/payments/${paymentId}/reverse`, { reason: 'Wrong method' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.bill.paymentStatus, 'unpaid');
    assert.equal(res.body.bill.payments.length, 1);
    assert.ok(res.body.bill.payments[0].reversedAt);
    assert.equal((await send('post', ctx.fixtures.managerA, `/payments/${paymentId}/reverse`, { reason: 'Again' })).status, 409);
    await pay(res.body.bill);
    assert.ok((await auditActions(ctx.owner, 'payment.reversed')).length >= 1);
    assert.ok((await auditActions(ctx.owner, 'payment.recorded')).length >= 2);
  });

  test('payments are never edited or deleted, even by the table owner', async () => {
    const bill = await pay(await issued());
    await assert.rejects(ctx.owner.query('update payments set amount_minor = 1 where bill_id = $1', [bill.id]), /only be reversed/);
    await assert.rejects(ctx.owner.query('delete from payments where bill_id = $1', [bill.id]), /never deleted/);
  });
});

// ============================================================ orders ↔ bills
describe('order rules that depend on bills (BR-ORD-03, BR-ORD-04)', () => {
  test('an order on an issued bill cannot be cancelled; the database refuses too', async () => {
    const order = await placeOrder();
    await finalize(await draft([order.id]));
    const current = (await get(ctx.fixtures.ownerA, `/orders/${order.id}`)).body.order;
    const res = await send('post', ctx.fixtures.ownerA, `/orders/${order.id}/status`,
      { to: 'cancelled', version: current.version, reason: 'Changed mind' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ORDER_BILLED');
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' }, async (c) => {
      await c.query(`select set_config('app.status_reason', 'direct', true)`);
      await c.query(`update orders set status = 'cancelled', cancel_reason = 'direct', cancelled_by = app.uid() where id = $1`, [order.id]);
    }), /finalized bill/);
  });

  test('served → ready only while the order is on no live bill', async () => {
    const order = await placeOrder();
    for (const to of ['accepted', 'preparing', 'ready', 'served'] as const) await orderStep(order.id, to);
    const bill = await draft([order.id]);
    const revert = async () => {
      const current = (await get(ctx.fixtures.ownerA, `/orders/${order.id}`)).body.order;
      return send('post', ctx.fixtures.ownerA, `/orders/${order.id}/revert`, { version: current.version, reason: 'Sent back' });
    };
    const res = await revert();
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ORDER_BILLED');
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' }, async (c) => {
      await c.query(`select set_config('app.status_reason', 'direct', true)`);
      await c.query(`update orders set status = 'ready' where id = $1`, [order.id]);
    }), /on a bill/);
    assert.equal((await send('delete', ctx.fixtures.billingA, `/bills/${bill.id}`)).status, 204);
    assert.equal((await revert()).status, 200, 'allowed again once the draft is discarded');
  });

  test('order detail shows its bill to billing roles, never to kitchen', async () => {
    const order = await placeOrder();
    const bill = await finalize(await draft([order.id]));
    const seen = (await get(ctx.fixtures.billingA, `/orders/${order.id}`)).body.order;
    assert.deepEqual(seen.bill, { id: bill.id, status: 'finalized', ref: bill.ref });
    const kitchen = (await get(ctx.fixtures.kitchenA, `/orders/${order.id}`)).body.order;
    assert.equal('bill' in kitchen, false);
  });
});

// ============================================================ list and billable
describe('list and billable orders', () => {
  test('billable shows unbilled, non-cancelled orders by table', async () => {
    const order = await placeOrder();
    const tables = (await get(ctx.fixtures.billingA, '/bills/billable')).body.tables as { id: string; tableNumber: string }[];
    const t1 = tables.find((t) => t.tableNumber === 'T1');
    assert.ok(t1);
    const orders = (await get(ctx.fixtures.billingA, `/bills/billable?table=${t1.id}`)).body.orders as { id: string }[];
    assert.ok(orders.some((o) => o.id === order.id));
    await draft([order.id]);
    const after = (await get(ctx.fixtures.billingA, `/bills/billable?table=${t1.id}`)).body.orders as { id: string }[];
    assert.equal(after.some((o) => o.id === order.id), false);
  });

  test('the list filters by status, payment and number', async () => {
    const paid = await pay(await issued());
    const unpaid = await issued();
    const byRef = (await get(ctx.fixtures.billingA, `/bills?q=${paid.number}`)).body.bills;
    assert.deepEqual(byRef.map((b: { id: string }) => b.id), [paid.id]);
    const unpaidList = (await get(ctx.fixtures.billingA, '/bills?payment=unpaid&limit=100')).body.bills as { id: string; paymentStatus: string }[];
    assert.ok(unpaidList.some((b) => b.id === unpaid.id));
    assert.ok(unpaidList.every((b) => b.paymentStatus === 'unpaid'));
    const drafts = (await get(ctx.fixtures.billingA, '/bills?status=draft&limit=100')).body.bills as { status: string }[];
    assert.ok(drafts.every((b) => b.status === 'draft'));
  });
});

// ======================================================================== isolation
describe('isolation', () => {
  test('another restaurant, a platform admin and a signed-out caller get nothing', async () => {
    const bill = await pay(await issued());
    for (const path of [`/bills/${bill.id}`]) {
      assert.equal((await get(ctx.fixtures.ownerB, path)).status, 404);
    }
    assert.equal((await send('post', ctx.fixtures.ownerB, `/bills/${bill.id}/finalize`, { version: 1 })).status, 404);
    assert.equal((await send('post', ctx.fixtures.ownerB, `/bills/${bill.id}/void`, { reason: 'Hostile', version: bill.version })).status, 404);
    assert.equal((await send('delete', ctx.fixtures.ownerB, `/bills/${bill.id}`)).status, 404);
    assert.equal((await send('post', ctx.fixtures.ownerB, `/payments/${bill.payments[0]!.id}/reverse`, { reason: 'Hostile' })).status, 404);
    const aOrder = await placeOrder();
    assert.equal((await send('post', ctx.fixtures.ownerB, '/bills', { orderIds: [aOrder.id] })).status, 404);
    const list = JSON.stringify((await get(ctx.fixtures.ownerB, '/bills?limit=100')).body);
    assert.equal(list.includes(bill.id), false);
    assert.equal(list.includes('MARKER-TENANT-A'), false);

    assert.equal((await get(ctx.fixtures.adminPlain, `/bills/${bill.id}`)).status, 403);
    assert.equal((await request(ctx.app).get(`/api/v1/restaurant/bills/${bill.id}`)).status, 401);
    assert.equal((await get(ctx.fixtures.ownerA, '/bills/not-a-uuid')).status, 404);
  });
});

// =========================================================================== ledger
describe('the billing ledger (Stage-2 conditions 5.1–5.3)', () => {
  const ledger = async (billId: string) =>
    (await q<{ event: string; seq: string }>('select event::text, seq::text from bill_ledger where bill_id = $1 order by seq', [billId]))
      .map((r) => r.event);

  test('every step of a bill’s life is ledgered, in order, in the same transaction', async () => {
    const bill = await issued();
    const paid = await pay(bill);
    await send('post', ctx.fixtures.managerA, `/payments/${paid.payments[0]!.id}/reverse`, { reason: 'Wrong method' });
    await send('post', ctx.fixtures.managerA, `/bills/${bill.id}/void`, { reason: 'Wrong table', version: bill.version });
    assert.deepEqual(await ledger(bill.id),
      ['bill_created', 'bill_finalized', 'payment_recorded', 'payment_reversed', 'bill_voided']);

    const d = await draft([(await placeOrder('A', 10)).id]);
    await send('patch', ctx.fixtures.ownerA, `/bills/${d.id}/discount`, { type: 'fixed', value: 100, reason: 'Regular', version: d.version });
    await send('delete', ctx.fixtures.ownerA, `/bills/${d.id}`);
    assert.deepEqual(await ledger(d.id), ['bill_created', 'discount_applied', 'draft_discarded'],
      'a discarded draft keeps its entries (decision 7)');

    const [entry] = await q<{ content_hash: Buffer; actor_role: string }>(
      `select content_hash, actor_role::text from bill_ledger where bill_id = $1 and event = 'bill_finalized'`, [bill.id]);
    assert.equal(entry!.content_hash.toString('hex'), bill.contentHash);
    assert.equal(entry!.actor_role, 'billing');
    assert.equal((await verifyBillingLedger(ctx.owner)).ok, true);
  });

  test('a failed finalization leaves no entry and uses no number', async () => {
    const order = await placeOrder();
    const d = await draft([order.id]);
    await orderStep(order.id, 'cancelled', 'Customer left');
    await send('post', ctx.fixtures.billingA, `/bills/${d.id}/finalize`, { version: d.version });
    assert.deepEqual(await ledger(d.id), ['bill_created']);
  });

  test('staff can read their ledger but never write, edit or delete it; kitchen cannot read it', async () => {
    const asStaff = (userId: string, sql: string) => ctx.db.asStaff({ userId, aal: 'aal1' }, (c) => c.query(sql));
    const read = await asStaff(ctx.fixtures.billingA, 'select count(*)::int as n from bill_ledger');
    assert.ok((read.rows[0] as { n: number }).n > 0);
    assert.equal(((await asStaff(ctx.fixtures.kitchenA, 'select count(*)::int as n from bill_ledger')).rows[0] as { n: number }).n, 0);
    await assert.rejects(asStaff(ctx.fixtures.ownerA, `update bill_ledger set payload = '{}'`), /permission denied/);
    await assert.rejects(asStaff(ctx.fixtures.ownerA, 'delete from bill_ledger'), /permission denied/);
    await assert.rejects(ctx.owner.query(`update bill_ledger set payload = '{}' where seq = 1`), /append-only|not allowed|cannot/i);
  });

  test('concurrent activity in one restaurant still forms one unbroken chain', async () => {
    const drafts = await Promise.all(Array.from({ length: 6 }, async () => draft([(await placeOrder()).id])));
    await Promise.all(drafts.map((d) => send('post', ctx.fixtures.billingA, `/bills/${d.id}/finalize`, { version: d.version })));
    const report = await verifyBillingLedger(ctx.owner, { restaurantId: ctx.fixtures.restaurantA });
    assert.equal(report.ok, true, JSON.stringify(report.findings));
  });

  test('the verifier finds a tampered entry and a tampered bill', async () => {
    const bill = await issued();
    await ctx.owner.query('begin');
    try {
      await ctx.owner.query('alter table bill_ledger disable trigger trg_bill_ledger_append_only');
      await ctx.owner.query(`update bill_ledger set payload = '{"totalMinor": 1}' where bill_id = $1 and event = 'bill_finalized'`, [bill.id]);
      const report = await verifyBillingLedger(ctx.owner, { restaurantId: ctx.fixtures.restaurantA });
      assert.ok(report.findings.some((f) => f.check === 'chain-hash'));
    } finally {
      await ctx.owner.query('rollback');
    }
    await ctx.owner.query('begin');
    try {
      await ctx.owner.query('alter table bills disable trigger trg_bills_guard');
      await ctx.owner.query(`update bills set issuer_snapshot = issuer_snapshot || '{"name": "Forged"}' where id = $1`, [bill.id]);
      const report = await verifyBillingLedger(ctx.owner, { restaurantId: ctx.fixtures.restaurantA });
      assert.ok(report.findings.some((f) => f.check === 'bill-content'));
    } finally {
      await ctx.owner.query('rollback');
    }
    assert.equal((await verifyBillingLedger(ctx.owner)).ok, true);
  });
});

// =========================================================================== copies
describe('copies: PDF and print, originals and duplicates (FR-078, FR-079)', () => {
  test('the first copy is the original; later ones are numbered duplicates; each is ledgered', async () => {
    const bill = await issued();
    const first = await send('post', ctx.fixtures.billingA, `/bills/${bill.id}/print`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.copy, { number: 1, duplicate: false, mark: null });
    const pdf = await pdfOf(ctx.fixtures.billingA, bill.id);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['x-bill-copy'], '2');
    assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), '%PDF-');
    const third = await send('post', ctx.fixtures.ownerA, `/bills/${bill.id}/print`);
    assert.deepEqual(third.body.copy, { number: 3, duplicate: true, mark: 'DUPLICATE COPY 3' });
    const events = await q<{ event: string; content_hash: Buffer }>(
      `select event::text, content_hash from bill_ledger where bill_id = $1 and event in ('pdf_generated', 'bill_printed') order by seq`, [bill.id]);
    assert.deepEqual(events.map((e) => e.event), ['bill_printed', 'pdf_generated', 'bill_printed']);
    assert.ok(events.every((e) => e.content_hash.toString('hex') === bill.contentHash), 'each copy names the content it was made from');
  });

  test('a PDF regenerated later has identical amounts (FR-079)', async () => {
    const bill = await issued();
    const text = async () => (await pdfOf(ctx.fixtures.billingA, bill.id)).body as Buffer;
    const a = await text();
    await q(`update menu_items set price_minor = 12345 where id = $1`, [chai.A]);
    try {
      const b = await text();
      assert.ok(a.length > 1000 && b.length > 1000);
      assert.equal((await get(ctx.fixtures.billingA, `/bills/${bill.id}`)).body.bill.totalMinor, bill.totalMinor);
    } finally {
      await q(`update menu_items set price_minor = 3000 where id = $1`, [chai.A]);
    }
  });

  test('copies are POSTs behind CSRF, and reads never produce one', async () => {
    const bill = await issued();
    // No x-dineflow-client header: the CSRF guard refuses, so no copy is recorded.
    for (const path of ['print', 'pdf']) {
      const res = await request(ctx.app).post(`/api/v1/restaurant/bills/${bill.id}/${path}`)
        .set('cookie', await cookie(ctx.fixtures.billingA)).send();
      assert.equal(res.status, 403, `${path} without the CSRF header`);
    }
    // A cross-site origin is refused too.
    const foreign = await request(ctx.app).post(`/api/v1/restaurant/bills/${bill.id}/print`)
      .set('cookie', await cookie(ctx.fixtures.billingA)).set('x-dineflow-client', 'web')
      .set('origin', 'https://evil.example').send();
    assert.equal(foreign.status, 403);
    // GET is never a copy: reading the bill, the list and the billable orders write nothing.
    const entries = async () => (await q<{ n: number }>(
      `select count(*)::int as n from bill_ledger where restaurant_id = $1`, [ctx.fixtures.restaurantA]))[0]!.n;
    const before = await entries();
    await get(ctx.fixtures.billingA, `/bills/${bill.id}`);
    await get(ctx.fixtures.billingA, '/bills?limit=100');
    await get(ctx.fixtures.billingA, '/bills/billable');
    assert.equal(await entries(), before, 'reads leave the ledger untouched');
    assert.equal((await q('select count(*) from bill_ledger where bill_id = $1 and event in (\'pdf_generated\', \'bill_printed\')',
      [bill.id])).length, 1);
  });

  test('copies made at the same moment get distinct numbers', async () => {
    const bill = await issued();
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      send('post', ctx.fixtures.billingA, `/bills/${bill.id}/print`)));
    assert.deepEqual(results.map((r) => r.status), Array(5).fill(200));
    const numbers = results.map((r) => r.body.copy.number as number).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3, 4, 5], 'no two copies share a number');
    assert.equal(results.filter((r) => r.body.copy.duplicate === false).length, 1, 'exactly one original');
    const [entries] = await q<{ n: number }>(
      `select count(*)::int as n from bill_ledger where bill_id = $1 and event = 'bill_printed'`, [bill.id]);
    assert.equal(entries!.n, 5);
    assert.equal((await verifyBillingLedger(ctx.owner, { restaurantId: ctx.fixtures.restaurantA })).ok, true);
  });

  test('a void bill is marked VOID; a draft has no copies; kitchen and other tenants get nothing', async () => {
    const bill = await issued();
    await send('post', ctx.fixtures.ownerA, `/bills/${bill.id}/void`, { reason: 'Wrong table', version: bill.version });
    const voidCopy = await send('post', ctx.fixtures.ownerA, `/bills/${bill.id}/print`);
    assert.equal(voidCopy.body.copy.mark, 'VOID');
    const d = await draft([(await placeOrder()).id]);
    assert.equal((await send('post', ctx.fixtures.billingA, `/bills/${d.id}/print`)).status, 409);
    assert.equal((await send('post', ctx.fixtures.kitchenA, `/bills/${bill.id}/print`)).status, 403);
    assert.equal((await send('post', ctx.fixtures.ownerB, `/bills/${bill.id}/pdf`)).status, 404);
    await assert.rejects(ctx.db.asStaff({ userId: ctx.fixtures.ownerB, aal: 'aal1' },
      (c) => c.query(`select app.record_bill_copy($1, 'print')`, [bill.id])), /not found/);
  });
});

// =========================================================================== report
describe('sales report (FR-084)', () => {
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  test('by day and by payment method, on the restaurant’s days; void bills are not sales', async () => {
    const before = (await get(ctx.fixtures.ownerA, `/reports/sales?from=${today()}&to=${today()}`)).body;
    const byMethodBefore = (await get(ctx.fixtures.ownerA, `/reports/sales?from=${today()}&to=${today()}&groupBy=method`)).body;
    const paid = await pay(await issued());
    const unpaid = await issued();
    const voided = await issued();
    await send('post', ctx.fixtures.ownerA, `/bills/${voided.id}/void`, { reason: 'Wrong table', version: voided.version });

    const after = (await get(ctx.fixtures.ownerA, `/reports/sales?from=${today()}&to=${today()}`)).body;
    assert.equal(after.timezone, 'Asia/Kolkata');
    assert.equal(after.totals.bills - (before.totals.bills ?? 0), 2);
    assert.equal(after.totals.voidedBills - (before.totals.voidedBills ?? 0), 1);
    assert.equal(after.totals.totalMinor - (before.totals.totalMinor ?? 0), paid.totalMinor + unpaid.totalMinor);
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].day, today());

    const byMethod = (await get(ctx.fixtures.ownerA, `/reports/sales?from=${today()}&to=${today()}&groupBy=method`)).body;
    const cash = (rows: { method: string; amountMinor: number }[]) => rows.find((r) => r.method === 'cash')?.amountMinor ?? 0;
    assert.equal(cash(byMethod.rows) - cash(byMethodBefore.rows), paid.totalMinor);
  });

  test('billing staff see only what they billed', async () => {
    const mine = await issued(); // finalized by billing-A
    const order = await placeOrder();
    await finalize(await draft([order.id], ctx.fixtures.ownerA), ctx.fixtures.ownerA);
    const res = (await get(ctx.fixtures.billingA, `/reports/sales?from=${today()}&to=${today()}`)).body;
    assert.equal(res.scope, 'mine');
    const [count] = await q<{ n: number; total: string }>(
      `select count(*)::int as n, sum(total_minor) as total from bills
        where restaurant_id = $1 and status = 'finalized' and finalized_by = $2`, [ctx.fixtures.restaurantA, ctx.fixtures.billingA]);
    assert.equal(res.totals.bills, count!.n);
    assert.ok(mine.totalMinor > 0);
    assert.equal((await get(ctx.fixtures.ownerA, `/reports/sales?from=${today()}&to=${today()}`)).body.scope, 'all');
  });

  test('CSV export: a POST (it is audited), plain decimals, formula-safe', async () => {
    const res = await send('post', ctx.fixtures.managerA, `/reports/sales/export?from=${today()}&to=${today()}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] ?? '', /^text\/csv/);
    assert.match(res.headers['content-disposition'] ?? '', /attachment; filename="sales-by-day-/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[1], '"Day","Bills","Voided bills","Subtotal","Discounts","Service charge","Tax","Rounding","Total"');
    assert.match(lines[2]!, /^"\d{4}-\d{2}-\d{2}",\d+,\d+,"\d+\.\d{2}"/);
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('+1'), `"'+1"`);
    assert.equal(csvCell('@SUM'), `"'@SUM"`);
    assert.equal(csvCell(12), '12');
    const [entry] = await q<{ summary: { groupBy: string } }>(
      `select summary from audit_log where action = 'report.sales.exported' order by id desc limit 1`);
    assert.equal(entry!.summary.groupBy, 'day');
  });

  test('refuses bad ranges, kitchen staff and other restaurants’ data', async () => {
    assert.equal((await get(ctx.fixtures.ownerA, '/reports/sales?from=2026-02-01&to=2026-01-01')).status, 400);
    assert.equal((await get(ctx.fixtures.ownerA, '/reports/sales?from=2024-01-01&to=2026-01-01')).status, 400);
    assert.equal((await get(ctx.fixtures.ownerA, '/reports/sales')).status, 400);
    assert.equal((await get(ctx.fixtures.kitchenA, `/reports/sales?from=${today()}&to=${today()}`)).status, 403);
    assert.equal((await send('post', ctx.fixtures.kitchenA, `/reports/sales/export?from=${today()}&to=${today()}`)).status, 403);
    // The export writes an audit row, so it must be refused without the CSRF header.
    const noHeader = await request(ctx.app).post(`/api/v1/restaurant/reports/sales/export?from=${today()}&to=${today()}`)
      .set('cookie', await cookie(ctx.fixtures.ownerA)).send();
    assert.equal(noHeader.status, 403);
    const [audits] = await q<{ n: number }>(
      `select count(*)::int as n from audit_log where action = 'report.sales.exported'`);
    const readOnly = await get(ctx.fixtures.ownerA, `/reports/sales?from=${today()}&to=${today()}`);
    assert.equal(readOnly.status, 200);
    const [after] = await q<{ n: number }>(
      `select count(*)::int as n from audit_log where action = 'report.sales.exported'`);
    assert.equal(after!.n, audits!.n, 'reading the report writes nothing');
    const b = (await get(ctx.fixtures.ownerB, `/reports/sales?from=${today()}&to=${today()}`)).body;
    const [own] = await q<{ n: number }>(
      `select count(*)::int as n from bills where restaurant_id = $1 and status = 'finalized'
          and (finalized_at at time zone 'Asia/Kolkata')::date = $2::date`, [ctx.fixtures.restaurantB, today()]);
    assert.equal(b.totals.bills ?? 0, own!.n, 'restaurant B sees only its own bills');
  });
});
