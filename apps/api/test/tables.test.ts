import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import {
  auditActions, capturedLogs, createTestContext, signToken, TEST_QR_KEYS, type TestContext,
} from './helpers.ts';
import { parseKeyring, signQrToken, verifyQrToken } from '../src/lib/qr-token.ts';

let ctx: TestContext;
const keyring = parseKeyring(TEST_QR_KEYS);

let ipCounter = 0;
const nextIp = () => `203.0.116.${(ipCounter += 1) % 250 + 1}`;
const asWeb = (req: request.Test, ip = nextIp()) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', ip);

before(async () => { ctx = await createTestContext(); });
after(async () => { await ctx.close(); });

const as = (userId: string) => signToken({ sub: userId });
const cookie = async (userId: string) => `df_at=${await as(userId)}`;

const get = async (userId: string, path: string) =>
  request(ctx.app).get(`/api/v1/restaurant/tables${path}`).set('cookie', await cookie(userId));
const post = async (userId: string, path: string, body?: Record<string, unknown>) =>
  asWeb(request(ctx.app).post(`/api/v1/restaurant/tables${path}`)).set('cookie', await cookie(userId)).send(body ?? {});
const patch = async (userId: string, path: string, body: Record<string, unknown>) =>
  asWeb(request(ctx.app).patch(`/api/v1/restaurant/tables${path}`)).set('cookie', await cookie(userId)).send(body);
const publicEntry = (token: string, ip = nextIp()) =>
  request(ctx.app).get(`/api/v1/public/tables/${token}`).set('x-forwarded-for', ip);

const tokenFromUrl = (url: string) => url.split('/t/')[1] ?? '';

/** A table in restaurant B, for cross-tenant probes. */
const tableOfB = async () =>
  (await ctx.owner.query<{ id: string }>(`select id from dining_tables where restaurant_id = $1 limit 1`,
    [ctx.fixtures.restaurantB])).rows[0]!.id;

/** Signs a token for a fixture QR the way a real printout would carry it. */
const fixtureToken = async (restaurantId: string) => {
  const { rows } = await ctx.owner.query<{ qr_id: string; key_id: number }>(
    `select qr_id, key_id from table_qr_tokens where restaurant_id = $1 and revoked_at is null limit 1`,
    [restaurantId]);
  return signQrToken(keyring, rows[0]!.qr_id, rows[0]!.key_id);
};

describe('managing tables', () => {
  test('an owner creates a table', async () => {
    const res = await post(ctx.fixtures.ownerA, '', { tableNumber: 'W4', name: 'Window', capacity: 4 });
    assert.equal(res.status, 201);
    assert.equal(res.body.table.tableNumber, 'W4');
    assert.equal(res.body.table.status, 'active');
    assert.equal(res.body.table.qr, null, 'a new table has no QR until one is generated');
  });

  test('a manager creates a table', async () => {
    const res = await post(ctx.fixtures.managerA, '', { tableNumber: 'M1', capacity: 2 });
    assert.equal(res.status, 201);
  });

  test('kitchen and billing staff can read tables but not change them', async () => {
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      const list = await get(userId, '');
      assert.equal(list.status, 200);
      assert.ok(list.body.tables.length > 0);
      // They cannot see QR records, so they are not told whether one exists.
      assert.equal('qr' in list.body.tables[0], false);

      const create = await post(userId, '', { tableNumber: 'NOPE', capacity: 2 });
      assert.equal(create.status, 403);
    }
  });

  test('surrounding whitespace is trimmed', async () => {
    const res = await post(ctx.fixtures.ownerA, '', { tableNumber: '  P7  ', capacity: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.table.tableNumber, 'P7');
  });

  test('a duplicate table number is refused, regardless of case', async () => {
    const res = await post(ctx.fixtures.ownerA, '', { tableNumber: 'w4', capacity: 2 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TABLE_NUMBER_TAKEN');
  });

  test('two restaurants may use the same table number', async () => {
    const a = await post(ctx.fixtures.ownerA, '', { tableNumber: 'SHARED-1', capacity: 2 });
    const b = await post(ctx.fixtures.ownerB, '', { tableNumber: 'SHARED-1', capacity: 2 });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  test('invalid values are rejected', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['zero capacity', { tableNumber: 'V1', capacity: 0 }],
      ['negative capacity', { tableNumber: 'V2', capacity: -1 }],
      ['fractional capacity', { tableNumber: 'V3', capacity: 1.5 }],
      ['excessive capacity', { tableNumber: 'V4', capacity: 101 }],
      ['capacity as text', { tableNumber: 'V5', capacity: '4' }],
      ['empty number', { tableNumber: '', capacity: 2 }],
      ['whitespace-only number', { tableNumber: '   ', capacity: 2 }],
      ['number too long', { tableNumber: 'X'.repeat(21), capacity: 2 }],
      ['name too long', { tableNumber: 'V6', name: 'n'.repeat(61), capacity: 2 }],
    ];
    for (const [label, body] of cases) {
      const res = await post(ctx.fixtures.ownerA, '', body);
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, 'VALIDATION_FAILED', label);
    }
  });

  test('a restaurant id in the request is refused, not obeyed', async () => {
    const res = await post(ctx.fixtures.ownerA, '', {
      tableNumber: 'SNEAK', capacity: 2, restaurantId: ctx.fixtures.restaurantB,
    });
    assert.equal(res.status, 400);
    const { rows } = await ctx.owner.query(`select 1 from dining_tables where table_number = 'SNEAK'`);
    assert.equal(rows.length, 0);
  });

  test('an edit changes only what it names, and never reactivates a table', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'E1', name: 'Corner', capacity: 2 });
    const id = created.body.table.id;
    const off = await patch(ctx.fixtures.ownerA, `/${id}/status`, { status: 'inactive', version: created.body.table.version });

    const res = await patch(ctx.fixtures.ownerA, `/${id}`, { capacity: 6, version: off.body.table.version });
    assert.equal(res.status, 200);
    assert.equal(res.body.table.capacity, 6);
    assert.equal(res.body.table.name, 'Corner');
    assert.equal(res.body.table.status, 'inactive');

    const sneaky = await patch(ctx.fixtures.ownerA, `/${id}`, { status: 'active', version: res.body.table.version });
    assert.equal(sneaky.status, 400, 'status may only change through the status endpoint');
  });

  test('a stale version is refused', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'E2', capacity: 2 });
    const res = await patch(ctx.fixtures.ownerA, `/${created.body.table.id}`, { capacity: 3, version: 99 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STALE_VERSION');
  });

  test('a missing or malformed table id returns not found', async () => {
    assert.equal((await get(ctx.fixtures.ownerA, '/00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await get(ctx.fixtures.ownerA, '/not-a-uuid')).status, 404);
  });

  test('search is literal and filters work', async () => {
    const found = await get(ctx.fixtures.ownerA, '?search=W4');
    assert.ok(found.body.tables.some((t: { tableNumber: string }) => t.tableNumber === 'W4'));

    // A user typing "%" searches for a percent sign, not for everything.
    const wildcard = await get(ctx.fixtures.ownerA, '?search=%25');
    assert.equal(wildcard.status, 200);
    assert.equal(wildcard.body.tables.length, 0);

    const inactive = await get(ctx.fixtures.ownerA, '?status=inactive');
    assert.ok(inactive.body.tables.every((t: { status: string }) => t.status === 'inactive'));

    const junk = await get(ctx.fixtures.ownerA, '?status=deleted');
    assert.equal(junk.status, 400);
  });

  test('table changes are audited, with the reason for a status change', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'AUD1', capacity: 2 });
    await patch(ctx.fixtures.ownerA, `/${created.body.table.id}/status`,
      { status: 'inactive', reason: 'Broken leg on the table', version: created.body.table.version });

    const { rows } = await ctx.owner.query<{ action: string; summary: { reason?: string } }>(
      `select action, summary from audit_log where entity_id = $1 order by id`, [created.body.table.id]);
    assert.deepEqual(rows.map((r) => r.action), ['table.created', 'table.deactivated']);
    assert.equal(rows[1]?.summary.reason, 'Broken leg on the table');
  });
});

describe('tenant isolation', () => {
  test("another restaurant's table is invisible and unchangeable", async () => {
    const id = await tableOfB();
    assert.equal((await get(ctx.fixtures.ownerA, `/${id}`)).status, 404);
    assert.equal((await patch(ctx.fixtures.ownerA, `/${id}`, { capacity: 99, version: 1 })).status, 404);
    assert.equal((await patch(ctx.fixtures.ownerA, `/${id}/status`, { status: 'inactive', version: 1 })).status, 404);

    const { rows } = await ctx.owner.query('select capacity, status from dining_tables where id = $1', [id]);
    assert.notEqual(rows[0]?.capacity, 99);
    assert.equal(rows[0]?.status, 'active');
  });

  test("another restaurant's QR cannot be read, issued, rotated or revoked", async () => {
    const id = await tableOfB();
    const before = await ctx.owner.query(`select qr_id from table_qr_tokens where table_id = $1 and revoked_at is null`, [id]);

    assert.equal((await get(ctx.fixtures.ownerA, `/${id}/qr`)).status, 404);
    assert.equal((await post(ctx.fixtures.ownerA, `/${id}/qr`)).status, 404);
    assert.equal((await post(ctx.fixtures.ownerA, `/${id}/qr/regenerate`)).status, 404);
    assert.equal((await post(ctx.fixtures.ownerA, `/${id}/qr/revoke`)).status, 404);

    const afterRows = await ctx.owner.query(`select qr_id from table_qr_tokens where table_id = $1 and revoked_at is null`, [id]);
    assert.deepEqual(afterRows.rows, before.rows, "restaurant B's QR must be untouched");
  });

  test("the list never includes another restaurant's tables", async () => {
    const res = await get(ctx.fixtures.ownerA, '');
    const body = JSON.stringify(res.body);
    assert.equal(body.includes('MARKER-TENANT-B'), false);
    assert.equal(body.includes(await tableOfB()), false);
  });

  test('without a session, table management is closed', async () => {
    const res = await request(ctx.app).get('/api/v1/restaurant/tables');
    assert.equal(res.status, 401);
  });
});

describe('QR lifecycle', () => {
  let tableId = '';
  let firstToken = '';

  test('generating a QR issues one and returns a printable code', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'Q1', capacity: 4 });
    tableId = created.body.table.id;

    const res = await post(ctx.fixtures.ownerA, `/${tableId}/qr`);
    assert.equal(res.status, 201);
    assert.equal(res.body.created, true);
    assert.match(res.body.qr.url, /^http:\/\/localhost:5173\/t\/[A-Za-z0-9_-]{44}$/);
    assert.match(res.body.qr.svg, /^<svg/);
    assert.equal(res.body.qr.provisional, true, 'the domain is not final, so the card is provisional');
    firstToken = tokenFromUrl(res.body.qr.url);
  });

  test('asking again returns the same QR, so a lost card can be reprinted', async () => {
    const again = await post(ctx.fixtures.ownerA, `/${tableId}/qr`);
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(tokenFromUrl(again.body.qr.url), firstToken);

    const viewed = await get(ctx.fixtures.ownerA, `/${tableId}/qr`);
    assert.equal(tokenFromUrl(viewed.body.qr.url), firstToken);
  });

  test('a customer scanning it sees the restaurant and table, and nothing else', async () => {
    const res = await publicEntry(firstToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.table.tableNumber, 'Q1');
    assert.match(res.body.restaurant.name, /MARKER-TENANT-A/);

    const body = JSON.stringify(res.body);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(body), false,
      'no internal id may reach the public');
    for (const secret of ['qr_id', 'token', 'key_id', 'restaurant_id']) {
      assert.equal(body.includes(secret), false, `public response leaks ${secret}`);
    }
  });

  test('the token does not contain the table id', async () => {
    const decoded = verifyQrToken(keyring, firstToken);
    assert.ok(decoded);
    assert.notEqual(decoded.qrId, tableId);
  });

  test('regenerating replaces the code: the old one stops working at once', async () => {
    const res = await post(ctx.fixtures.ownerA, `/${tableId}/qr/regenerate`);
    assert.equal(res.status, 201);
    const next = tokenFromUrl(res.body.qr.url);
    assert.notEqual(next, firstToken);

    assert.equal((await publicEntry(firstToken)).status, 404);
    assert.equal((await publicEntry(next)).status, 200);
    firstToken = next;
  });

  test('deactivating the table stops its QR; reactivating brings the same card back', async () => {
    const current = await get(ctx.fixtures.ownerA, `/${tableId}`);
    const off = await patch(ctx.fixtures.ownerA, `/${tableId}/status`,
      { status: 'inactive', version: current.body.table.version });
    assert.equal((await publicEntry(firstToken)).status, 404, 'an inactive table cannot be entered');

    await patch(ctx.fixtures.ownerA, `/${tableId}/status`, { status: 'active', version: off.body.table.version });
    assert.equal((await publicEntry(firstToken)).status, 200, 'the printed card works again');
  });

  test('revoking kills the code, and repeating it is harmless', async () => {
    const first = await post(ctx.fixtures.ownerA, `/${tableId}/qr/revoke`);
    assert.equal(first.status, 200);
    assert.equal(first.body.revoked, true);
    assert.equal((await publicEntry(firstToken)).status, 404);

    const second = await post(ctx.fixtures.ownerA, `/${tableId}/qr/revoke`);
    assert.equal(second.status, 200);
    assert.equal(second.body.revoked, false, 'nothing left to revoke');

    assert.equal((await get(ctx.fixtures.ownerA, `/${tableId}/qr`)).status, 404);
  });

  test('kitchen and billing staff cannot see or change QR codes', async () => {
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      assert.equal((await get(userId, `/${tableId}/qr`)).status, 403);
      assert.equal((await post(userId, `/${tableId}/qr`)).status, 403);
      assert.equal((await post(userId, `/${tableId}/qr/revoke`)).status, 403);
    }
  });

  test('QR actions are audited', async () => {
    const actions = await ctx.owner.query<{ action: string }>(
      `select action from audit_log where entity_id = $1 and action like 'table.qr.%' order by id`, [tableId]);
    assert.deepEqual(actions.rows.map((r) => r.action),
      ['table.qr.issued', 'table.qr.regenerated', 'table.qr.revoked']);
  });
});

describe('public QR resolution', () => {
  test('every kind of unavailable table gets the same answer', async () => {
    const forged = Buffer.concat([Buffer.from([2]), randomBytes(32)]).toString('base64url');
    const suspended = await fixtureToken(ctx.fixtures.restaurantS);
    const provisioning = await fixtureToken(ctx.fixtures.restaurantP);

    const responses = await Promise.all([
      publicEntry('not-a-token'), publicEntry(forged), publicEntry(suspended), publicEntry(provisioning),
    ]);
    for (const res of responses) {
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'TABLE_UNAVAILABLE');
    }
    const messages = new Set(responses.map((res) => res.body.error.message));
    assert.equal(messages.size, 1, 'the reason a table is unavailable must not be distinguishable');
  });

  test('a live table in a live restaurant resolves', async () => {
    const res = await publicEntry(await fixtureToken(ctx.fixtures.restaurantA));
    assert.equal(res.status, 200);
  });

  test('a forged token is rejected before the database is asked', async () => {
    const original = ctx.db.resolveTableQr.bind(ctx.db);
    let lookups = 0;
    ctx.db.resolveTableQr = async (qrId: string) => { lookups += 1; return original(qrId); };
    try {
      for (let i = 0; i < 5; i += 1) {
        const forged = Buffer.concat([Buffer.from([2]), randomBytes(32)]).toString('base64url');
        await publicEntry(forged);
      }
      assert.equal(lookups, 0);
    } finally {
      ctx.db.resolveTableQr = original;
    }
  });

  test('a token only works with the key it was issued under', async () => {
    // Issued under key 2 (the current key). Re-signing the same qr_id with key 1 —
    // which is still valid, for older cards — must not produce a working token.
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'KEY1', capacity: 2 });
    const issued = await post(ctx.fixtures.ownerA, `/${created.body.table.id}/qr`);
    const decoded = verifyQrToken(keyring, tokenFromUrl(issued.body.qr.url))!;
    assert.equal(decoded.kid, 2);

    const crossSigned = signQrToken(keyring, decoded.qrId, 1);
    assert.equal((await publicEntry(crossSigned)).status, 404);
    assert.equal((await publicEntry(tokenFromUrl(issued.body.qr.url))).status, 200);
  });

  test('scanning needs no login and sets no session', async () => {
    const res = await publicEntry(await fixtureToken(ctx.fixtures.restaurantA));
    assert.equal(res.status, 200);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('public entry is rate limited', async () => {
    // Sent together: each rejection waits out the timing floor, and the limiter
    // counts requests as they arrive, not as they finish.
    const ip = '198.51.100.200';
    const responses = await Promise.all(Array.from({ length: 125 }, () => publicEntry('x'.repeat(44), ip)));
    assert.ok(responses.some((res) => res.status === 429));
  });

  test('tokens never reach the logs, even when the request fails', async () => {
    const token = await fixtureToken(ctx.fixtures.restaurantA);
    const original = ctx.db.resolveTableQr.bind(ctx.db);
    capturedLogs.length = 0;
    ctx.db.resolveTableQr = async () => { throw new Error('simulated database failure'); };
    try {
      const res = await publicEntry(token);
      assert.equal(res.status, 500);
    } finally {
      ctx.db.resolveTableQr = original;
    }
    assert.ok(capturedLogs.length > 0, 'the failure should have been logged');
    assert.equal(JSON.stringify(capturedLogs).includes(token), false,
      'the log must record the route pattern, not the token in the path');
  });

  test('no audit record holds a token or a qr_id', async () => {
    const { rows } = await ctx.owner.query<{ summary: unknown }>(
      `select summary from audit_log where action like 'table.%'`);
    const qrIds = (await ctx.owner.query<{ qr_id: string }>('select qr_id from table_qr_tokens')).rows.map((r) => r.qr_id);
    const text = JSON.stringify(rows);
    for (const qrId of qrIds) assert.equal(text.includes(qrId), false);
    assert.equal(/[A-Za-z0-9_-]{44}/.test(text), false);
  });
});

describe('concurrency', () => {
  test('simultaneous creation of the same number yields exactly one table', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      post(ctx.fixtures.ownerA, '', { tableNumber: 'RACE-1', capacity: 2 })));
    const statuses = results.map((res) => res.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 9);

    const { rows } = await ctx.owner.query(`select count(*)::int as n from dining_tables where lower(table_number) = 'race-1'`);
    assert.equal(rows[0]?.n, 1);
  });

  test('simultaneous regenerations leave exactly one live QR', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'RACE-2', capacity: 2 });
    const id = created.body.table.id;
    await post(ctx.fixtures.ownerA, `/${id}/qr`);

    const results = await Promise.all(Array.from({ length: 8 }, () => post(ctx.fixtures.ownerA, `/${id}/qr/regenerate`)));
    assert.ok(results.every((res) => res.status === 201), 'regenerations serialise rather than fail');

    const { rows } = await ctx.owner.query(
      `select count(*)::int as n from table_qr_tokens where table_id = $1 and revoked_at is null`, [id]);
    assert.equal(rows[0]?.n, 1);
  });

  test('simultaneous revocations report exactly one change', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'RACE-3', capacity: 2 });
    const id = created.body.table.id;
    await post(ctx.fixtures.ownerA, `/${id}/qr`);

    const results = await Promise.all(Array.from({ length: 6 }, () => post(ctx.fixtures.ownerA, `/${id}/qr/revoke`)));
    assert.equal(results.filter((res) => res.body.revoked === true).length, 1);
  });
});

describe('database invariants', () => {
  const tableOfA = async () =>
    (await ctx.owner.query<{ id: string }>(`select id from dining_tables where restaurant_id = $1 limit 1`,
      [ctx.fixtures.restaurantA])).rows[0]!.id;

  test('capacity and table-number rules hold without the API', async () => {
    const insert = (number: string, capacity: number) => ctx.owner.query(
      `insert into dining_tables (restaurant_id, table_number, capacity) values ($1, $2, $3)`,
      [ctx.fixtures.restaurantA, number, capacity]);
    await assert.rejects(() => insert('DB1', 0), /check/);
    await assert.rejects(() => insert('DB2', 101), /check/);
    await assert.rejects(() => insert(' DB3 ', 2), /check/, 'untrimmed numbers are refused');
    await assert.rejects(() => insert('w4', 2), /duplicate key/, 'uniqueness is case-insensitive');
  });

  test("a QR record cannot point at another restaurant's table", async () => {
    // Even the migration owner, who bypasses RLS, cannot: the composite foreign key
    // makes a cross-tenant pairing unrepresentable. Aimed at a table of B with no
    // live QR, so the one-live-QR index cannot be what refuses it.
    const idOfB = (await ctx.owner.query<{ id: string }>(
      `select t.id from dining_tables t where t.restaurant_id = $1
          and not exists (select 1 from table_qr_tokens q where q.table_id = t.id and q.revoked_at is null)
        limit 1`, [ctx.fixtures.restaurantB])).rows[0]!.id;
    await assert.rejects(
      () => ctx.owner.query(
        `insert into table_qr_tokens (restaurant_id, table_id, key_id) values ($1, $2, 1)`,
        [ctx.fixtures.restaurantA, idOfB]),
      /foreign key/,
    );
  });

  test('a table cannot have two live QR codes', async () => {
    const id = await tableOfA();
    await ctx.owner.query(`update table_qr_tokens set revoked_at = now() where table_id = $1 and revoked_at is null`, [id]);
    await ctx.owner.query(`insert into table_qr_tokens (restaurant_id, table_id, key_id) values ($1, $2, 1)`,
      [ctx.fixtures.restaurantA, id]);
    await assert.rejects(
      () => ctx.owner.query(`insert into table_qr_tokens (restaurant_id, table_id, key_id) values ($1, $2, 1)`,
        [ctx.fixtures.restaurantA, id]),
      /duplicate key/,
    );
  });

  test('a table cannot move to another restaurant, and a QR cannot be re-aimed or reinstated', async () => {
    const id = await tableOfA();
    await assert.rejects(
      () => ctx.owner.query('update dining_tables set restaurant_id = $1 where id = $2', [ctx.fixtures.restaurantB, id]),
      /cannot move between restaurants/,
    );
    const { rows } = await ctx.owner.query<{ id: string }>(
      `select id from table_qr_tokens where revoked_at is not null limit 1`);
    await assert.rejects(
      () => ctx.owner.query('update table_qr_tokens set revoked_at = null where id = $1', [rows[0]!.id]),
      /cannot be reinstated/,
    );
    await assert.rejects(
      () => ctx.owner.query('update table_qr_tokens set table_id = $1 where id = $2', [id, rows[0]!.id]),
      /only be revoked/,
    );
  });

  test('no staff role can delete a table or a QR record', async () => {
    for (const statement of ['delete from dining_tables', 'delete from table_qr_tokens']) {
      await assert.rejects(
        () => ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' }, (client) => client.query(statement)),
        /permission denied/,
        statement,
      );
    }
  });
});

void auditActions;
