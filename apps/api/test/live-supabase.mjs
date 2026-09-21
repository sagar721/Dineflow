#!/usr/bin/env node
// Live verification against a real Supabase project.
//
// Not part of `npm test`: it needs credentials and it creates and deletes real
// users, so it is run deliberately:
//
//   set -a && . ./.env && set +a && node apps/api/test/live-supabase.mjs
//
// It proves the paths a stub cannot: that Supabase actually verifies passwords,
// that the tokens it issues pass our verifier against the project's JWKS, and that
// session revocation behaves as the design assumes. Every account it creates is
// prefixed `dineflow-live-test-` and deleted at the end.
import { createVerifier } from '../src/auth/jwt.ts';
import { SupabaseAuth } from '../src/auth/supabase.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Database } from '../src/lib/db.ts';
import { migrate } from '@dineflow/db/migrate';
import { seed } from '../../../packages/db/test/fixtures.ts';
import pg from 'pg';
import request from 'supertest';

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed });
  process.stdout.write(`  ${passed ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${passed || !detail ? '' : ` — ${detail}`}\n`);
};

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY'];
for (const name of required) {
  if (!process.env[name]) {
    process.stderr.write(`${name} is not set. Load .env first.\n`);
    process.exit(2);
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
// Point these at the Supabase database to exercise the real deployment shape,
// where `auth.users` is the provider's own table and our foreign keys reference it.
const OWNER_URL = process.env.LIVE_OWNER_URL
  ?? process.env.LOCAL_DATABASE_URL
  ?? 'postgres://postgres:dineflow_local_only@localhost:55432/dineflow';
const API_URL = process.env.LIVE_API_URL
  ?? OWNER_URL.replace('postgres://postgres:dineflow_local_only', 'postgres://dineflow_api:dineflow_api_local_only');
const REMOTE = Boolean(process.env.LIVE_OWNER_URL);

const stamp = Date.now();
const testEmail = `dineflow-live-test-${stamp}@example.com`;
const password = 'live-test-password-not-reused-elsewhere';
const createdUserIds = [];

const provider = new SupabaseAuth({
  url: SUPABASE_URL,
  anonKey: process.env.SUPABASE_ANON_KEY,
  serviceKey: process.env.SUPABASE_SERVICE_KEY,
});

// No JWT secret: this project publishes a JWKS, so verification uses the
// asymmetric path — the one the stub could not exercise.
const verify = createVerifier({ supabaseUrl: SUPABASE_URL });

let owner;
let db;

try {
  process.stdout.write('\x1b[1mLive verification against Supabase\x1b[0m\n\n\x1b[1mProvider\x1b[0m\n');

  // ------------------------------------------------------------ create a user
  const created = await provider.createUser(testEmail, password);
  if ('conflict' in created) throw new Error('unexpected conflict creating the test user');
  createdUserIds.push(created.userId);
  check('admin API creates a confirmed user', Boolean(created.userId));

  // ----------------------------------------------------------- password checks
  const wrong = await provider.signInWithPassword(testEmail, 'definitely-the-wrong-password');
  check('a wrong password is rejected by the provider', wrong.kind === 'invalid');

  const right = await provider.signInWithPassword(testEmail, password);
  check('the correct password returns a session', right.kind === 'session');
  if (right.kind !== 'session') throw new Error('cannot continue without a session');

  check('the session names the same user', right.session.userId === created.userId);

  // -------------------------------------------- verification against real JWKS
  const header = JSON.parse(Buffer.from(right.session.accessToken.split('.')[0], 'base64url').toString());
  check(`tokens are signed asymmetrically (alg ${header.alg})`, header.alg === 'ES256' || header.alg === 'RS256',
    `alg was ${header.alg}`);

  const verified = await verify(right.session.accessToken);
  check('our verifier accepts a real token via JWKS', verified?.userId === created.userId,
    verified ? `subject ${verified.userId}` : 'verification returned null');
  check('a real token reports aal1 before MFA', verified?.aal === 'aal1');

  const tampered = right.session.accessToken.slice(0, -4) + 'AAAA';
  check('our verifier rejects a tampered real token', (await verify(tampered)) === null);

  // ------------------------------------------------------------------ refresh
  const refreshed = await provider.refresh(right.session.refreshToken);
  check('a refresh token exchanges for a new session', refreshed !== null);
  const refreshedVerified = refreshed ? await verify(refreshed.accessToken) : null;
  check('the refreshed token also verifies', refreshedVerified?.userId === created.userId);

  const badRefresh = await provider.refresh('not-a-real-refresh-token');
  check('an invalid refresh token is refused', badRefresh === null);

  // ------------------------------------------------------- session revocation
  await provider.signOutEverywhere(right.session.accessToken);
  const afterRevoke = await provider.refresh(right.session.refreshToken);
  check('signing out everywhere invalidates the refresh token', afterRevoke === null,
    'the old refresh token still worked after global sign-out');

  // ------------------------------------------------------------- password reset
  await provider.sendPasswordReset(testEmail, 'http://localhost:5173/reset-password');
  check('a password-reset request is accepted', true);

  // ---------------------------------------------------- the API, end to end
  process.stdout.write('\n\x1b[1mAPI with the real provider\x1b[0m\n');

  await migrate(OWNER_URL);
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  if (!REMOTE) await owner.query(`alter role dineflow_api with password 'dineflow_api_local_only'`);
  const fixtures = await seed(owner);

  // Against the Supabase database the provider has already written this row, which
  // is the whole point of the deployed shape; against a local database the shim
  // needs it so the membership foreign key resolves.
  await owner.query(
    'insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing',
    [created.userId, testEmail]);
  check(`database target: ${REMOTE ? 'Supabase (real auth.users)' : 'local shim'}`, true);
  await owner.query(
    `insert into restaurant_users (restaurant_id, user_id, role, status, email, display_name)
     values ($1, $2, 'owner', 'active', $3, 'Live Test Owner')`,
    [fixtures.restaurantA, created.userId, testEmail],
  );

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: API_URL,
    WEB_ORIGIN: 'http://localhost:5173',
    APP_BASE_URL: 'http://localhost:5173',
    SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    COOKIE_SECURE: 'false',
    TRUST_PROXY_HOPS: '0',
    LOG_LEVEL: 'silent',
  });

  db = new Database(API_URL);
  await db.assertSafeRole();
  check('the API refuses to run on a role that could bypass RLS', true);

  const { app } = buildApp({ config, db, provider, verify });
  const web = (req) => req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173');

  const login = await web(request(app).post('/api/v1/auth/login')).send({ email: testEmail, password });
  check('login through the API succeeds against the real provider', login.status === 200,
    `status ${login.status} ${JSON.stringify(login.body).slice(0, 160)}`);

  const cookies = (login.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ');
  check('session cookies are set and HttpOnly',
    (login.headers['set-cookie'] ?? []).every((value) => /HttpOnly/i.test(value)));

  const me = await request(app).get('/api/v1/auth/me').set('cookie', cookies);
  check('a real session authorizes a request and resolves the tenant',
    me.status === 200 && me.body.restaurantId === fixtures.restaurantA,
    `status ${me.status} ${JSON.stringify(me.body).slice(0, 160)}`);
  check('the role comes from the database, not the token', me.body.role === 'owner');

  const badLogin = await web(request(app).post('/api/v1/auth/login'))
    .send({ email: testEmail, password: 'wrong-password-for-this-check' });
  check('a wrong password through the API gives the generic message',
    badLogin.status === 401 && badLogin.body.error.message === 'Invalid email or password.');

  // Deactivation must lock the user out on the very next request, even though the
  // token they hold is still cryptographically valid (FR-104).
  await owner.query(`update restaurant_users set status = 'deactivated' where user_id = $1`, [created.userId]);
  const afterDeactivation = await request(app).get('/api/v1/auth/me').set('cookie', cookies);
  check('deactivation locks the user out on the next request', afterDeactivation.status === 401,
    `status ${afterDeactivation.status}`);
  await owner.query(`update restaurant_users set status = 'active' where user_id = $1`, [created.userId]);

  await owner.query(`update restaurants set status = 'suspended' where id = $1`, [fixtures.restaurantA]);
  const afterSuspension = await request(app).get('/api/v1/auth/me').set('cookie', cookies);
  check('suspending the restaurant locks its staff out', afterSuspension.status === 401);
  await owner.query(`update restaurants set status = 'active' where id = $1`, [fixtures.restaurantA]);

  const logout = await web(request(app).post('/api/v1/auth/logout')).set('cookie', cookies);
  check('logout clears the session cookies',
    logout.status === 200 && (logout.headers['set-cookie'] ?? []).some((value) => value.startsWith('df_at=;')));

  const audit = await owner.query(
    `select count(*)::int as count from audit_log where action in ('auth.login.succeeded', 'auth.login.failed', 'auth.logout')`);
  check('real sign-ins are audited', (audit.rows[0]?.count ?? 0) >= 3, `${audit.rows[0]?.count} rows`);
} catch (error) {
  check(`unexpected failure: ${error.message}`, false);
} finally {
  // Always clean up, so a failed run does not leave accounts behind in the project.
  process.stdout.write('\n\x1b[1mCleanup\x1b[0m\n');

  // Our membership rows reference auth.users, so they must go first: while a
  // reference exists the provider cannot delete the account, and its admin API
  // reports that as a 500. That ordering is also what the offboarding runbook
  // will need (FR-110 keeps users referenced by history, so they are deactivated
  // rather than deleted).
  if (owner) {
    await owner.query('delete from restaurant_users where email like $1', ['dineflow-live-test-%']).catch(() => {});
  }

  for (const id of createdUserIds) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
    });
    check(`test user ${id.slice(0, 8)}… deleted from the project`, response.ok, `status ${response.status}`);
  }
  if (owner) await owner.end().catch(() => {});
  if (db) await db.close().catch(() => {});
}

const failed = results.filter((result) => !result.passed).length;
process.stdout.write(`\n  ${results.length - failed}/${results.length} checks passed\n`);
process.stdout.write(failed === 0
  ? '\x1b[32mLive verification passed\x1b[0m\n'
  : `\x1b[31mLive verification FAILED (${failed})\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
