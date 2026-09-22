// Vercel project configuration.
//
// This replaces vercel.json (Vercel reads one or the other, never both). It exists
// as TypeScript because it runs at build time, which is the only supported way to
// let the API proxy target differ between production and staging: vercel.json is
// static, and a rewrite destination cannot be an environment variable there.
//
// Why the proxy exists at all: session cookies are `__Host-` prefixed and
// SameSite=Lax, so a browser sends them only to the origin that set them. The web
// app must therefore reach the API through its own origin, and /api/* is rewritten
// to the API service. The destination is a public address, not a secret, and it
// never reaches the browser bundle — the rewrite happens on Vercel's edge.

/** The API that every production deployment must use. Changing this changes production. */
export const PRODUCTION_API = 'https://dineflow-k329.onrender.com';

/** The variable a non-production project (staging) sets to its own API service. */
export const TARGET_VAR = 'API_PROXY_TARGET';

/** An origin only: https, no path, query or fragment, no trailing slash. */
function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${TARGET_VAR} must be an absolute URL, for example https://dineflow-api-staging.onrender.com`);
  }
  if (url.protocol !== 'https:') throw new Error(`${TARGET_VAR} must use https`);
  if (url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${TARGET_VAR} must be an origin with no path, query or fragment`);
  }
  return url.origin;
}

/**
 * Which API this deployment proxies to.
 *
 * - Unset: the production API, so existing production and preview deployments
 *   behave exactly as they did before this file existed.
 * - Set on a production deployment: refused unless it is the production API, so a
 *   stray staging value can never take production traffic elsewhere.
 * - Set on any other deployment: refused if it is the production API, so a staging
 *   project cannot quietly read and write production data.
 */
export function resolveApiTarget(env: Record<string, string | undefined> = process.env): string {
  const configured = env[TARGET_VAR]?.trim();
  const isProduction = env.VERCEL_ENV === 'production';
  if (!configured) return PRODUCTION_API;

  const target = normalizeOrigin(configured);
  if (isProduction && target !== PRODUCTION_API) {
    throw new Error(
      `${TARGET_VAR} is ${target}, but a production deployment must use ${PRODUCTION_API}. `
      + 'Remove the variable from the Production environment, or deploy this target from a non-production project.',
    );
  }
  if (!isProduction && target === PRODUCTION_API) {
    throw new Error(
      `${TARGET_VAR} points at the production API (${PRODUCTION_API}) from a ${env.VERCEL_ENV ?? 'non-production'} `
      + 'deployment. Staging must use its own API service and its own database.',
    );
  }
  return target;
}

/** The configuration Vercel applies. Identical in shape to the vercel.json it replaces. */
export function buildConfig(env: Record<string, string | undefined> = process.env) {
  return {
    rewrites: [
      { source: '/api/:path*', destination: `${resolveApiTarget(env)}/api/:path*` },
      { source: '/(.*)', destination: '/index.html' },
    ],
    headers: [
      {
        source: '/(.*)',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ],
  };
}

export const config = buildConfig();
