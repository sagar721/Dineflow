// Customer ordering (PRD FR-030 … FR-046): the public menu's ordering settings, the
// server-priced quote, order placement with every revalidation, idempotency,
// numbering, atomicity, contact policy, the status page, snapshots, limits and
// tenant isolation. Restaurant A's customers are the actors; B is the victim.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootLocalApp, createTestContext, signToken, TEST_QR_KEYS, type TestContext } from './helpers.ts';
import { parseKeyring, signQrToken } from '../src/lib/qr-token.ts';
import { statusTokenHash } from '../src/lib/order-token.ts';

let ctx: TestContext;
const keyring = parseKeyring(TEST_QR_KEYS);
const HIGH = { limit: 100_000, windowSeconds: 600 };

let ipCounter = 0;
const nextIp = () => `198.18.${Math.floor((ipCounter += 1) / 250) % 250}.${ipCounter % 250 + 1}`;
const web = (req: request.Test, ip = nextIp()) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', ip);

let tokenA = '';
let paneer = '';
let chai = '';

before(async () => {
  ctx = await createTestContext({ orderLimits: { perIp: HIGH, perTable: HIGH, perRestaurant: HIGH } });
  tokenA = await tokenFor(ctx.fixtures.restaurantA);
  paneer = await itemId(ctx.fixtures.restaurantA, 'Paneer Tikka');
  chai = await itemId(ctx.fixtures.restaurantA, 'Masala Chai');
});
after(async () => { await ctx.close(); });

type Row = Record<string, unknown>;
const q = async <T extends Row = Row>(sql: string, params: unknown[] = []) => (await ctx.owner.query<T>(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(sql, params))[0]!.n);
const cookie = async (userId: string) => `df_at=${await signToken({ sub: userId })}`;

const tokenFor = async (restaurantId: string, tableNumber = 'T1') => {
  const [row] = await q<{ qr_id: string; key_id: number }>(
    `select q.qr_id, q.key_id from table_qr_tokens q join dining_tables t on t.id = q.table_id
      where q.restaurant_id = $1 and t.table_number = $2 and q.revoked_at is null`, [restaurantId, tableNumber]);
  return signQrToken(keyring, row!.qr_id, row!.key_id);
};
const itemId = async (restaurantId: string, name: string) =>
  (await q<{ id: string }>('select id from menu_items where restaurant_id = $1 and name like $2', [restaurantId, `%${name}`]))[0]!.id;

const place = (token: string, body: unknown, key: string | null = randomUUID(), ip?: string) => {
  const req = web(request(ctx.app).post(`/api/v1/public/tables/${token}/orders`), ip);
  if (key !== null) req.set('idempotency-key', key);
  return req.send(body as object);
};
const quote = (token: string, body: unknown) => web(request(ctx.app).post(`/api/v1/public/tables/${token}/quote`)).send(body as object);
const view = (statusToken: string) =>
  request(ctx.app).get(`/api/v1/public/orders/${statusToken}`).set('x-forwarded-for', nextIp());

const ordersOf = (restaurantId: string) => count('select count(*) as n from orders where restaurant_id = $1', [restaurantId]);
const linesOf = (restaurantId: string) => count('select count(*) as n from order_items where restaurant_id = $1', [restaurantId]);
const counterOf = async (restaurantId: string) =>
  Number((await q<{ next_no: number }>('select next_no from order_counters where restaurant_id = $1', [restaurantId]))[0]?.next_no ?? 1);


// ============================================================================= menu
describe('public menu for ordering (FR-030, FR-032, FR-034)', () => {
  test('carries the contact policy and ordering limits the cart needs', async () => {
    const res = await request(ctx.app).get(`/api/v1/public/tables/${tokenA}/menu`).set('x-forwarded-for', nextIp());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.ordering, { contactPolicy: 'optional', maxQtyPerLine: 20, maxItemsPerOrder: 60 });
    assert.equal(res.body.restaurant.acceptingOrders, true);
  });
});

// ============================================================================ quote
describe('quote: server prices for the review screen (FR-036)', () => {
  test('prices come from the database, and nothing is written', async () => {
    const before = await ordersOf(ctx.fixtures.restaurantA);
    const res = await quote(tokenA, { items: [{ menuItemId: paneer, quantity: 2 }, { menuItemId: chai, quantity: 3 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subtotalMinor, 2 * 24900 + 3 * 3000);
    assert.deepEqual(res.body.items.map((i: { unitPriceMinor: number }) => i.unitPriceMinor), [24900, 3000]);
    assert.equal(await ordersOf(ctx.fixtures.restaurantA), before);
  });

  test('a price, total or restaurant sent by the browser is refused, not used', async () => {
    for (const body of [
      { items: [{ menuItemId: paneer, quantity: 1, unitPriceMinor: 1 }] },
      { items: [{ menuItemId: paneer, quantity: 1 }], subtotalMinor: 1 },
      { items: [{ menuItemId: paneer, quantity: 1 }], restaurantId: ctx.fixtures.restaurantB },
    ]) {
      assert.equal((await quote(tokenA, body)).status, 400, JSON.stringify(body));
    }
  });
});

// ======================================================================= placement
describe('placing an order (FR-037 … FR-041)', () => {
  test('creates the order and its lines with server prices, snapshots and a number', async () => {
    const counter = await counterOf(ctx.fixtures.restaurantA);
    const res = await place(tokenA, {
      items: [{ menuItemId: paneer, quantity: 2, note: 'Less spicy' }, { menuItemId: chai, quantity: 3 }],
      specialInstructions: '  Please bring water  ',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { order, statusToken } = res.body;
    assert.equal(order.number, counter);
    assert.equal(order.ref, String(counter));
    assert.equal(order.status, 'pending');
    assert.equal(order.subtotalMinor, 58800);
    assert.equal(order.specialInstructions, 'Please bring water');
    assert.equal(order.table.tableNumber, 'T1');
    assert.deepEqual(order.items.map((i: { name: string; quantity: number; lineTotalMinor: number; note: string | null }) =>
      [i.name, i.quantity, i.lineTotalMinor, i.note]),
    [['MARKER-TENANT-A Paneer Tikka', 2, 49800, 'Less spicy'], ['MARKER-TENANT-A Masala Chai', 3, 9000, null]]);
    assert.match(statusToken, /^[A-Za-z0-9_-]{22}$/);

    const [row] = await q<{ restaurant_id: string; table_number: string; public_token_hash: Buffer }>(
      `select o.restaurant_id, t.table_number, o.public_token_hash from orders o join dining_tables t on t.id = o.table_id
        where o.order_no = $1 and o.restaurant_id = $2`, [counter, ctx.fixtures.restaurantA]);
    assert.equal(row!.table_number, 'T1');
    assert.ok(row!.public_token_hash.equals(statusTokenHash(statusToken)), 'only the hash is stored');
    assert.equal(await count(`select count(*) as n from orders where public_token_hash::text like $1`, [`%${statusToken}%`]), 0);
  });

  test('the response carries no internal ids and no contact details', async () => {
    const res = await place(tokenA, { items: [{ menuItemId: chai, quantity: 1 }], contact: { mobile: '98765 43210' } });
    const text = JSON.stringify(res.body);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), false, 'no uuids');
    assert.equal(text.includes('9876543210'), false, 'contact is not echoed');
  });

  test('empty, malformed and out-of-range carts are refused', async () => {
    const cases: [unknown, number, string?][] = [
      [{ items: [] }, 400, 'CART_EMPTY'],
      [{}, 400],
      [{ items: 'paneer' }, 400],
      [{ items: [{ menuItemId: paneer, quantity: 0 }] }, 400],
      [{ items: [{ menuItemId: paneer, quantity: -1 }] }, 400],
      [{ items: [{ menuItemId: paneer, quantity: 1.5 }] }, 400],
      [{ items: [{ menuItemId: paneer, quantity: 1e9 }] }, 400],
      [{ items: [{ menuItemId: paneer, quantity: '2' }] }, 400],
      [{ items: [{ menuItemId: 'not-a-uuid', quantity: 1 }] }, 400],
      [{ items: [{ menuItemId: paneer, quantity: 1, note: 'x'.repeat(201) }] }, 400],
      [{ items: [{ menuItemId: paneer, quantity: 1 }], specialInstructions: 'x'.repeat(501) }, 400],
      [{ items: Array.from({ length: 201 }, () => ({ menuItemId: randomUUID(), quantity: 1 })) }, 400],
      [{ items: [{ menuItemId: paneer, quantity: 1 }, { menuItemId: paneer.toUpperCase(), quantity: 1 }] }, 400, 'DUPLICATE_ITEM'],
      [{ items: [{ menuItemId: paneer, quantity: 21 }] }, 422, 'QUANTITY_LIMIT'],
    ];
    const before = await ordersOf(ctx.fixtures.restaurantA);
    for (const [body, status, code] of cases) {
      const res = await place(tokenA, body);
      assert.equal(res.status, status, `${JSON.stringify(body).slice(0, 90)} → ${JSON.stringify(res.body)}`);
      if (code) assert.equal(res.body.error.code, code);
    }
    assert.equal(await ordersOf(ctx.fixtures.restaurantA), before);
  });

  test('the per-order item limit comes from the restaurant settings', async () => {
    await ctx.owner.query('update restaurant_settings set max_items_per_order = 4 where restaurant_id = $1', [ctx.fixtures.restaurantA]);
    try {
      const res = await place(tokenA, { items: [{ menuItemId: paneer, quantity: 3 }, { menuItemId: chai, quantity: 2 }] });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'ORDER_TOO_LARGE');
    } finally {
      await ctx.owner.query('update restaurant_settings set max_items_per_order = 60 where restaurant_id = $1', [ctx.fixtures.restaurantA]);
    }
  });

  test('malformed JSON and oversized bodies get 400 and 413, never 500', async () => {
    const bad = await web(request(ctx.app).post(`/api/v1/public/tables/${tokenA}/orders`))
      .set('idempotency-key', randomUUID()).set('content-type', 'application/json').send('{"items": [');
    assert.equal(bad.status, 400);
    const big = await place(tokenA, { items: [{ menuItemId: paneer, quantity: 1, note: 'x'.repeat(200 * 1024) }] });
    assert.equal(big.status, 413);
  });
});

// ================================================================== revalidation
describe('every item is revalidated on the server (FR-037, BR-ORD-02)', () => {
  const expectUnavailable = async (bad: string, reason: string) => {
    const before = [await ordersOf(ctx.fixtures.restaurantA), await linesOf(ctx.fixtures.restaurantA), await counterOf(ctx.fixtures.restaurantA)];
    const res = await place(tokenA, { items: [{ menuItemId: chai, quantity: 1 }, { menuItemId: bad, quantity: 1 }] });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'ORDER_ITEM_UNAVAILABLE');
    assert.deepEqual(res.body.error.details.map((d: { reason: string }) => d.reason), [reason]);
    // Nothing at all survives: no order, no lines, no number used.
    assert.deepEqual([await ordersOf(ctx.fixtures.restaurantA), await linesOf(ctx.fixtures.restaurantA),
      await counterOf(ctx.fixtures.restaurantA)], before);
    return res;
  };

  test('a sold-out item is refused by name, and the whole order with it', async () => {
    await ctx.owner.query('update menu_items set available = false where id = $1', [paneer]);
    try {
      const res = await expectUnavailable(paneer, 'sold_out');
      assert.match(res.body.error.message, /Paneer Tikka is sold out/);
    } finally {
      await ctx.owner.query('update menu_items set available = true where id = $1', [paneer]);
    }
  });

  test('hidden, archived, in a hidden category, nonexistent and foreign items all look the same', async () => {
    const [cat] = await q<{ id: string }>('select category_id as id from menu_items where id = $1', [paneer]);
    const [hiddenRow] = await q<{ id: string }>(
      `insert into menu_items (restaurant_id, category_id, name, price_minor, visible)
       values ($1, $2, 'Secret hidden dish', 100, false) returning id`, [ctx.fixtures.restaurantA, cat!.id]);
    const [archivedRow] = await q<{ id: string }>(
      `insert into menu_items (restaurant_id, category_id, name, price_minor, archived_at)
       values ($1, $2, 'Secret archived dish', 100, now()) returning id`, [ctx.fixtures.restaurantA, cat!.id]);
    const hidden = hiddenRow!.id;
    const archived = archivedRow!.id;
    const [hiddenCat] = await q<{ id: string }>(
      `insert into menu_categories (restaurant_id, name, visible) values ($1, 'Secret menu', false) returning id`,
      [ctx.fixtures.restaurantA]);
    const [inHiddenCat] = await q<{ id: string }>(
      `insert into menu_items (restaurant_id, category_id, name, price_minor) values ($1, $2, 'Secret dish', 100) returning id`,
      [ctx.fixtures.restaurantA, hiddenCat!.id]);
    const foreign = await itemId(ctx.fixtures.restaurantB, 'Paneer Tikka');

    for (const bad of [hidden, archived, inHiddenCat!.id, randomUUID(), foreign]) {
      const res = await expectUnavailable(bad, 'not_on_menu');
      assert.equal(JSON.stringify(res.body).includes('MARKER-TENANT-B'), false, "never reveals another restaurant's item");
      assert.equal(JSON.stringify(res.body).includes('Secret'), false, 'never reveals a hidden item');
    }
  });

  test('the price charged is the price in the database at that moment', async () => {
    await ctx.owner.query('update menu_items set price_minor = 26500 where id = $1', [paneer]);
    try {
      const res = await place(tokenA, { items: [{ menuItemId: paneer, quantity: 1 }] });
      assert.equal(res.body.order.subtotalMinor, 26500);
    } finally {
      await ctx.owner.query('update menu_items set price_minor = 24900 where id = $1', [paneer]);
    }
  });

  test('a paused restaurant refuses orders', async () => {
    await ctx.owner.query('update restaurants set accepting_orders = false where id = $1', [ctx.fixtures.restaurantA]);
    try {
      const res = await place(tokenA, { items: [{ menuItemId: chai, quantity: 1 }] });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'ORDERING_PAUSED');
    } finally {
      await ctx.owner.query('update restaurants set accepting_orders = true where id = $1', [ctx.fixtures.restaurantA]);
    }
  });

  test('invalid, forged, revoked, inactive-table and suspended-restaurant codes all fail the same way', async () => {
    const [t1] = await q<{ id: string }>(`select id from dining_tables where restaurant_id = $1 and table_number = 'T1'`,
      [ctx.fixtures.restaurantA]);
    // A fresh table and code, so revoking it does not disturb the other tests.
    const [table] = await q<{ id: string }>(
      `insert into dining_tables (restaurant_id, table_number, capacity) values ($1, 'REVOKE-ME', 2) returning id`,
      [ctx.fixtures.restaurantA]);
    const [qr] = await q<{ qr_id: string; key_id: number }>(
      `insert into table_qr_tokens (restaurant_id, table_id, key_id, created_by) values ($1, $2, 2, $3) returning qr_id, key_id`,
      [ctx.fixtures.restaurantA, table!.id, ctx.fixtures.ownerA]);
    const revoked = signQrToken(keyring, qr!.qr_id, qr!.key_id);
    await ctx.owner.query('update table_qr_tokens set revoked_at = now() where table_id = $1', [table!.id]);

    await ctx.owner.query(`update dining_tables set status = 'inactive' where id = $1`, [t1!.id]);
    const inactive = await tokenFor(ctx.fixtures.restaurantA);
    try {
      const before = await count('select count(*) as n from orders');
      const bodies = [
        'not-a-token', Buffer.concat([Buffer.from([2]), randomBytes(32)]).toString('base64url'),
        revoked, inactive, await tokenFor(ctx.fixtures.restaurantS),
      ];
      for (const token of bodies) {
        const res = await place(token, { items: [{ menuItemId: chai, quantity: 1 }] });
        assert.equal(res.status, 404);
        assert.equal(res.body.error.code, 'TABLE_UNAVAILABLE');
      }
      assert.equal(await count('select count(*) as n from orders'), before);
    } finally {
      await ctx.owner.query(`update dining_tables set status = 'active' where id = $1`, [t1!.id]);
    }
  });

  test("restaurant B's code places orders only at B, with B's menu", async () => {
    const tokenB = await tokenFor(ctx.fixtures.restaurantB);
    const fromA = await place(tokenB, { items: [{ menuItemId: chai, quantity: 1 }] });
    assert.equal(fromA.status, 422, "A's item is not on B's menu");
    const bItem = await itemId(ctx.fixtures.restaurantB, 'Masala Chai');
    const ok = await place(tokenB, { items: [{ menuItemId: bItem, quantity: 1 }] });
    assert.equal(ok.status, 201);
    assert.equal((await q<{ restaurant_id: string }>('select restaurant_id from orders where public_token_hash = $1',
      [statusTokenHash(ok.body.statusToken)]))[0]!.restaurant_id, ctx.fixtures.restaurantB);
  });
});

// ==================================================================== idempotency
describe('idempotency (FR-038)', () => {
  const body = () => ({ items: [{ menuItemId: chai, quantity: 2 }] });

  test('repeating a request returns the same order instead of a second one', async () => {
    const key = randomUUID();
    const first = await place(tokenA, body(), key);
    const before = await ordersOf(ctx.fixtures.restaurantA);
    const again = await place(tokenA, body(), key);
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.order.ref, first.body.order.ref);
    assert.equal(again.body.statusToken, first.body.statusToken);
    assert.equal(await ordersOf(ctx.fixtures.restaurantA), before);
  });

  test('the same key with a different cart, or from another table, is refused', async () => {
    const key = randomUUID();
    await place(tokenA, body(), key);
    const changed = await place(tokenA, { items: [{ menuItemId: chai, quantity: 3 }] }, key);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

    const [t2] = await q<{ id: string }>(`select id from dining_tables where restaurant_id = $1 and table_number = 'T2'`,
      [ctx.fixtures.restaurantA]);
    const issued = await web(request(ctx.app).post(`/api/v1/restaurant/tables/${t2!.id}/qr`))
      .set('cookie', await cookie(ctx.fixtures.ownerA)).send({});
    const tokenT2 = issued.body.qr.url.split('/t/')[1];
    assert.equal((await place(tokenT2, body(), key)).status, 409);
  });

  test('a missing or malformed key is refused before anything else', async () => {
    assert.equal((await place(tokenA, body(), null)).body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal((await place(tokenA, body(), 'not-a-uuid')).status, 400);
  });

  test('ten simultaneous identical requests create exactly one order, every time', async () => {
    // Several rounds: which unique index a racing request trips first varies, and
    // both must be answered as a replay, never as an error.
    for (let round = 0; round < 5; round += 1) {
      const key = randomUUID();
      const before = await ordersOf(ctx.fixtures.restaurantA);
      const results = await Promise.all(Array.from({ length: 10 }, () => place(tokenA, body(), key)));
      assert.ok(results.every((res) => res.status === 201 || res.status === 200),
        `round ${round}: ${results.map((r) => r.status).join(',')}`);
      assert.equal(results.filter((res) => res.status === 201).length, 1);
      assert.equal(new Set(results.map((res) => res.body.order.ref)).size, 1);
      assert.equal(new Set(results.map((res) => res.body.statusToken)).size, 1, 'every replay gets the same status link');
      assert.equal(await ordersOf(ctx.fixtures.restaurantA), before + 1);
    }
  });
});

// ======================================================================= numbering
describe('order numbers (FR-040, BR-ORD-05)', () => {
  test('simultaneous orders get distinct, consecutive numbers with no gaps', async () => {
    const start = await counterOf(ctx.fixtures.restaurantA);
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      place(tokenA, { items: [{ menuItemId: chai, quantity: 1 }] })));
    assert.ok(results.every((res) => res.status === 201));
    const numbers = results.map((res) => res.body.order.number as number).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 12 }, (_, i) => start + i));
  });

  test("each restaurant has its own sequence, with the restaurant's prefix", async () => {
    const tokenB = await tokenFor(ctx.fixtures.restaurantB);
    const bItem = await itemId(ctx.fixtures.restaurantB, 'Masala Chai');
    const bStart = await counterOf(ctx.fixtures.restaurantB);
    await ctx.owner.query(`update restaurant_settings set order_prefix = 'TB' where restaurant_id = $1`, [ctx.fixtures.restaurantB]);
    try {
      const res = await place(tokenB, { items: [{ menuItemId: bItem, quantity: 1 }] });
      assert.equal(res.body.order.ref, `TB-${bStart}`);
    } finally {
      await ctx.owner.query(`update restaurant_settings set order_prefix = '' where restaurant_id = $1`, [ctx.fixtures.restaurantB]);
    }
  });
});

// ==================================================================== atomicity
describe('atomicity (FR-039, NFR-D02)', () => {
  test('a database failure part-way through leaves no order, no lines and no used number', async () => {
    // Makes the last step (the contact row) fail, after the order and lines are written.
    await ctx.owner.query(`create or replace function public.test_fail_contact() returns trigger language plpgsql
                           as $$ begin raise exception 'simulated failure'; end $$`);
    await ctx.owner.query('create trigger trg_test_fail before insert on order_customers for each row execute function public.test_fail_contact()');
    const before = [await ordersOf(ctx.fixtures.restaurantA), await linesOf(ctx.fixtures.restaurantA), await counterOf(ctx.fixtures.restaurantA)];
    try {
      const res = await place(tokenA, { items: [{ menuItemId: chai, quantity: 1 }], contact: { mobile: '9876543210' } });
      assert.equal(res.status, 500);
      assert.equal(JSON.stringify(res.body).includes('simulated'), false, 'internals never reach the customer');
    } finally {
      await ctx.owner.query('drop trigger trg_test_fail on order_customers; drop function public.test_fail_contact()');
    }
    assert.deepEqual([await ordersOf(ctx.fixtures.restaurantA), await linesOf(ctx.fixtures.restaurantA),
      await counterOf(ctx.fixtures.restaurantA)], before);
  });

  test('the database refuses an order whose total does not match its lines, or has none', async () => {
    const [t1] = await q<{ id: string }>(`select id from dining_tables where restaurant_id = $1 and table_number = 'T1'`,
      [ctx.fixtures.restaurantA]);
    const attempt = async (withLine: boolean, subtotal: number) => {
      await ctx.owner.query('begin');
      try {
        const [order] = await q<{ id: string }>(
          `insert into orders (restaurant_id, table_id, order_no, order_ref, subtotal_minor, public_token_hash, idempotency_key, request_hash)
           values ($1, $2, 999999, 'X', $3, $4, gen_random_uuid(), $5) returning id`,
          [ctx.fixtures.restaurantA, t1!.id, subtotal, randomBytes(32), randomBytes(32)]);
        if (withLine) {
          await ctx.owner.query(
            `insert into order_items (restaurant_id, order_id, menu_item_id, position, name_snapshot, unit_price_minor, quantity)
             values ($1, $2, $3, 1, 'Chai', 3000, 1)`, [ctx.fixtures.restaurantA, order!.id, chai]);
        }
        await ctx.owner.query('commit');
      } catch (error) {
        await ctx.owner.query('rollback');
        throw error;
      }
    };
    await assert.rejects(() => attempt(true, 1), /subtotal does not match/);
    await assert.rejects(() => attempt(false, 0), /needs at least one item/);
  });

  test("an order line cannot point at another restaurant's item or order", async () => {
    const [orderA] = await q<{ id: string }>('select id from orders where restaurant_id = $1 limit 1', [ctx.fixtures.restaurantA]);
    const foreignItem = await itemId(ctx.fixtures.restaurantB, 'Paneer Tikka');
    await assert.rejects(() => ctx.owner.query(
      `insert into order_items (restaurant_id, order_id, menu_item_id, position, name_snapshot, unit_price_minor, quantity)
       values ($1, $2, $3, 99, 'x', 1, 1)`, [ctx.fixtures.restaurantA, orderA!.id, foreignItem]), /foreign key/);
  });
});

// ===================================================================== contact
describe('contact details (FR-034, NFR-S12)', () => {
  const setPolicy = (policy: string) =>
    ctx.owner.query('update restaurant_settings set contact_policy = $2 where restaurant_id = $1', [ctx.fixtures.restaurantA, policy]);
  const items = () => [{ menuItemId: chai, quantity: 1 }];

  test('optional: valid details are normalised and stored apart from the order', async () => {
    const res = await place(tokenA, { items: items(), contact: { mobile: ' +91 98765-43210 ', email: ' Guest@Example.COM ' } });
    assert.equal(res.status, 201);
    const [row] = await q<{ mobile: string; email: string }>(
      `select c.mobile, c.email from order_customers c join orders o on o.id = c.order_id where o.public_token_hash = $1`,
      [statusTokenHash(res.body.statusToken)]);
    assert.deepEqual([row!.mobile, row!.email], ['+919876543210', 'guest@example.com']);
  });

  test('invalid details are refused with the field named', async () => {
    const res = await place(tokenA, { items: items(), contact: { mobile: '12345', email: 'not-an-email' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error.details.map((d: { field: string }) => d.field).sort(), ['contact.email', 'contact.mobile']);
  });

  test('required and off policies are enforced', async () => {
    try {
      await setPolicy('require_mobile');
      assert.equal((await place(tokenA, { items: items() })).status, 400);
      assert.equal((await place(tokenA, { items: items(), contact: { mobile: '9876543210' } })).status, 201);
      await setPolicy('require_both');
      assert.equal((await place(tokenA, { items: items(), contact: { mobile: '9876543210' } })).status, 400);
      await setPolicy('off');
      const off = await place(tokenA, { items: items(), contact: { email: 'a@b.co' } });
      assert.equal(off.body.error.code, 'CONTACT_NOT_COLLECTED');
      assert.equal((await place(tokenA, { items: items() })).status, 201);
    } finally {
      await setPolicy('optional');
    }
  });

  test('kitchen staff never see contact details; billing staff do', async () => {
    const read = (userId: string) => ctx.db.asStaff({ userId, aal: 'aal1' },
      async (c) => (await c.query('select count(*)::int as n from order_customers')).rows[0].n as number);
    assert.equal(await read(ctx.fixtures.kitchenA), 0);
    assert.ok(await read(ctx.fixtures.billingA) > 0);
  });
});

// ================================================================ status page
describe('the order status page (FR-041, FR-042)', () => {
  let statusToken = '';

  test('shows the order to whoever holds its token, and nothing else', async () => {
    const placed = await place(tokenA, { items: [{ menuItemId: paneer, quantity: 1 }], contact: { mobile: '9876543210' } });
    statusToken = placed.body.statusToken;
    const res = await view(statusToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.order.ref, placed.body.order.ref);
    assert.equal(res.body.order.status, 'pending');
    assert.match(res.body.order.restaurant.name, /MARKER-TENANT-A/);
    const text = JSON.stringify(res.body);
    assert.equal(text.includes('9876543210'), false, 'no contact details');
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), false, 'no internal ids');
  });

  test('keeps the name and price the order was placed with, whatever the menu says now', async () => {
    await ctx.owner.query(`update menu_items set name = 'Renamed Tikka', price_minor = 99900 where id = $1`, [paneer]);
    try {
      const res = await view(statusToken);
      assert.equal(res.body.order.items[0].name, 'MARKER-TENANT-A Paneer Tikka');
      assert.equal(res.body.order.items[0].unitPriceMinor, 24900);
    } finally {
      await ctx.owner.query(`update menu_items set name = 'MARKER-TENANT-A Paneer Tikka', price_minor = 24900 where id = $1`, [paneer]);
    }
  });

  test('unknown and malformed tokens get one answer, after the same minimum time', async () => {
    for (const token of [randomBytes(16).toString('base64url'), 'short', 'x'.repeat(22)]) {
      const started = performance.now();
      const res = await view(token);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'ORDER_NOT_FOUND');
      assert.ok(performance.now() - started >= 245);
    }
  });

  test('a customer role without the token sees no orders at all', async () => {
    const seen = await ctx.db.asPublic(ctx.fixtures.restaurantA, async (c) =>
      (await c.query('select count(*)::int as n from orders')).rows[0].n as number);
    assert.equal(seen, 0);
    const other = await ctx.db.asOrderViewer(randomBytes(32), async (c) =>
      (await c.query('select count(*)::int as n from order_items')).rows[0].n as number);
    assert.equal(other, 0);
  });
});

// ======================================================================= limits
describe('abuse limits (FR-044)', () => {
  test('orders from one table are rate limited', async () => {
    const limited = (await bootLocalApp(ctx.db, ctx.provider, {}, {
      orderLimits: { perIp: HIGH, perTable: { limit: 2, windowSeconds: 600 }, perRestaurant: HIGH },
    })).app;
    const send = () => web(request(limited).post(`/api/v1/public/tables/${tokenA}/orders`))
      .set('idempotency-key', randomUUID()).send({ items: [{ menuItemId: chai, quantity: 1 }] });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 201);
    const third = await send();
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers['retry-after']) > 0);
  });
});

// ==================================================================== isolation
describe('tenant isolation of orders', () => {
  test("staff see only their own restaurant's orders", async () => {
    const markers = async (userId: string) => ctx.db.asStaff({ userId, aal: 'aal1' }, async (c) =>
      (await c.query<{ m: string }>(`select string_agg(distinct coalesce(special_instructions, ''), ' ') as m from orders`)).rows[0]!.m ?? '');
    const seenByA = await markers(ctx.fixtures.ownerA);
    assert.ok(seenByA.includes('MARKER-TENANT-A'));
    assert.equal(seenByA.includes('MARKER-TENANT-B'), false);
    assert.equal((await markers(ctx.fixtures.ownerB)).includes('MARKER-TENANT-A'), false);
  });

  test('no staff role can change or delete an order yet', async () => {
    for (const statement of ['update orders set subtotal_minor = 1', 'delete from orders', 'update order_items set quantity = 9']) {
      await assert.rejects(() => ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' }, (c) => c.query(statement)),
        /permission denied/, statement);
    }
  });
});
