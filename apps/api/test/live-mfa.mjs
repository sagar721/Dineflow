#!/usr/bin/env node
// Live check of authenticator setup and recovery links against a real Supabase
// project. Run deliberately, never in CI:
//
//   set -a && . ./.env && set +a && node apps/api/test/live-mfa.mjs
//
// Uses a throwaway `dineflow-live-test-…@example.com` account, deleted at the end.
// The recovery link is generated through the admin API, so no email is sent.
// Nothing secret — key, code, token, link — is ever printed.
import pg from 'pg';
import request from 'supertest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { Database } from '../src/lib/db.ts';
import { SupabaseAuth } from '../src/auth/supabase.ts';
import { createVerifier } from '../src/auth/jwt.ts';
import { migrate } from '@dineflow/db/migrate';
import { totp } from './totp.ts';

const results = [];
const check = (name, passed, detail) => {
  results.push(passed);
  process.stdout.write(`  ${passed ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${passed || !detail ? '' : ` — ${detail}`}\n`);
};

const URL_ = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const OWNER_URL = 'postgres://postgres:dineflow_local_only@localhost:55432/dineflow';
const API_URL = 'postgres://dineflow_api:dineflow_api_local_only@localhost:55432/dineflow';
const admin = (path, init = {}) => fetch(`${URL_}/auth/v1${path}`, {
  ...init, headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' },
});
const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

const email = `dineflow-live-test-${Date.now()}@example.com`;
const password = `live-${crypto.randomUUID()}`;
let userId;
let owner;
let db;

try {
  process.stdout.write('\x1b[1mLive: authenticator setup and recovery links\x1b[0m\n');

  const provider = new SupabaseAuth({ url: URL_, anonKey: process.env.SUPABASE_ANON_KEY, serviceKey: SERVICE });
  const created = await provider.createUser(email, password);
  userId = created.userId;
  check('throwaway test account created', Boolean(userId));

  // Local database: make the throwaway account a platform admin there only, so the
  // API's aal2 gate is exercised end to end. The Supabase database is not touched.
  await migrate(OWNER_URL);
  owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(`alter role dineflow_api with password 'dineflow_api_local_only'`);
  await owner.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [userId, email]);
  await owner.query('insert into platform_admins (user_id) values ($1) on conflict do nothing', [userId]);

  db = new Database(API_URL);
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: API_URL, WEB_ORIGIN: 'http://localhost:5173', APP_BASE_URL: 'http://localhost:5173',
    SUPABASE_URL: URL_, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY: SERVICE,
    COOKIE_SECURE: 'false', TRUST_PROXY_HOPS: '0', LOG_LEVEL: 'silent', QR_SIGNING_KEYS: process.env.QR_SIGNING_KEYS,
  });
  const verify = createVerifier({ supabaseUrl: URL_ });
  const { app } = buildApp({ config, db, provider, verify });
  const web = (req) => req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173');
  const jar = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

  // ------------------------------------------------------------- enrollment
  const login = await web(request(app).post('/api/v1/auth/login')).send({ email, password });
  let cookie = jar(login);
  check('signed in with a password (aal1)', login.status === 200 && login.body.status === 'ok', `status ${login.status}`);

  const gated = await request(app).get('/api/v1/platform/restaurants').set('cookie', cookie);
  check('platform actions are refused before two-step verification', gated.status === 403, `status ${gated.status}`);

  const started = await web(request(app).post('/api/v1/auth/mfa/enroll')).set('cookie', cookie);
  check('Supabase starts authenticator setup and returns a QR code', started.status === 200
    && /^data:image\/svg\+xml/.test(started.body.qrCode ?? ''), `status ${started.status} ${started.body?.error?.code ?? ''}`);
  const { factorId, secret } = started.body;

  const wrong = await web(request(app).post('/api/v1/auth/mfa/enroll/verify')).set('cookie', cookie)
    .send({ factorId, code: totp(secret) === '000000' ? '111111' : '000000' });
  check('a wrong code is refused by Supabase', wrong.status === 401, `status ${wrong.status}`);

  const confirmed = await web(request(app).post('/api/v1/auth/mfa/enroll/verify')).set('cookie', cookie)
    .send({ factorId, code: totp(secret) });
  check('the code computed from the key turns it on', confirmed.status === 200, `status ${confirmed.status} ${confirmed.body?.error?.code ?? ''}`);
  cookie = jar(confirmed);

  const accessCookie = cookie.split('; ').find((c) => c.startsWith('df_at=')) ?? '';
  check('Supabase issued an aal2 session', claims(accessCookie.slice(6)).aal === 'aal2');

  const allowed = await request(app).get('/api/v1/platform/restaurants').set('cookie', cookie);
  check('platform actions now succeed', allowed.status === 200, `status ${allowed.status}`);

  const relogin = await web(request(app).post('/api/v1/auth/login')).send({ email, password });
  check('signing in again asks for the code', relogin.body.status === 'mfa_required', JSON.stringify(relogin.body));
  const second = await web(request(app).post('/api/v1/auth/mfa/verify')).set('cookie', jar(relogin)).send({ code: totp(secret) });
  check('the code completes sign-in', second.status === 200, `status ${second.status}`);

  // --------------------------------------------------------- recovery links
  // generate_link builds the same link the reset email carries, without sending it.
  const link = await (await admin('/admin/generate_link', {
    method: 'POST', body: JSON.stringify({ type: 'recovery', email, redirect_to: 'http://localhost:5173/reset-password' }),
  })).json();
  check('Supabase generated a recovery link (no email sent)', typeof link.action_link === 'string');

  const followed = await fetch(link.action_link, { redirect: 'manual' });
  const location = followed.headers.get('location') ?? '';
  const fragment = new URLSearchParams(location.split('#')[1] ?? '');
  const recoveryToken = fragment.get('access_token') ?? '';
  check('the link redirects with a session in the URL fragment', followed.status >= 300 && followed.status < 400 && recoveryToken.length > 20,
    `status ${followed.status}`);
  check(`redirect goes to the reset page (${location.startsWith('http://localhost:5173/reset-password') ? 'yes' : 'NO — add it to Supabase Redirect URLs'})`,
    location.startsWith('http://localhost:5173/reset-password'));

  const methods = (claims(recoveryToken).amr ?? []).map((m) => m.method ?? m);
  check(`the link's session proves inbox control (amr: ${methods.join(', ') || 'none'})`,
    methods.includes('recovery') || methods.includes('otp'));

  const ordinary = await web(request(app).post('/api/v1/auth/password/recovery'))
    .send({ accessToken: claims(accessCookie.slice(6)) && accessCookie.slice(6), password: 'should-not-be-accepted-1' });
  check('an ordinary session cannot set a password this way', ordinary.status === 400, `status ${ordinary.status}`);

  const newPassword = `live-new-${crypto.randomUUID()}`;
  const noCode = await web(request(app).post('/api/v1/auth/password/recovery')).send({ accessToken: recoveryToken, password: newPassword });
  check('with 2FA on, the link alone cannot change the password', noCode.status === 401 && noCode.body?.error?.code === 'MFA_REQUIRED',
    `status ${noCode.status} ${noCode.body?.error?.code ?? ''}`);
  const reset = await web(request(app).post('/api/v1/auth/password/recovery'))
    .send({ accessToken: recoveryToken, password: newPassword, code: totp(secret) });
  check('the link plus the authenticator code sets a new password', reset.status === 200, `status ${reset.status} ${reset.body?.error?.code ?? ''}`);

  const oldWorks = await web(request(app).post('/api/v1/auth/login')).send({ email, password });
  check('the old password no longer works', oldWorks.status === 401, `status ${oldWorks.status}`);
  const newWorks = await web(request(app).post('/api/v1/auth/login')).send({ email, password: newPassword });
  check('the new password works (and still asks for the code)', newWorks.body.status === 'mfa_required', `status ${newWorks.status}`);

  const reuse = await web(request(app).post('/api/v1/auth/password/recovery')).send({ accessToken: recoveryToken, password: 'reused-link-password-1' });
  check('the recovery link cannot be used twice', reuse.status === 400, `status ${reuse.status}`);
} catch (error) {
  check(`unexpected failure: ${error.message}`, false);
} finally {
  process.stdout.write('\n\x1b[1mCleanup\x1b[0m\n');
  if (owner && userId) {
    await owner.query('delete from platform_admins where user_id = $1', [userId]).catch(() => {});
    await owner.query('delete from auth.users where id = $1', [userId]).catch(() => {});
    await owner.end().catch(() => {});
  }
  if (userId) {
    const res = await admin(`/admin/users/${userId}`, { method: 'DELETE' });
    check('throwaway account deleted from Supabase', res.ok, `status ${res.status}`);
  }
  if (db) await db.close().catch(() => {});
}

const failed = results.filter((passed) => !passed).length;
process.stdout.write(`\n  ${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
