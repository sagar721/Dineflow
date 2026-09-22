// Setting up an authenticator app, and setting a password from a recovery link.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  capturedLogs, cookieFrom, cookieJar, createTestContext, signToken, type TestContext,
} from './helpers.ts';
import { totp } from './totp.ts';

let ctx: TestContext;
let ipCounter = 0;
const nextIp = () => `203.0.117.${(ipCounter += 1) % 250 + 1}`;
const asWeb = (req: request.Test) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', nextIp());

const PASSWORD = 'correct-horse-battery';

before(async () => {
  capturedLogs.length = 0;
  ctx = await createTestContext();
  ctx.provider.addUser({ id: ctx.fixtures.adminPlain, email: 'admin@example.test', password: PASSWORD });
  ctx.provider.addUser({ id: ctx.fixtures.ownerA, email: 'owner-a@example.test', password: PASSWORD });
  ctx.provider.addUser({ id: ctx.fixtures.ownerB, email: 'owner-b@example.test', password: PASSWORD });
  ctx.provider.addUser({ id: ctx.fixtures.managerA, email: 'manager-a@example.test', password: PASSWORD });
});
after(async () => { await ctx.close(); });

/** Signs in with a password and returns the session cookie header. */
const signIn = async (email: string) => {
  const res = await asWeb(request(ctx.app).post('/api/v1/auth/login')).send({ email, password: PASSWORD });
  return { res, cookie: cookieJar(res.headers['set-cookie'] as unknown as string[]) };
};
const enroll = (cookie: string) => asWeb(request(ctx.app).post('/api/v1/auth/mfa/enroll')).set('cookie', cookie);
const confirm = (cookie: string, factorId: string, code: string) =>
  asWeb(request(ctx.app).post('/api/v1/auth/mfa/enroll/verify')).set('cookie', cookie).send({ factorId, code });
const me = (cookie: string) => request(ctx.app).get('/api/v1/auth/me').set('cookie', cookie);

describe('setting up an authenticator', () => {
  let adminCookie = '';
  let factorId = '';
  let secret = '';

  test('a new platform admin starts without two-step verification, and without platform powers', async () => {
    ({ cookie: adminCookie } = await signIn('admin@example.test'));
    const status = await request(ctx.app).get('/api/v1/auth/mfa/factors').set('cookie', adminCookie);
    assert.equal(status.status, 200);
    assert.equal(status.body.enabled, false);

    const platform = await request(ctx.app).get('/api/v1/platform/restaurants').set('cookie', adminCookie);
    assert.equal(platform.status, 403, 'platform powers require the second factor');
  });

  test('starting setup returns a QR code and a key to type in, once, uncached', async () => {
    const res = await enroll(adminCookie);
    assert.equal(res.status, 200);
    assert.match(res.body.qrCode, /^data:image\/svg\+xml/);
    assert.ok(res.body.qrCode.length < 50_000, 'a compact QR, not the provider\'s multi-hundred-KB drawing');
    assert.match(res.body.secret, /^[A-Z2-7]+=*$/, 'a base32 key for manual entry');
    assert.equal(res.headers['cache-control'], 'no-store', 'the secret must not be cached anywhere');
    ({ factorId, secret } = res.body);
  });

  test('a wrong code does not turn it on', async () => {
    const wrong = await confirm(adminCookie, factorId, '000000');
    assert.equal(wrong.status, 401);
    const status = await request(ctx.app).get('/api/v1/auth/mfa/factors').set('cookie', adminCookie);
    assert.equal(status.body.enabled, false);
  });

  test('the code from the app turns it on and upgrades this session at once', async () => {
    const res = await confirm(adminCookie, factorId, totp(secret));
    assert.equal(res.status, 200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    assert.ok(cookieFrom(cookies, 'df_at'), 'a new, stronger session is issued');
    adminCookie = cookieJar(cookies);

    const who = await me(adminCookie);
    assert.equal(who.body.mfa, true);

    const platform = await request(ctx.app).get('/api/v1/platform/restaurants').set('cookie', adminCookie);
    assert.equal(platform.status, 200, 'with two-step verification on, platform actions work');
  });

  test('setting it up a second time is refused', async () => {
    const again = await enroll(adminCookie);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'MFA_ALREADY_ENABLED');
  });

  test('from now on, signing in needs the code as well as the password', async () => {
    const { res, cookie } = await signIn('admin@example.test');
    assert.equal(res.body.status, 'mfa_required');
    assert.equal(cookieFrom(res.headers['set-cookie'] as unknown as string[], 'df_at'), undefined);

    const verified = await asWeb(request(ctx.app).post('/api/v1/auth/mfa/verify'))
      .set('cookie', cookie).send({ code: totp(secret) });
    assert.equal(verified.status, 200);
    const session = cookieJar(verified.headers['set-cookie'] as unknown as string[]);
    assert.equal((await me(session)).body.mfa, true);
  });

  test('the authenticator key never reaches a log or the audit trail', async () => {
    assert.equal(JSON.stringify(capturedLogs).includes(secret), false);
    const { rows } = await ctx.owner.query('select summary from audit_log');
    assert.equal(JSON.stringify(rows).includes(secret), false);
    const events = (await ctx.owner.query<{ action: string }>(
      `select action from audit_log where action like 'auth.mfa.%' order by id`)).rows.map((r) => r.action);
    for (const expected of ['auth.mfa.enroll_started', 'auth.mfa.enroll_failed', 'auth.mfa.enrolled']) {
      assert.ok(events.includes(expected), `missing audit event ${expected}`);
    }
  });
});

describe('protections during setup', () => {
  test('restarting an abandoned setup clears the unfinished one', async () => {
    const { cookie } = await signIn('manager-a@example.test');
    await enroll(cookie);
    await enroll(cookie);
    const user = [...ctx.provider.users.values()].find((u) => u.email === 'manager-a@example.test')!;
    assert.equal(user.factors?.length, 1, 'only the latest setup may exist');
    assert.equal(user.factors?.[0]?.status, 'unverified');
  });

  test("one account cannot confirm another account's authenticator", async () => {
    const { cookie: victim } = await signIn('owner-b@example.test');
    const started = await enroll(victim);
    const { cookie: attacker } = await signIn('owner-a@example.test');

    const res = await confirm(attacker, started.body.factorId, totp(started.body.secret));
    assert.equal(res.status, 401);
    const owner = [...ctx.provider.users.values()].find((u) => u.email === 'owner-b@example.test')!;
    assert.equal(owner.factors?.[0]?.status, 'unverified');
  });

  test('repeated wrong codes lock the authenticator, and the lock is enforced', async () => {
    const { cookie } = await signIn('owner-a@example.test');
    const started = await enroll(cookie);
    assert.equal(started.status, 200, `setup: enrollment returned ${started.status} ${JSON.stringify(started.body?.error ?? {})}`);
    // Each wrong code must be refused *as a wrong code*, so it counts toward the lock.
    // Anything else would leave the lock untested.
    const attempts: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const wrong = await confirm(cookie, started.body.factorId, '000000');
      attempts.push(`${wrong.status}:${wrong.body?.error?.code}`);
    }
    assert.deepEqual(attempts, Array(5).fill('401:INVALID_CREDENTIALS'), `wrong-code attempts: ${attempts.join(', ')}`);

    // The right code, but locked: before this fix, failures were counted and the
    // lock was never checked, so guessing was limited only by the IP throttle.
    const res = await confirm(cookie, started.body.factorId, totp(started.body.secret));
    assert.equal(res.status, 401);
    const blocked = await ctx.owner.query(`select 1 from audit_log where action = 'auth.mfa.blocked'`);
    assert.ok((blocked.rowCount ?? 0) > 0);
  });

  test('without a session there is no setup', async () => {
    const res = await asWeb(request(ctx.app).post('/api/v1/auth/mfa/enroll'));
    assert.equal(res.status, 401);
  });

  test('a malformed code or factor id is rejected before reaching the provider', async () => {
    const { cookie } = await signIn('manager-a@example.test');
    assert.equal((await confirm(cookie, 'not-a-uuid', '123456')).status, 400);
    assert.equal((await confirm(cookie, crypto.randomUUID(), '12345')).status, 400);
  });
});

describe('setting a password from a recovery link', () => {
  const recover = (accessToken: string, password = 'a-brand-new-password') =>
    asWeb(request(ctx.app).post('/api/v1/auth/password/recovery')).send({ accessToken, password });

  test('a recovery session sets the password and ends every session', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerA, amr: ['recovery'] });
    const res = await recover(token);
    assert.equal(res.status, 200);
    assert.ok(ctx.provider.passwordChanges.includes(ctx.fixtures.ownerA));
    assert.ok(ctx.provider.revokedAll.includes(ctx.fixtures.ownerA), 'every session must end after a reset');
    assert.equal(res.headers['set-cookie'], undefined, 'no session is handed out: sign in afresh');
  });

  test("a fresh one-time-code session — how Supabase marks a reset link — is accepted", async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerB, amr: ['otp'] });
    assert.equal((await recover(token)).status, 200);
  });

  test('a one-time-code session older than 15 minutes is refused', async () => {
    const before = ctx.provider.passwordChanges.length;
    const stale = await signToken({ sub: ctx.fixtures.ownerB, amr: ['otp'], amrAt: Math.floor(Date.now() / 1000) - 16 * 60 });
    const res = await recover(stale);
    assert.equal(res.status, 400);
    assert.equal(ctx.provider.passwordChanges.length, before);
  });

  test('an ordinary session cannot be used to change a password without the old one', async () => {
    const before = ctx.provider.passwordChanges.length;
    const token = await signToken({ sub: ctx.fixtures.ownerB, amr: ['password'] });
    const res = await recover(token);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'RESET_INVALID');
    assert.equal(ctx.provider.passwordChanges.length, before);
  });

  test('an expired or forged link is refused', async () => {
    const expired = await signToken({ sub: ctx.fixtures.ownerB, amr: ['recovery'], expiresIn: '-1m' });
    assert.equal((await recover(expired)).status, 400);
    const forged = (await signToken({ sub: ctx.fixtures.ownerB, amr: ['recovery'] })).slice(0, -6) + 'AAAAAA';
    assert.equal((await recover(forged)).status, 400);
  });

  test('a weak password is refused before anything changes', async () => {
    const token = await signToken({ sub: ctx.fixtures.ownerB, amr: ['recovery'] });
    const res = await recover(token, 'short');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  test('an account with an authenticator also needs its code to reset the password', async () => {
    const token = await signToken({ sub: ctx.fixtures.adminPlain, amr: ['otp'] });
    const withoutCode = await recover(token);
    assert.equal(withoutCode.status, 401);
    assert.equal(withoutCode.body.error.code, 'MFA_REQUIRED', 'inbox access alone must not be enough');

    const wrongCode = await asWeb(request(ctx.app).post('/api/v1/auth/password/recovery'))
      .send({ accessToken: token, password: 'a-brand-new-password', code: '000000' });
    assert.equal(wrongCode.status, 401);

    const admin = [...ctx.provider.users.values()].find((u) => u.email === 'admin@example.test')!;
    const secret = admin.factors!.find((f) => f.status === 'verified')!.secret;
    const withCode = await asWeb(request(ctx.app).post('/api/v1/auth/password/recovery'))
      .send({ accessToken: token, password: 'a-brand-new-password', code: totp(secret) });
    assert.equal(withCode.status, 200);
    assert.ok(ctx.provider.passwordChanges.includes(ctx.fixtures.adminPlain));
  });

  test('the recovery token and new password never reach a log', async () => {
    const token = await signToken({ sub: ctx.fixtures.managerA, amr: ['recovery'] });
    await recover(token, 'another-new-password-value');
    const logs = JSON.stringify(capturedLogs);
    assert.equal(logs.includes(token), false);
    assert.equal(logs.includes('another-new-password-value'), false);
  });
});
