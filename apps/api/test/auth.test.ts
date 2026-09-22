import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  auditActions, cookieFrom, cookieJar, createTestContext, signToken,
  TEST_SUPABASE_URL, type TestContext,
} from './helpers.ts';

let ctx: TestContext;

/**
 * Every state-changing call from the SPA carries these; a cross-site one cannot.
 *
 * Each caller also gets its own client IP. Rate limits are per-IP by design, so
 * without this one test's failed sign-ins would throttle the next test and the
 * suite would report throttling as though it were the behaviour under test. It
 * also exercises the trusted-hop IP resolution on every request.
 */
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter += 1) % 250 + 1}`;
const asWeb = (req: request.Test, ip = nextIp()) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', ip);

before(async () => {
  ctx = await createTestContext();
  // Give the seeded owner of restaurant A a provider account to sign in with.
  ctx.provider.addUser({ id: ctx.fixtures.ownerA, email: 'owner-a@example.test', password: 'correct-horse-battery' });
  ctx.provider.addUser({ id: ctx.fixtures.kitchenA, email: 'kitchen-a@example.test', password: 'correct-horse-battery' });
  ctx.provider.addUser({ id: ctx.fixtures.ownerB, email: 'owner-b@example.test', password: 'correct-horse-battery' });
  ctx.provider.addUser({ id: ctx.fixtures.ownerS, email: 'owner-s@example.test', password: 'correct-horse-battery' });
  ctx.provider.addUser({ id: ctx.fixtures.deactivatedA, email: 'gone-a@example.test', password: 'correct-horse-battery' });
  ctx.provider.addUser({
    id: ctx.fixtures.adminPlain, email: 'admin@example.test', password: 'correct-horse-battery',
    factorId: 'factor-1', totpCode: '123456',
  });
});

after(async () => { await ctx.close(); });

const login = (email: string, password: string, ip?: string) =>
  asWeb(request(ctx.app).post('/api/v1/auth/login'), ip).send({ email, password });

describe('login', () => {
  test('valid credentials set HttpOnly session cookies', async () => {
    const res = await login('owner-a@example.test', 'correct-horse-battery');
    assert.equal(res.status, 200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const access = cookieFrom(cookies, 'df_at');
    const refresh = cookieFrom(cookies, 'df_rt');
    assert.ok(access, 'access cookie was not set');
    assert.ok(refresh, 'refresh cookie was not set');
    assert.match(access, /HttpOnly/i, 'session cookie must be unreadable from JavaScript');
    assert.match(access, /SameSite=Lax/i);
    assert.match(access, /Path=\//);
    // No token is ever echoed in the body, where JavaScript could read it.
    assert.equal(JSON.stringify(res.body).includes('eyJ'), false);
  });

  test('wrong password is rejected with a generic message', async () => {
    const res = await login('owner-a@example.test', 'wrong-password-entirely');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Invalid email or password.');
  });

  test('an unknown address returns exactly the same response as a wrong password', async () => {
    const unknown = await login('nobody@example.test', 'wrong-password-entirely');
    const known = await login('owner-a@example.test', 'also-wrong-password');
    // On failure, show both responses: an intermittent mismatch here must be diagnosable.
    const both = `unknown: ${unknown.status} ${JSON.stringify(unknown.body)} | known: ${known.status} ${JSON.stringify(known.body)}`;
    assert.equal(unknown.status, known.status, both);
    assert.deepEqual(unknown.body.error?.code, known.body.error?.code, both);
    assert.deepEqual(unknown.body.error?.message, known.body.error?.message, both);
  });

  test('repeated failures lock the account, and the lock is not disclosed', async () => {
    const email = 'lockme@example.test';
    ctx.provider.addUser({ id: crypto.randomUUID(), email, password: 'correct-horse-battery' });

    // One IP for this test, below the per-IP limit, so what locks the account is
    // the account-failure counter and not the IP throttle.
    const ip = '198.51.100.7';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(email, 'wrong-password-entirely', ip);
    }
    const locked = await login(email, 'correct-horse-battery', ip);
    assert.equal(locked.status, 401, 'the correct password must not work while locked');
    assert.equal(locked.body.error.message, 'Invalid email or password.');

    const events = await auditActions(ctx.owner);
    assert.ok(events.includes('auth.login.failed'));
    assert.ok(events.includes('auth.login.blocked'));
  });

  test('passwords never appear in the response', async () => {
    const res = await login('owner-a@example.test', 'correct-horse-battery');
    assert.equal(JSON.stringify(res.body).includes('correct-horse-battery'), false);
  });

  test('a provider outage is reported as unavailable, not as bad credentials', async () => {
    ctx.provider.down = true;
    const res = await login('owner-a@example.test', 'correct-horse-battery');
    ctx.provider.down = false;
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'PROVIDER_UNAVAILABLE');
  });

  test('extra fields in the body are rejected rather than ignored', async () => {
    const res = await asWeb(request(ctx.app).post('/api/v1/auth/login'))
      .send({ email: 'owner-a@example.test', password: 'correct-horse-battery', role: 'owner' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });
});

describe('multi-factor authentication', () => {
  test('an account with a verified factor does not get a session from the password alone', async () => {
    const res = await login('admin@example.test', 'correct-horse-battery');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'mfa_required');

    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    assert.equal(cookieFrom(cookies, 'df_at'), undefined, 'no session may be issued before the second factor');
  });

  test('the correct code completes sign-in at aal2', async () => {
    const first = await login('admin@example.test', 'correct-horse-battery');
    const res = await asWeb(request(ctx.app).post('/api/v1/auth/mfa/verify'))
      .set('cookie', cookieJar(first.headers['set-cookie'] as unknown as string[]))
      .send({ code: '123456' });

    assert.equal(res.status, 200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    assert.ok(cookieFrom(cookies, 'df_at'));

    const me = await request(ctx.app).get('/api/v1/auth/me').set('cookie', cookieJar(cookies));
    assert.equal(me.status, 200);
    assert.equal(me.body.mfa, true);
    assert.equal(me.body.kind, 'platform_admin');
  });

  test('a wrong code is rejected', async () => {
    const first = await login('admin@example.test', 'correct-horse-battery');
    const res = await asWeb(request(ctx.app).post('/api/v1/auth/mfa/verify'))
      .set('cookie', cookieJar(first.headers['set-cookie'] as unknown as string[]))
      .send({ code: '000000' });
    assert.equal(res.status, 401);
  });

  test('a platform admin without the second factor holds no platform powers', async () => {
    const token = await signToken({ sub: ctx.fixtures.adminPlain, aal: 'aal1' });
    const me = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${token}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.mfa, false);
    assert.deepEqual(me.body.permissions, [], 'aal1 must grant nothing to a platform admin');
  });
});

describe('sessions', () => {
  test('a valid session authorizes a request', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerA });
    const res = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'owner');
    assert.equal(res.body.restaurantId, ctx.fixtures.restaurantA);
  });

  test('no cookie means no access', async () => {
    const res = await request(ctx.app).get('/api/v1/auth/me');
    assert.equal(res.status, 401);
  });

  test('an expired token is rejected', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerA, expiresIn: '-1m' });
    const res = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${token}`);
    assert.equal(res.status, 401);
  });

  test('a tampered token is rejected', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerA });
    const [header, payload, signature] = token.split('.');
    const forged = [header, Buffer.from(JSON.stringify({ sub: ctx.fixtures.ownerB, aal: 'aal2' })).toString('base64url'), signature].join('.');
    const res = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${forged}`);
    assert.equal(res.status, 401);
  });

  test('a token from another issuer is rejected', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerA, issuer: 'https://evil.example/auth/v1' });
    const res = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${token}`);
    assert.equal(res.status, 401);
  });

  test('a token for the wrong audience is rejected', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerA, audience: 'anon' });
    const res = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${token}`);
    assert.equal(res.status, 401);
  });

  test('a deactivated staff member is locked out despite a valid token', async () => {
    const token = await signToken({ sub: ctx.fixtures.deactivatedA });
    const res = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${token}`);
    assert.equal(res.status, 401, 'deactivation must take effect on the next request (FR-104)');
  });

  test('staff of a suspended restaurant are locked out', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerS });
    const res = await request(ctx.app).get('/api/v1/auth/me').set('cookie', `df_at=${token}`);
    assert.equal(res.status, 401);
  });

  test('logout clears both cookies and works even with an expired session', async () => {
    const expired = await signToken({ sub: ctx.fixtures.ownerA, expiresIn: '-1m' });
    const res = await asWeb(request(ctx.app).post('/api/v1/auth/logout'))
      .set('cookie', `df_at=${expired}; df_rt=refresh-${ctx.fixtures.ownerA}`);
    assert.equal(res.status, 200);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    assert.ok(cookies.some((c) => c.startsWith('df_at=;')), 'access cookie must be cleared');
    assert.ok(cookies.some((c) => c.startsWith('df_rt=;')), 'refresh cookie must be cleared');
  });

  test('sign out everywhere revokes every provider session', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerA });
    const res = await asWeb(request(ctx.app).post('/api/v1/auth/logout-all')).set('cookie', `df_at=${token}`);
    assert.equal(res.status, 200);
    assert.ok(ctx.provider.revokedAll.includes(ctx.fixtures.ownerA));

    // The revocation must actually stop the refresh token working. Asserting only
    // that the call was made is how a revocation that hit a non-existent endpoint
    // passed its tests while doing nothing (found by the live run).
    const refresh = await asWeb(request(ctx.app).post('/api/v1/auth/refresh'))
      .set('cookie', `df_rt=refresh-${ctx.fixtures.ownerA}`);
    assert.equal(refresh.status, 401, 'the refresh token must be dead after signing out everywhere');
  });

  test('a call to an endpoint the provider does not have fails loudly', async () => {
    // Guards the class of bug above: an unexpected 404 must never be swallowed.
    const { SupabaseAuth } = await import('../src/auth/supabase.ts');
    const provider = new SupabaseAuth({
      url: 'http://supabase.test',
      anonKey: 'k',
      serviceKey: 'k',
      fetchImpl: async () => new Response('{}', { status: 404 }),
    });
    await assert.rejects(() => provider.signOutEverywhere('token'), /temporarily unavailable/);
  });

  test('refresh rotates the session, and an unknown refresh token clears cookies', async () => {
    // A user of its own: the sign-out-everywhere test deliberately kills owner A's
    // refresh token, and these two must not depend on running in a given order.
    const good = await asWeb(request(ctx.app).post('/api/v1/auth/refresh'))
      .set('cookie', `df_rt=refresh-${ctx.fixtures.ownerB}`);
    assert.equal(good.status, 200);

    const bad = await asWeb(request(ctx.app).post('/api/v1/auth/refresh')).set('cookie', 'df_rt=not-a-real-token');
    assert.equal(bad.status, 401);
    const cookies = (bad.headers['set-cookie'] as unknown as string[]) ?? [];
    assert.ok(cookies.some((c) => c.startsWith('df_at=;')));
  });
});

describe('CSRF and transport protections', () => {
  test('a state-changing request without the client header is refused', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login')
      .set('origin', 'http://localhost:5173')
      .send({ email: 'owner-a@example.test', password: 'correct-horse-battery' });
    assert.equal(res.status, 403);
  });

  test('a request from another origin is refused', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login')
      .set('x-dineflow-client', 'web')
      .set('origin', 'https://evil.example')
      .send({ email: 'owner-a@example.test', password: 'correct-horse-battery' });
    assert.equal(res.status, 403);
  });

  test('CORS credentials are offered only to the allow-listed origin', async () => {
    const allowed = await request(ctx.app).options('/api/v1/auth/login').set('origin', 'http://localhost:5173');
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.equal(allowed.headers['access-control-allow-credentials'], 'true');

    const denied = await request(ctx.app).options('/api/v1/auth/login').set('origin', 'https://evil.example');
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(denied.status, 403);
  });

  test('security headers are present and responses are not cacheable', async () => {
    const res = await request(ctx.app).get('/healthz/live');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('an unknown route returns the standard error shape with a request id', async () => {
    const res = await request(ctx.app).get('/api/v1/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.ok(res.body.error.requestId);
  });
});

describe('password recovery', () => {
  test('a known and an unknown address get identical responses', async () => {
    const known = await asWeb(request(ctx.app).post('/api/v1/auth/password/forgot'))
      .send({ email: 'owner-a@example.test' });
    const unknown = await asWeb(request(ctx.app).post('/api/v1/auth/password/forgot'))
      .send({ email: 'nobody-at-all@example.test' });

    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(known.body, unknown.body, 'the response must not reveal whether the account exists');
  });

  test('the reset request is audited', async () => {
    const events = await auditActions(ctx.owner, 'auth.password.reset_requested');
    assert.ok(events.length > 0);
  });
});

describe('rate limiting', () => {
  test('repeated sign-in attempts from one address are throttled', async () => {
    let limited = false;
    const ip = '198.51.100.99';
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const res = await login(`rate-${attempt}@example.test`, 'wrong-password-entirely', ip);
      if (res.status === 429) {
        limited = true;
        assert.ok(res.headers['retry-after'], 'a throttled response must say when to retry');
        break;
      }
    }
    assert.ok(limited, 'login should be rate limited per IP');
  });
});

describe('verification of the token claim shape', () => {
  test('an unknown aal value is treated as aal1, never as satisfied MFA', async () => {
    const { createVerifier } = await import('../src/auth/jwt.ts');
    const { SignJWT } = await import('jose');
    const { TEST_JWT_SECRET } = await import('./helpers.ts');

    const token = await new SignJWT({ aal: 'aal3-but-not-real' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(ctx.fixtures.adminPlain)
      .setIssuedAt()
      .setIssuer(`${TEST_SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    const verify = createVerifier({ supabaseUrl: TEST_SUPABASE_URL, jwtSecret: TEST_JWT_SECRET });
    const result = await verify(token);
    assert.equal(result?.aal, 'aal1');
  });

  test('an empty or oversized token is rejected without work', async () => {
    const { createVerifier } = await import('../src/auth/jwt.ts');
    const { TEST_JWT_SECRET } = await import('./helpers.ts');
    const verify = createVerifier({ supabaseUrl: TEST_SUPABASE_URL, jwtSecret: TEST_JWT_SECRET });
    assert.equal(await verify(''), null);
    assert.equal(await verify('x'.repeat(9000)), null);
  });
});
