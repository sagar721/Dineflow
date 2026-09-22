// Test harness for the API.
//
// Two real things and one stub: a real Postgres with the real migrations and RLS,
// the real Express app with its real middleware, and a stub GoTrue standing in for
// Supabase Auth. The stub is a test double, not a second implementation — it lets
// us exercise every path we own (cookies, lockouts, tenant context, audit, error
// shapes) without an account. What it cannot prove is listed in the report.
import pg from 'pg';
import { SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { base32Encode, totp } from './totp.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SupabaseAuth } from '../src/auth/supabase.ts';
import { createVerifier } from '../src/auth/jwt.ts';
import { MemoryRateLimiter } from '../src/lib/rate-limit.ts';
import { Database } from '../src/lib/db.ts';
import { migrate } from '@dineflow/db/migrate';
import type { ImageStore } from '../src/lib/image-store.ts';
import type { OrderLimits } from '../src/modules/public/routes.ts';
import { seed, type Fixtures } from '../../../packages/db/test/fixtures.ts';

export const OWNER_URL = process.env.DATABASE_URL
  ?? 'postgres://postgres:dineflow_local_only@localhost:55432/dineflow';
export const API_PASSWORD = 'dineflow_api_local_only';
export const API_URL = OWNER_URL.replace('postgres://postgres:dineflow_local_only', `postgres://dineflow_api:${API_PASSWORD}`);

const SUPABASE_URL = 'http://supabase.test';
const JWT_SECRET = 'test-only-jwt-secret-value-not-a-real-secret-0123456789';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

export type StubUser = {
  id: string;
  email: string;
  password: string;
  /** A verified TOTP factor makes sign-in a two-step flow. */
  factorId?: string;
  totpCode?: string;
  /** Factors created through enrollment, verified with real TOTP codes. */
  factors?: { id: string; secret: string; status: 'unverified' | 'verified' }[];
};

/**
 * A minimal GoTrue. It signs real JWTs with the test secret, so the API's own
 * verification code runs for real against them.
 */
export class StubProviderServer {
  users = new Map<string, StubUser>();
  /**
   * Creating a user in Supabase inserts a row in `auth.users`, and our schema has
   * foreign keys to it. The stub must reproduce that side effect or acceptance
   * would pass here and fail against the real provider.
   */
  owner?: pg.Client;
  calls: { path: string; method: string }[] = [];
  /** Set to simulate the provider being unreachable. */
  down = false;
  revokedAll: string[] = [];
  revokedRefreshTokens = new Set<string>();
  passwordChanges: string[] = [];
  resetEmails: string[] = [];

  addUser(user: StubUser) {
    this.users.set(user.email.toLowerCase(), user);
    return user;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.replace('/auth/v1', '');
    const method = init?.method ?? 'GET';
    this.calls.push({ path, method });

    if (this.down) return new Response('upstream', { status: 502 });

    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (path === '/token' && url.searchParams.get('grant_type') === 'password') {
      const user = this.users.get(String(body.email ?? '').toLowerCase());
      if (!user || user.password !== body.password) return json(400, { error: 'invalid_grant' });
      const session = await this.#session(user, 'aal1');
      return json(200, { ...session, user: { id: user.id, factors: this.#factorsOf(user) } });
    }

    if (path === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      if (this.revokedRefreshTokens.has(String(body.refresh_token))) return json(400, { error: 'invalid_grant' });
      const user = [...this.users.values()].find((u) => `refresh-${u.id}` === body.refresh_token);
      if (!user) return json(400, { error: 'invalid_grant' });
      const session = await this.#session(user, 'aal1');
      return json(200, { ...session, user: { id: user.id, factors: [] } });
    }

    if (path.startsWith('/factors/') && path.endsWith('/challenge')) {
      const factorId = path.split('/')[2];
      const caller = this.#caller(init);
      const owns = [...this.users.values()].some((u) => u.factorId === factorId)
        || Boolean(caller?.factors?.some((f) => f.id === factorId));
      if (!owns) return json(404, { error: 'factor_not_found' });
      return json(200, { id: 'challenge-1' });
    }

    if (path.startsWith('/factors/') && path.endsWith('/verify')) {
      const factorId = path.split('/')[2];
      const caller = this.#caller(init);
      const legacy = [...this.users.values()].find((u) => u.factorId === factorId);
      if (legacy && (!caller || caller.id === legacy.id)) {
        if (body.code !== legacy.totpCode) return json(400, { error: 'invalid_code' });
        return json(200, { ...(await this.#session(legacy, 'aal2')), user: { id: legacy.id, factors: [] } });
      }
      // Like the real provider, a factor only verifies for the user who owns it.
      const factor = caller?.factors?.find((f) => f.id === factorId);
      if (!caller || !factor) return json(404, { error: 'factor_not_found' });
      const valid = [-1, 0, 1].some((step) => totp(factor.secret, Date.now(), step) === body.code);
      if (!valid) return json(422, { error: 'invalid_code' });
      factor.status = 'verified';
      return json(200, { ...(await this.#session(caller, 'aal2')), user: { id: caller.id, factors: [] } });
    }

    if (path === '/factors' && method === 'POST') {
      const caller = this.#caller(init);
      if (!caller) return json(401, { error: 'unauthorized' });
      const secret = base32Encode(randomBytes(20));
      const factor = { id: crypto.randomUUID(), secret, status: 'unverified' as const };
      (caller.factors ??= []).push(factor);
      const uri = `otpauth://totp/DineFlow:${caller.email}?secret=${secret}&issuer=DineFlow`;
      return json(200, {
        id: factor.id, type: 'totp',
        totp: { qr_code: 'data:image/svg+xml;utf-8,<svg xmlns="http://www.w3.org/2000/svg"/>', secret, uri },
      });
    }

    if (path.startsWith('/factors/') && method === 'DELETE') {
      const caller = this.#caller(init);
      const factorId = path.split('/')[2];
      if (!caller?.factors?.some((f) => f.id === factorId)) return json(404, { error: 'factor_not_found' });
      caller.factors = caller.factors.filter((f) => f.id !== factorId);
      return json(200, {});
    }

    if (path === '/user' && method === 'GET') {
      const caller = this.#caller(init);
      if (!caller) return json(401, { error: 'unauthorized' });
      return json(200, { id: caller.id, factors: this.#factorsOf(caller) });
    }

    if (path === '/user' && method === 'PUT') {
      const caller = this.#caller(init);
      if (!caller) return json(401, { error: 'unauthorized' });
      const bearer = String((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
      const aal = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString() || '{}').aal;
      const hasFactor = Boolean(caller.factorId) || Boolean(caller.factors?.some((f) => f.status === 'verified'));
      // Verified against the live project: Supabase answers 401 insufficient_aal.
      if (hasFactor && aal !== 'aal2') return json(401, { error_code: 'insufficient_aal' });
      caller.password = String(body.password);
      this.passwordChanges.push(caller.id);
      return json(200, { id: caller.id });
    }

    if (path === '/admin/users' && method === 'POST') {
      const email = String(body.email ?? '').toLowerCase();
      if (this.users.has(email)) return json(422, { error: 'already_registered' });
      const id = crypto.randomUUID();
      this.addUser({ id, email, password: String(body.password) });
      if (this.owner) await this.owner.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      return json(200, { id, email });
    }



    if (path === '/recover') {
      this.resetEmails.push(String(body.email ?? ''));
      return json(200, {});
    }

    if (path === '/logout') {
      // The live project rejects the refresh token afterwards; record who was
      // revoked so tests can assert it, and drop their refresh token.
      if (url.searchParams.get('scope') === 'global') {
        const bearer = String((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
        const sub = decodeSubject(bearer);
        if (sub) {
          this.revokedAll.push(sub);
          this.revokedRefreshTokens.add(`refresh-${sub}`);
        }
      }
      return new Response(null, { status: 204 });
    }

    return json(404, { error: 'not_found' });
  };

  /** The user a bearer token belongs to, as the real provider would resolve it. */
  #caller(init?: RequestInit): StubUser | undefined {
    const bearer = String((init?.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
    const sub = decodeSubject(bearer);
    return sub ? [...this.users.values()].find((u) => u.id === sub) : undefined;
  }

  #factorsOf(user: StubUser) {
    return [
      ...(user.factorId ? [{ id: user.factorId, factor_type: 'totp', status: 'verified' }] : []),
      ...(user.factors ?? []).map((f) => ({ id: f.id, factor_type: 'totp', status: f.status })),
    ];
  }

  async #session(user: StubUser, aal: 'aal1' | 'aal2') {
    return {
      access_token: await signToken({ sub: user.id, aal }),
      refresh_token: `refresh-${user.id}`,
      expires_in: 900,
    };
  }
}

/** Reads the subject out of a token without verifying it — stub-side only. */
function decodeSubject(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString()).sub ?? null;
  } catch {
    return null;
  }
}

/** Mints a token the API's verifier will accept, for tests that skip sign-in. */
export async function signToken(claims: {
  sub: string;
  aal?: 'aal1' | 'aal2';
  expiresIn?: string;
  issuer?: string;
  audience?: string;
  /** Authentication methods, e.g. ['otp'] for a session from a reset link. */
  amr?: string[];
  /** When those methods were used (seconds since epoch); defaults to now. */
  amrAt?: number;
}): Promise<string> {
  const at = claims.amrAt ?? Math.floor(Date.now() / 1000);
  const amr = (claims.amr ?? ['password']).map((method) => ({ method, timestamp: at }));
  return new SignJWT({ aal: claims.aal ?? 'aal1', session_id: 'sess-1', amr })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(claims.issuer ?? ISSUER)
    .setAudience(claims.audience ?? 'authenticated')
    .setExpirationTime(claims.expiresIn ?? '15m')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

export const TEST_JWT_SECRET = JWT_SECRET;
/**
 * Test-only QR keys, generated per run so no fixed signing secret exists in the
 * repo. Two keys: fixture QRs are recorded under key 1, new ones are signed with
 * key 2, which lets tests prove a token only works with the key it was issued under.
 */
const qrSecret = () => randomBytes(32).toString('base64url');
export const TEST_QR_KEYS = `1:${qrSecret()},2:${qrSecret()}`;

/** Every log call made by the app under test, so tests can prove secrets never appear. */
export const capturedLogs: unknown[] = [];
export const TEST_SUPABASE_URL = SUPABASE_URL;

export type TestContext = {
  /** The app, already listening on IPv4 loopback (see serveLocally). */
  app: http.Server;
  db: Database;
  owner: pg.Client;
  provider: StubProviderServer;
  fixtures: Fixtures;
  close: () => Promise<void>;
};

export type TestOptions = {
  /** Captures the invitation link instead of sending mail. */
  sendInvitationEmail?: (to: string, link: string) => Promise<void>;
  /** Menu image storage; defaults to none, which is how an unconfigured bucket behaves. */
  imageStore?: ImageStore | null;
  /** Order-placement rate limits; tests that place many orders raise them. */
  orderLimits?: OrderLimits;
};

/** Boots the real app against a freshly seeded database and a stub provider. */
export async function createTestContext(options: TestOptions = {}): Promise<TestContext> {
  await migrate(OWNER_URL);

  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(`alter role dineflow_api with password '${API_PASSWORD}'`);
  const fixtures = await seed(owner);

  const provider = new StubProviderServer();
  provider.owner = owner;
  const db = new Database(API_URL);
  const built = bootApp(db, provider, {}, options);
  const app = await serveLocally(built.app as unknown as http.RequestListener);

  return {
    app,
    db,
    owner,
    provider,
    fixtures,
    close: async () => {
      await closeServers();
      await db.close();
      await owner.end();
    },
  };
}

/** The environment every test app boots with; overrides replace single variables. */
export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: API_URL,
    WEB_ORIGIN: 'http://localhost:5173',
    SUPABASE_URL,
    SUPABASE_ANON_KEY: 'anon-test-key',
    SUPABASE_SERVICE_KEY: 'service-test-key',
    SUPABASE_JWT_SECRET: JWT_SECRET,
    APP_BASE_URL: 'http://localhost:5173',
    // Plain HTTP in tests, so cookies drop the __Host- prefix exactly as they do
    // in local development.
    COOKIE_SECURE: 'false',
    TRUST_PROXY_HOPS: '1',
    LOG_LEVEL: 'silent',
    QR_SIGNING_KEYS: TEST_QR_KEYS,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

const liveServers = new Set<http.Server>();

/**
 * Starts the app on IPv4 loopback, and waits until it is listening.
 *
 * Left to itself, supertest starts each app with listen(0) — every address ("::") —
 * and then connects to 127.0.0.1. When another program on this machine already
 * listens on 127.0.0.1 at the port the OS picked (VS Code's helper processes do, in
 * the same port range), the OS allows both, and the test's request reaches that
 * program instead: a random 401 or 404 that is not DineFlow's. That made the suite
 * fail intermittently. Binding 127.0.0.1 itself means the OS only hands out a port
 * that is free on that address, so a test can only ever reach its own server.
 * supertest reuses a server that is already listening, and never closes it.
 */
export async function serveLocally(app: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  liveServers.add(server);
  return server;
}

/** Closes every server this test process started with serveLocally. */
export async function closeServers(): Promise<void> {
  const closing = [...liveServers].map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  liveServers.clear();
  await Promise.all(closing);
}

/** bootApp, served on IPv4 loopback — for tests that need a second app instance. */
export async function bootLocalApp(...args: Parameters<typeof bootApp>) {
  const built = bootApp(...args);
  return { ...built, app: await serveLocally(built.app as unknown as http.RequestListener) };
}

/**
 * Boots an app instance against an existing database. Calling it again with the
 * same environment is what a process restart looks like: nothing survives but the
 * database and the configuration.
 */
export function bootApp(
  db: Database,
  provider: StubProviderServer,
  overrides: Record<string, string | undefined> = {},
  options: TestOptions = {},
) {
  return buildApp({
    config: loadConfig(testEnv(overrides)),
    db,
    provider: new SupabaseAuth({
      url: SUPABASE_URL,
      anonKey: 'anon-test-key',
      serviceKey: 'service-test-key',
      fetchImpl: provider.fetch,
    }),
    verify: createVerifier({ supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET }),
    limiter: new MemoryRateLimiter(),
    logger: silentLogger(),
    sendInvitationEmail: options.sendInvitationEmail,
    imageStore: options.imageStore ?? null,
    orderLimits: options.orderLimits,
  });
}

function silentLogger() {
  const noop = () => undefined;
  // DINEFLOW_TEST_LOG=1 surfaces the error handler's internal detail when a test
  // fails with a deliberately generic 500.
  const loud = process.env.DINEFLOW_TEST_LOG === '1';
  const serialise = (payload: unknown) =>
    JSON.stringify(payload, (_k, v) => v instanceof Error ? { name: v.name, message: v.message } : v);
  const record = (level: string) => (payload: unknown, message?: string) => {
    capturedLogs.push({ level, payload: serialise(payload), message });
    if (loud && (level === 'error' || level === 'fatal')) {
      console.error('[api]', message, serialise(payload).slice(0, 400));
    }
  };
  void noop;
  return {
    info: record('info'), warn: record('warn'), error: record('error'),
    debug: record('debug'), fatal: record('fatal'), trace: record('trace'),
  } as never;
}

/** Reads audit rows directly, as the owner, to assert what was recorded. */
export async function auditActions(owner: pg.Client, action?: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    action
      ? 'select action from audit_log where action = $1 order by id'
      : 'select action from audit_log order by id',
    action ? [action] : [],
  );
  return rows.map((row) => row.action);
}

/** Extracts a named cookie from a Set-Cookie header list. */
export function cookieFrom(headers: string[] | undefined, name: string): string | undefined {
  return headers?.find((value) => value.startsWith(`${name}=`));
}

/** Builds a Cookie header value from Set-Cookie headers. */
export function cookieJar(headers: string[] | undefined): string {
  return (headers ?? [])
    .map((value) => value.split(';')[0] ?? '')
    // A cookie set to an empty value is a cleared cookie; do not send it back.
    .filter((pair) => pair.length > 0 && !pair.endsWith('='))
    .join('; ');
}
