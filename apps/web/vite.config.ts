import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Development only: sends any visit to 127.0.0.1 on to the same page on localhost.
 *
 * The API trusts one browser origin (WEB_ORIGIN = http://localhost:5180), and its
 * session cookies belong to localhost. Browsers treat 127.0.0.1 as a different site,
 * so a page opened there — for example from the URL Vite prints — has its API calls
 * blocked by CORS and shows "Can't reach the DineFlow server". A 307 keeps the path
 * and method, and the browser carries a URL fragment across it.
 */
function canonicalLocalhost(): Plugin {
  return {
    name: 'dineflow-canonical-localhost',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = req.headers.host ?? '';
        if (host.startsWith('127.0.0.1:')) {
          res.statusCode = 307;
          res.setHeader('location', `http://localhost:${host.slice('127.0.0.1:'.length)}${req.url ?? '/'}`);
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), canonicalLocalhost()],
  // A dedicated port, not Vite's default 5173: other projects on this machine use the
  // defaults, and Vite silently moves to the next free port when one is taken — which
  // left the app on a port that password-reset links (APP_BASE_URL) and the API's CORS
  // allow-list (WEB_ORIGIN) did not point at. strictPort makes that a startup error.
  // Bound to IPv4 loopback: an IPv6-only listener was refused by Chrome. Loopback
  // only, so the dev server is never reachable from the local network.
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  preview: { host: '127.0.0.1', port: 5181, strictPort: true },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Money and the order state machine live in one place and are imported by
      // both the web app and (later) the API, so the two cannot drift apart.
      '@dineflow/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // The customer menu must not download admin code on mobile data (NFR-P01),
        // so the framework is split out and route bundles stay small.
        manualChunks(id: string) {
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
