// Configuration, validated at boot.
//
// The API refuses to start when a required variable is missing or malformed, rather
// than failing later on the first request that needs it (design/02 §11). Secrets are
// read here and nowhere else; nothing in this file is ever logged or returned.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  /** Postgres URL for the API's restricted login role. Must not be a superuser. */
  DATABASE_URL: z.string().min(1),

  /** The single browser origin allowed to call this API with credentials. */
  WEB_ORIGIN: z.string().url(),

  /** Supabase project, called server-side only (D-02). */
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  /**
   * Legacy HS256 projects sign tokens with a shared secret; newer projects publish
   * a JWKS. Exactly one verification path is used, chosen by whether this is set.
   */
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  /** Cookies are host-only and Secure except on plain-HTTP local development. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /** Number of trusted proxies in front of the API, for client-IP resolution. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /** Where invitation and password-reset links point. */
  APP_BASE_URL: z.string().url(),

  /**
   * Returns a new restaurant's owner-invitation link in the API response so the
   * operator can deliver it by hand. It places a live token in a response body, so
   * it exists only until an email provider is wired and is refused in production.
   */
  REVEAL_INVITATION_LINK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // 'silent' is included for tests, which assert on behaviour rather than logs.
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Names only, never values: this message reaches logs and terminals.
    throw new Error(`Invalid configuration:\n${problems}`);
  }

  const config = parsed.data;
  if (config.NODE_ENV === 'production' && !config.COOKIE_SECURE) {
    throw new Error('COOKIE_SECURE must be true in production');
  }
  if (config.NODE_ENV === 'production' && config.REVEAL_INVITATION_LINK) {
    throw new Error('REVEAL_INVITATION_LINK must not be enabled in production');
  }
  return config;
}
