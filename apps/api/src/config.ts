// Configuration, validated at boot.
//
// The API refuses to start when a required variable is missing or malformed, rather
// than failing later on the first request that needs it (design/02 §11). Secrets are
// read here and nowhere else; nothing in this file is ever logged or returned.
import { z } from 'zod';
import { parseKeyring } from './lib/qr-token.ts';

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

  /**
   * Keys that sign table QR tokens: comma-separated `kid:secret` pairs, each secret
   * at least 32 random bytes in base64url. Server-only. Several may be listed so
   * cards printed under an older key keep working after a rotation.
   */
  QR_SIGNING_KEYS: z.string().min(1, 'is required'),
  /**
   * Which key signs new tokens. Defaults to the highest key id. An empty value —
   * easy to leave behind in a hosting dashboard — means "not set", not key id 0.
   */
  QR_SIGNING_KEY_ID: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(1).max(255).optional(),
  ),
  /**
   * Printed QR codes encode APP_BASE_URL and cannot be changed once laminated. Until
   * the domain is declared final, QR cards are marked provisional and printing is
   * withheld in the UI (design Q-04).
   */
  QR_DOMAIN_FINAL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Supabase Storage bucket for menu images (public-read; the API is the only
   * writer, using the service key). Unset means image upload is switched off:
   * the rest of the menu works, and uploads answer 503 until a bucket exists.
   */
  MENU_IMAGE_BUCKET: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'must be a lowercase bucket name').optional(),
  ),

  // 'silent' is included for tests, which assert on behaviour rather than logs.
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
}).superRefine((config, ctx) => {
  // The QR keys are fully validated here, with every other setting, so a weak or
  // malformed key stops the process at boot rather than on the first QR a
  // restaurant tries to print. There is no fallback key: without a valid one the
  // API does not start, in any environment.
  if (!config.QR_SIGNING_KEYS) return; // already reported as missing
  try {
    parseKeyring(config.QR_SIGNING_KEYS, config.QR_SIGNING_KEY_ID);
  } catch (error) {
    // parseKeyring's messages name key ids only, never key material.
    ctx.addIssue({ code: 'custom', path: ['QR_SIGNING_KEYS'], message: (error as Error).message });
  }
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
  if (config.NODE_ENV === 'production') {
    // Every QR code printed in production encodes this origin, so it must be a real,
    // secure, public address — never a development one.
    const origin = new URL(config.APP_BASE_URL);
    if (origin.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) {
      throw new Error('APP_BASE_URL must be a public https origin in production');
    }
  }
  if (config.NODE_ENV === 'production' && config.REVEAL_INVITATION_LINK) {
    throw new Error('REVEAL_INVITATION_LINK must not be enabled in production');
  }
  return config;
}
