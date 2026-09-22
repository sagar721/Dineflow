// The Vercel configuration is generated at build time, so it is tested like code:
// the default must be byte-for-byte the production routing this repository shipped
// with vercel.json, and neither environment can be pointed at the other's API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, PRODUCTION_API, resolveApiTarget, TARGET_VAR } from './vercel.ts';

/** Exactly what apps/web/vercel.json contained before it became vercel.ts. */
const PRODUCTION_ROUTING = {
  rewrites: [
    { source: '/api/:path*', destination: 'https://dineflow-k329.onrender.com/api/:path*' },
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

test('with nothing configured, the routing is exactly what production had before', () => {
  assert.deepEqual(buildConfig({}), PRODUCTION_ROUTING);
  assert.deepEqual(buildConfig({ VERCEL_ENV: 'production' }), PRODUCTION_ROUTING);
  // A preview of the production project keeps its old behaviour too.
  assert.deepEqual(buildConfig({ VERCEL_ENV: 'preview' }), PRODUCTION_ROUTING);
});

test('staging points at its own API, keeping SPA routing and every security header', () => {
  const staging = 'https://dineflow-api-staging.onrender.com';
  const built = buildConfig({ VERCEL_ENV: 'preview', [TARGET_VAR]: staging });
  assert.deepEqual(built.rewrites[0], { source: '/api/:path*', destination: `${staging}/api/:path*` });
  assert.deepEqual(built.rewrites[1], PRODUCTION_ROUTING.rewrites[1], 'SPA fallback is unchanged');
  assert.deepEqual(built.headers, PRODUCTION_ROUTING.headers, 'security headers are unchanged');
  // A trailing slash is a typo, not a different service.
  assert.equal(resolveApiTarget({ VERCEL_ENV: 'preview', [TARGET_VAR]: `${staging}/` }), staging);
});

test('production cannot be pointed at another API', () => {
  assert.throws(
    () => resolveApiTarget({ VERCEL_ENV: 'production', [TARGET_VAR]: 'https://dineflow-api-staging.onrender.com' }),
    /must use https:\/\/dineflow-k329\.onrender\.com/,
  );
});

test('staging cannot be pointed at the production API', () => {
  for (const env of ['preview', 'development', undefined]) {
    assert.throws(
      () => resolveApiTarget({ ...(env ? { VERCEL_ENV: env } : {}), [TARGET_VAR]: PRODUCTION_API }),
      /points at the production API/,
      `${env ?? 'unset'} environment`,
    );
  }
});

test('a malformed target fails the build rather than routing somewhere odd', () => {
  const bad = [
    'dineflow-api-staging.onrender.com',              // no scheme
    'http://dineflow-api-staging.onrender.com',       // not https
    'https://dineflow-api-staging.onrender.com/api',  // a path, not an origin
    'https://dineflow-api-staging.onrender.com/?x=1', // a query
    'not a url',
  ];
  for (const value of bad) {
    assert.throws(() => resolveApiTarget({ VERCEL_ENV: 'preview', [TARGET_VAR]: value }), Error, value);
  }
});
