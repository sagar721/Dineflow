// The QR signing key as configuration: startup validation, the absence of any
// fallback, behaviour across restarts and rotations, and that the key never leaks.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { loadConfig } from '../src/config.ts';
import {
  bootLocalApp, capturedLogs, createTestContext, signToken, TEST_QR_KEYS, testEnv, type TestContext,
} from './helpers.ts';

const secret = () => randomBytes(32).toString('base64url');

/** Asserts the config is refused, and that the refusal does not repeat the key. */
function assertRefused(keys: string | undefined, pattern: RegExp, extra: Record<string, string> = {}) {
  let message = '';
  assert.throws(() => {
    try {
      loadConfig(testEnv({ QR_SIGNING_KEYS: keys, ...extra }));
    } catch (error) {
      message = (error as Error).message;
      throw error;
    }
  }, pattern);

  // No part of the key may appear in the error, not even a fragment: errors reach
  // terminals, deploy logs and CI output.
  for (const part of (keys ?? '').split(/[,:]/).filter((p) => p.length >= 8)) {
    for (let i = 0; i + 8 <= part.length; i += 4) {
      assert.equal(message.includes(part.slice(i, i + 8)), false, 'error message echoes key material');
    }
  }
}

describe('startup validation', () => {
  test('a missing key stops the API starting', () => {
    assertRefused(undefined, /QR_SIGNING_KEYS/);
  });

  test('an empty or whitespace-only key stops the API starting', () => {
    assertRefused('', /QR_SIGNING_KEYS/);
    assertRefused('   ', /QR_SIGNING_KEYS/);
  });

  test('a key that is too short is refused', () => {
    assertRefused(`1:${randomBytes(16).toString('base64url')}`, /at least 32 random bytes/);
  });

  test('a long but non-random key is refused', () => {
    // 43 "A"s decode to 32 zero bytes: the right length, and trivially forgeable.
    assertRefused(`1:${'A'.repeat(43)}`, /not random enough/);
    assertRefused(`1:${'AbCd'.repeat(11)}`, /not random enough/);
  });

  test('characters the decoder would silently drop are refused, not ignored', () => {
    const good = secret();
    assertRefused(`1:${good.slice(0, 20)} ${good.slice(20)}`, /base64url/);        // pasted space
    assertRefused(`1:${good.slice(0, 20)}!!${good.slice(20)}`, /base64url/);       // stray characters
    assertRefused(`1:${good}:2:${secret()}`, /base64url/);                          // ":" instead of ","
    assertRefused(`1:${randomBytes(32).toString('base64')}`, /base64url|canonical/); // standard base64
  });

  test('a malformed key id is refused', () => {
    assertRefused(`0:${secret()}`, /1 to 255/);
    assertRefused(`256:${secret()}`, /1 to 255/);
    assertRefused(`x:${secret()}`, /1 to 255/);
    assertRefused(secret(), /1 to 255/); // no id at all
  });

  test('two key ids sharing one secret is refused', () => {
    const shared = secret();
    assertRefused(`1:${shared},2:${shared}`, /repeats another key/);
  });

  test('pointing QR_SIGNING_KEY_ID at a key that is not listed is refused', () => {
    assertRefused(`1:${secret()}`, /not in QR_SIGNING_KEYS/, { QR_SIGNING_KEY_ID: '5' });
  });

  test('an empty QR_SIGNING_KEY_ID means "not set", not key id 0', () => {
    const config = loadConfig(testEnv({ QR_SIGNING_KEYS: `1:${secret()}`, QR_SIGNING_KEY_ID: '' }));
    assert.equal(config.QR_SIGNING_KEY_ID, undefined);
  });

  test('a valid key is accepted', () => {
    const config = loadConfig(testEnv({ QR_SIGNING_KEYS: `1:${secret()},2:${secret()}` }));
    assert.ok(config.QR_SIGNING_KEYS);
  });
});

describe('production', () => {
  const production = (overrides: Record<string, string | undefined>) => testEnv({
    NODE_ENV: 'production',
    COOKIE_SECURE: 'true',
    APP_BASE_URL: 'https://app.example.com',
    WEB_ORIGIN: 'https://app.example.com',
    ...overrides,
  });

  test('there is no fallback key: production without one does not start', () => {
    assert.throws(() => loadConfig(production({ QR_SIGNING_KEYS: undefined })), /QR_SIGNING_KEYS/);
    assert.throws(() => loadConfig(production({ QR_SIGNING_KEYS: '' })), /QR_SIGNING_KEYS/);
  });

  test('production starts with a valid key and a public https origin', () => {
    const config = loadConfig(production({ QR_SIGNING_KEYS: `1:${secret()}` }));
    assert.equal(config.NODE_ENV, 'production');
  });

  test('production refuses a development origin, which printed codes would encode', () => {
    assert.throws(
      () => loadConfig(production({ QR_SIGNING_KEYS: `1:${secret()}`, APP_BASE_URL: 'http://localhost:5173' })),
      /public https origin/,
    );
  });
});

describe('the configured key in use', () => {
  let ctx: TestContext;
  let tableId = '';
  let printedUrl = '';

  const owner = async () => `df_at=${await signToken({ sub: ctx.fixtures.ownerA })}`;
  const web = (req: request.Test) =>
    req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', '198.51.100.40');
  const scan = (app: Parameters<typeof request>[0], url: string) =>
    request(app).get(`/api/v1/public/tables/${url.split('/t/')[1]}`).set('x-forwarded-for', '198.51.100.41');

  before(async () => {
    capturedLogs.length = 0;
    ctx = await createTestContext();
    const created = await web(request(ctx.app).post('/api/v1/restaurant/tables'))
      .set('cookie', await owner()).send({ tableNumber: 'KEY-T1', capacity: 2 });
    tableId = created.body.table.id;
    const issued = await web(request(ctx.app).post(`/api/v1/restaurant/tables/${tableId}/qr`))
      .set('cookie', await owner());
    printedUrl = issued.body.qr.url;
  });
  after(async () => { await ctx.close(); });

  test('a code signed with the configured key scans successfully', async () => {
    assert.equal((await scan(ctx.app, printedUrl)).status, 200);
  });

  test('after a restart with the same key, the printed code still works and reprints identically', async () => {
    const restarted = await bootLocalApp(ctx.db, ctx.provider);
    assert.equal((await scan(restarted.app, printedUrl)).status, 200);

    const reprint = await request(restarted.app).get(`/api/v1/restaurant/tables/${tableId}/qr`)
      .set('cookie', await owner());
    assert.equal(reprint.body.qr.url, printedUrl, 'a reprint after restart must match the card on the table');
  });

  test('an instance configured with a different key rejects the printed code', async () => {
    const other = await bootLocalApp(ctx.db, ctx.provider, { QR_SIGNING_KEYS: `1:${secret()},2:${secret()}` });
    assert.equal((await scan(other.app, printedUrl)).status, 404);
  });

  test('adding a key keeps printed codes working; new codes use the new key', async () => {
    // The printed code was signed with key 2 of TEST_QR_KEYS. Keep key 2, add key 3.
    const keyTwo = TEST_QR_KEYS.split(',').find((entry) => entry.startsWith('2:'))!;
    const rotated = await bootLocalApp(ctx.db, ctx.provider, { QR_SIGNING_KEYS: `${keyTwo},3:${secret()}` });
    assert.equal((await scan(rotated.app, printedUrl)).status, 200, 'rotation must not strand printed cards');

    const created = await web(request(rotated.app).post('/api/v1/restaurant/tables'))
      .set('cookie', await owner()).send({ tableNumber: 'KEY-T2', capacity: 2 });
    const issued = await web(request(rotated.app).post(`/api/v1/restaurant/tables/${created.body.table.id}/qr`))
      .set('cookie', await owner());
    const kid = Buffer.from(issued.body.qr.url.split('/t/')[1], 'base64url')[0];
    assert.equal(kid, 3, 'new codes are signed with the newest key');
  });

  test('removing a key stops every code signed with it', async () => {
    const retired = await bootLocalApp(ctx.db, ctx.provider, { QR_SIGNING_KEYS: `3:${secret()}` });
    assert.equal((await scan(retired.app, printedUrl)).status, 404);
  });

  test('no key material appears in any log line or QR response', async () => {
    const keyMaterial = TEST_QR_KEYS.split(',').map((entry) => entry.split(':')[1]!);
    const reprint = await request(ctx.app).get(`/api/v1/restaurant/tables/${tableId}/qr`).set('cookie', await owner());
    const surfaces = JSON.stringify(capturedLogs) + JSON.stringify(reprint.body);
    for (const key of keyMaterial) {
      assert.equal(surfaces.includes(key), false, 'a signing key leaked into logs or a response');
      assert.equal(surfaces.includes(Buffer.from(key, 'base64url').toString('hex')), false);
    }
  });
});
