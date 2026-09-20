// Process entry point.
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { app, db, logger } = buildApp({ config });

// Refuse to serve traffic on a connection that could bypass RLS: better to fail at
// boot than to serve every tenant's data to the first request (Part 7 §3, F-2).
await db.assertSafeRole();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => { void db.close().then(() => process.exit(0)); });
  });
}
