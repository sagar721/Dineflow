// Tables & QR completion: notes (FR-011), bulk creation (FR-018), generating missing
// codes, the A4 sheet and PNG download (FR-015), 128-bit qr_ids (NFR-S13) and equal
// timing for every unavailable code (US-03). Each feature is also probed across
// tenants: restaurant A must never reach, change or even count restaurant B's data.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { auditActions, createTestContext, signToken, TEST_QR_KEYS, type TestContext } from './helpers.ts';
import { parseKeyring, signQrToken } from '../src/lib/qr-token.ts';
import { UNAVAILABLE_FLOOR_MS } from '../src/modules/public/routes.ts';

let ctx: TestContext;
const keyring = parseKeyring(TEST_QR_KEYS);

let ipCounter = 0;
const nextIp = () => `203.0.117.${(ipCounter += 1) % 250 + 1}`;
const asWeb = (req: request.Test, ip = nextIp()) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', ip);

before(async () => { ctx = await createTestContext(); });
after(async () => { await ctx.close(); });

const cookie = async (userId: string) => `df_at=${await signToken({ sub: userId })}`;
const get = async (userId: string, path: string) =>
  request(ctx.app).get(`/api/v1/restaurant/tables${path}`).set('cookie', await cookie(userId));
const post = async (userId: string, path: string, body?: Record<string, unknown>) =>
  asWeb(request(ctx.app).post(`/api/v1/restaurant/tables${path}`)).set('cookie', await cookie(userId)).send(body ?? {});
const patch = async (userId: string, path: string, body: Record<string, unknown>) =>
  asWeb(request(ctx.app).patch(`/api/v1/restaurant/tables${path}`)).set('cookie', await cookie(userId)).send(body);
const publicEntry = (token: string) =>
  request(ctx.app).get(`/api/v1/public/tables/${token}`).set('x-forwarded-for', nextIp());
const tokenFromUrl = (url: string) => url.split('/t/')[1] ?? '';

const count = async (sql: string, params: unknown[] = []) =>
  (await ctx.owner.query<{ n: number }>(sql, params)).rows[0]!.n;
const tablesOf = (restaurantId: string) =>
  count('select count(*)::int as n from dining_tables where restaurant_id = $1', [restaurantId]);
const liveCodesOf = (restaurantId: string) =>
  count('select count(*)::int as n from table_qr_tokens where restaurant_id = $1 and revoked_at is null', [restaurantId]);
const aTableOfB = async () => (await ctx.owner.query<{ id: string; table_number: string }>(
  'select id, table_number from dining_tables where restaurant_id = $1 order by created_at limit 1',
  [ctx.fixtures.restaurantB])).rows[0]!;

describe('notes (FR-011)', () => {
  let id = '';

  test('a table can be created with notes, trimmed', async () => {
    const res = await post(ctx.fixtures.ownerA, '', { tableNumber: 'N1', capacity: 2, notes: '  Wobbly leg  ' });
    assert.equal(res.status, 201);
    assert.equal(res.body.table.notes, 'Wobbly leg');
    id = res.body.table.id;
  });

  test('notes can be edited and cleared, and nothing else changes', async () => {
    const edited = await patch(ctx.fixtures.managerA, `/${id}`, { notes: 'Near the kitchen door', version: 1 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.table.notes, 'Near the kitchen door');
    assert.equal(edited.body.table.tableNumber, 'N1');

    const cleared = await patch(ctx.fixtures.managerA, `/${id}`, { notes: null, version: 2 });
    assert.equal(cleared.body.table.notes, null);

    const untouched = await patch(ctx.fixtures.managerA, `/${id}`, { capacity: 3, version: 3 });
    assert.equal(untouched.body.table.notes, null, 'an edit that does not name notes leaves them alone');
  });

  test('over-long notes are refused', async () => {
    const res = await post(ctx.fixtures.ownerA, '', { tableNumber: 'N2', capacity: 2, notes: 'x'.repeat(501) });
    assert.equal(res.status, 400);
  });

  test('kitchen staff can read notes but not change them', async () => {
    await patch(ctx.fixtures.ownerA, `/${id}`, { notes: 'Staff only', version: 4 });
    const read = await get(ctx.fixtures.kitchenA, `/${id}`);
    assert.equal(read.body.table.notes, 'Staff only');
    const write = await patch(ctx.fixtures.kitchenA, `/${id}`, { notes: 'Changed', version: 5 });
    assert.equal(write.status, 403);
  });

  test('customers never see notes', async () => {
    const issued = await post(ctx.fixtures.ownerA, `/${id}/qr`);
    const scanned = await publicEntry(tokenFromUrl(issued.body.qr.url));
    assert.equal(scanned.status, 200);
    assert.equal(JSON.stringify(scanned.body).includes('Staff only'), false);
  });

  test("another restaurant's notes cannot be changed, through the API or the database", async () => {
    const b = await aTableOfB();
    const res = await patch(ctx.fixtures.ownerA, `/${b.id}`, { notes: 'Hijacked', version: 1 });
    assert.equal(res.status, 404);

    const direct = await ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' },
      (client) => client.query(`update dining_tables set notes = 'Hijacked' where id = $1`, [b.id]));
    assert.equal(direct.rowCount, 0, 'RLS hides the row, so there is nothing to update');
    assert.equal(await count(`select count(*)::int as n from dining_tables where notes = 'Hijacked'`), 0);
  });

  test('the database enforces the notes rules without the API', async () => {
    for (const notes of [' padded ', '', 'x'.repeat(501)]) {
      await assert.rejects(() => ctx.owner.query(
        `insert into dining_tables (restaurant_id, table_number, capacity, notes) values ($1, $2, 2, $3)`,
        [ctx.fixtures.restaurantA, `NDB-${notes.length}`, notes]), /notes_check/);
    }
  });
});

describe('bulk creation (FR-018)', () => {
  test('an owner creates a numbered range in one step, each table audited', async () => {
    const res = await post(ctx.fixtures.ownerA, '/bulk', { prefix: 'B', from: 1, to: 5, capacity: 4 });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.tables.map((t: { tableNumber: string }) => t.tableNumber), ['B1', 'B2', 'B3', 'B4', 'B5']);
    assert.ok(res.body.tables.every((t: { capacity: number; status: string }) => t.capacity === 4 && t.status === 'active'));

    const audited = await count(
      `select count(*)::int as n from audit_log where action = 'table.created' and (summary->>'bulk')::boolean
         and restaurant_id = $1`, [ctx.fixtures.restaurantA]);
    assert.equal(audited, 5);
  });

  test('a manager may bulk-create; kitchen and billing may not', async () => {
    assert.equal((await post(ctx.fixtures.managerA, '/bulk', { prefix: 'MB', from: 1, to: 2, capacity: 2 })).status, 201);
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      assert.equal((await post(userId, '/bulk', { prefix: 'KB', from: 1, to: 2, capacity: 2 })).status, 403);
    }
  });

  test('any clash, in any case, refuses the whole range and names the clashes', async () => {
    await post(ctx.fixtures.ownerA, '', { tableNumber: 'cl3', capacity: 2 });
    const before = await tablesOf(ctx.fixtures.restaurantA);

    const res = await post(ctx.fixtures.ownerA, '/bulk', { prefix: 'CL', from: 1, to: 5, capacity: 2 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TABLE_NUMBER_TAKEN');
    assert.deepEqual(res.body.error.details.map((d: { message: string }) => d.message), ['cl3']);
    assert.equal(await tablesOf(ctx.fixtures.restaurantA), before, 'nothing from the range was created');
  });

  test('invalid ranges are refused', async () => {
    for (const body of [
      { prefix: 'X', from: 5, to: 1, capacity: 2 },           // backwards
      { prefix: 'X', from: 1, to: 101, capacity: 2 },         // over the cap
      { prefix: 'X', from: 1.5, to: 3, capacity: 2 },         // not whole
      { prefix: 'X'.repeat(11), from: 1, to: 2, capacity: 2 }, // prefix too long
      { prefix: 'X', from: 1, to: 2, capacity: 0 },           // no seats
    ]) {
      assert.equal((await post(ctx.fixtures.ownerA, '/bulk', body)).status, 400, JSON.stringify(body));
    }
  });

  test('a restaurant id in the request is refused, not obeyed', async () => {
    const res = await post(ctx.fixtures.ownerA, '/bulk',
      { prefix: 'R', from: 1, to: 2, capacity: 2, restaurantId: ctx.fixtures.restaurantB });
    assert.equal(res.status, 400);
  });

  test("numbers used only by another restaurant are free here, and that restaurant is untouched", async () => {
    // A number that exists in B and nowhere in A: B's use of it must neither block
    // A nor be revealed to A as a clash.
    await ctx.owner.query(
      `insert into dining_tables (restaurant_id, table_number, capacity) values ($1, 'BONLY7', 2)`,
      [ctx.fixtures.restaurantB]);
    const bBefore = await tablesOf(ctx.fixtures.restaurantB);
    const res = await post(ctx.fixtures.ownerA, '/bulk', { prefix: 'BONLY', from: 6, to: 8, capacity: 2 });
    assert.equal(res.status, 201);
    assert.equal(await tablesOf(ctx.fixtures.restaurantB), bBefore);
  });

  test('without a session, bulk creation is closed', async () => {
    const res = await asWeb(request(ctx.app).post('/api/v1/restaurant/tables/bulk'))
      .send({ prefix: 'Z', from: 1, to: 2, capacity: 2 });
    assert.equal(res.status, 401);
  });
});

describe('generating missing QR codes', () => {
  test('issues a code for every active table without one, and none for inactive tables', async () => {
    const made = await post(ctx.fixtures.ownerA, '/bulk', { prefix: 'GM', from: 1, to: 3, capacity: 2 });
    const [gm1, , gm3] = made.body.tables as { id: string; version: number }[];
    await patch(ctx.fixtures.ownerA, `/${gm3!.id}/status`, { status: 'inactive', version: gm3!.version });
    const existing = await post(ctx.fixtures.ownerA, `/${gm1!.id}/qr`);
    const bLive = await liveCodesOf(ctx.fixtures.restaurantB);

    const res = await post(ctx.fixtures.ownerA, '/qr/issue-missing');
    assert.equal(res.status, 200);
    assert.ok(res.body.issued >= 1);

    const withoutCode = await count(
      `select count(*)::int as n from dining_tables t where t.restaurant_id = $1 and t.status = 'active'
         and not exists (select 1 from table_qr_tokens q where q.table_id = t.id and q.revoked_at is null)`,
      [ctx.fixtures.restaurantA]);
    assert.equal(withoutCode, 0, 'every active table in A now has a code');
    assert.equal(await count(
      'select count(*)::int as n from table_qr_tokens where table_id = $1', [gm3!.id]), 0, 'inactive table skipped');

    const after = await get(ctx.fixtures.ownerA, `/${gm1!.id}/qr`);
    assert.equal(after.body.qr.url, existing.body.qr.url, 'an existing code is never replaced');
    assert.equal(await liveCodesOf(ctx.fixtures.restaurantB), bLive, "restaurant B's codes are untouched");
  });

  test('running it again issues nothing', async () => {
    const res = await post(ctx.fixtures.ownerA, '/qr/issue-missing');
    assert.equal(res.body.issued, 0);
  });

  test('only roles that may rotate codes can run it', async () => {
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      assert.equal((await post(userId, '/qr/issue-missing')).status, 403);
    }
  });
});

describe('the A4 QR sheet (FR-015)', () => {
  test('lists every active table with a code, each one working, and nothing else', async () => {
    const res = await get(ctx.fixtures.managerA, '/qr-sheet');
    assert.equal(res.status, 200);
    assert.match(res.body.restaurantName, /MARKER-TENANT-A/);
    assert.equal(res.body.provisional, true);
    assert.equal(res.body.activeTablesWithoutQr, 0);

    const numbers = res.body.cards.map((c: { tableNumber: string }) => c.tableNumber);
    assert.ok(numbers.includes('GM1') && numbers.includes('GM2'));
    assert.equal(numbers.includes('GM3'), false, 'an inactive table is not on the sheet');
    for (const card of res.body.cards.slice(0, 3)) {
      assert.match(card.svg, /^<svg/);
      const scanned = await publicEntry(tokenFromUrl(card.url));
      assert.equal(scanned.status, 200);
      assert.equal(scanned.body.table.tableNumber, card.tableNumber);
    }
  });

  test("contains nothing of another restaurant and no stored identifiers", async () => {
    const res = await get(ctx.fixtures.ownerA, '/qr-sheet');
    const text = JSON.stringify(res.body);
    assert.equal(text.includes('MARKER-TENANT-B'), false);

    const { rows } = await ctx.owner.query<{ qr_id: string; key_id: number; restaurant_id: string }>(
      'select qr_id, key_id, restaurant_id from table_qr_tokens where revoked_at is null');
    for (const row of rows) {
      assert.equal(text.includes(row.qr_id), false, 'qr_ids are never handed out');
      if (row.restaurant_id !== ctx.fixtures.restaurantA) {
        assert.equal(text.includes(signQrToken(keyring, row.qr_id, row.key_id)), false, "another restaurant's code");
      }
    }
  });

  test('counts active tables still without a code', async () => {
    await post(ctx.fixtures.ownerA, '', { tableNumber: 'NOQR', capacity: 2 });
    const res = await get(ctx.fixtures.ownerA, '/qr-sheet');
    assert.equal(res.body.activeTablesWithoutQr, 1);
  });

  test('kitchen and billing staff cannot get the sheet', async () => {
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      assert.equal((await get(userId, '/qr-sheet')).status, 403);
    }
  });
});

describe('PNG download (FR-015)', () => {
  let id = '';

  test('returns the live code as a PNG attachment', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'P 1/a', capacity: 2 });
    id = created.body.table.id;
    await post(ctx.fixtures.ownerA, `/${id}/qr`);

    const res = await get(ctx.fixtures.ownerA, `/${id}/qr/png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['content-disposition'], 'attachment; filename="table-P-1-a-qr.png"');
    assert.ok(Buffer.isBuffer(res.body));
    assert.deepEqual([...res.body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  test('a table without a code, a missing table and a malformed id all return not found', async () => {
    const bare = await post(ctx.fixtures.ownerA, '', { tableNumber: 'P2', capacity: 2 });
    assert.equal((await get(ctx.fixtures.ownerA, `/${bare.body.table.id}/qr/png`)).status, 404);
    assert.equal((await get(ctx.fixtures.ownerA, '/00000000-0000-4000-8000-000000000000/qr/png')).status, 404);
    assert.equal((await get(ctx.fixtures.ownerA, '/not-an-id/qr/png')).status, 404);
  });

  test("another restaurant's code cannot be downloaded", async () => {
    const b = await aTableOfB();
    assert.equal((await get(ctx.fixtures.ownerA, `/${b.id}/qr/png`)).status, 404);
  });

  test('kitchen and billing staff cannot download codes', async () => {
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      assert.equal((await get(userId, `/${id}/qr/png`)).status, 403);
    }
  });
});

describe('qr_id randomness (NFR-S13)', () => {
  test('new qr_ids use all 128 bits, not a version-4 uuid', async () => {
    await post(ctx.fixtures.ownerA, '/bulk', { prefix: 'RND', from: 1, to: 24, capacity: 2 });
    await post(ctx.fixtures.ownerA, '/qr/issue-missing');
    const { rows } = await ctx.owner.query<{ qr_id: string }>(
      `select q.qr_id from table_qr_tokens q join dining_tables t on t.id = q.table_id
        where t.table_number like 'RND%'`);
    assert.equal(rows.length, 24);
    // A v4 uuid always has '4' here; random bytes do so one time in sixteen. All 24
    // being '4' by chance has odds of about 1 in 10^29.
    assert.ok(rows.some((row) => row.qr_id[14] !== '4'), 'version nibble is random');
    assert.equal(new Set(rows.map((row) => row.qr_id)).size, 24);
  });
});

describe('equal timing for unavailable codes (US-03)', () => {
  test('forged, malformed and revoked codes all take the same minimum time', async () => {
    const created = await post(ctx.fixtures.ownerA, '', { tableNumber: 'TIME1', capacity: 2 });
    const issued = await post(ctx.fixtures.ownerA, `/${created.body.table.id}/qr`);
    const revokedToken = tokenFromUrl(issued.body.qr.url);
    await post(ctx.fixtures.ownerA, `/${created.body.table.id}/qr/revoke`);
    const forged = Buffer.concat([Buffer.from([2]), randomBytes(32)]).toString('base64url');

    const durations: number[] = [];
    for (const token of [forged, 'not-a-token', revokedToken]) {
      const started = performance.now();
      const res = await publicEntry(token);
      durations.push(performance.now() - started);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'TABLE_UNAVAILABLE');
    }
    for (const ms of durations) assert.ok(ms >= UNAVAILABLE_FLOOR_MS - 5, `answered in ${ms.toFixed(0)} ms`);
    assert.ok(Math.max(...durations) - Math.min(...durations) < 100, `spread ${durations.map((d) => d.toFixed(0))}`);
  });
});

void auditActions;
