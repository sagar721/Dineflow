// Application assembly. The order of middleware is the security design
// (design/02 §2), so it is written once, here, and never varied per route.
import express, { type Express } from 'express';
import type { Config } from './config.ts';
import { Database } from './lib/db.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { MemoryRateLimiter, type RateLimiter } from './lib/rate-limit.ts';
import { SupabaseAuth } from './auth/supabase.ts';
import { createVerifier, type Verifier } from './auth/jwt.ts';
import { cors, csrfGuard, errorHandler, securityHeaders } from './middleware/security.ts';
import { requestContext } from './middleware/context.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { staffRoutes } from './modules/staff/routes.ts';
import { notFound } from './lib/errors.ts';

export type AppDeps = {
  config: Config;
  db?: Database;
  provider?: SupabaseAuth;
  verify?: Verifier;
  limiter?: RateLimiter;
  logger?: Logger;
  sendInvitationEmail?: (to: string, link: string) => Promise<void>;
};

export type BuiltApp = { app: Express; db: Database; logger: Logger };

export function buildApp(deps: AppDeps): BuiltApp {
  const { config } = deps;
  const logger = deps.logger ?? createLogger(config.LOG_LEVEL, config.NODE_ENV === 'production');
  const db = deps.db ?? new Database(config.DATABASE_URL);
  const limiter = deps.limiter ?? new MemoryRateLimiter();
  const provider = deps.provider ?? new SupabaseAuth({
    url: config.SUPABASE_URL,
    anonKey: config.SUPABASE_ANON_KEY,
    serviceKey: config.SUPABASE_SERVICE_KEY,
  });
  const verify = deps.verify ?? createVerifier({
    supabaseUrl: config.SUPABASE_URL,
    jwtSecret: config.SUPABASE_JWT_SECRET,
  });

  const app = express();
  app.disable('x-powered-by');
  // Client IP is resolved from a configured hop count in our own middleware, so
  // Express's own heuristic is deliberately not used.
  app.set('trust proxy', false);

  app.use(requestContext(config.TRUST_PROXY_HOPS));
  app.use(securityHeaders());
  app.use(cors(config.WEB_ORIGIN));
  app.use(express.json({ limit: '100kb' }));
  app.use(csrfGuard(config.WEB_ORIGIN));

  // Liveness and readiness carry no detail that would help an attacker map the
  // deployment; readiness reports only whether the database answered.
  app.get('/healthz/live', (_req, res) => { res.status(200).json({ status: 'ok' }); });
  app.get('/healthz/ready', async (_req, res) => {
    try {
      await db.lookupMembership('00000000-0000-0000-0000-000000000000');
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use('/api/v1/auth', authRoutes({
    db, provider, verify, limiter,
    cookieSecure: config.COOKIE_SECURE,
    appBaseUrl: config.APP_BASE_URL,
  }));
  app.use('/api/v1/staff', staffRoutes({
    db, verify,
    cookieSecure: config.COOKIE_SECURE,
    appBaseUrl: config.APP_BASE_URL,
    logger,
    sendInvitationEmail: deps.sendInvitationEmail,
  }));

  app.use((_req, _res, next) => { next(notFound()); });
  app.use(errorHandler(logger));

  return { app, db, logger };
}
