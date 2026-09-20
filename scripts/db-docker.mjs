#!/usr/bin/env node
// Starts/stops the disposable Postgres used by the database tests and the restore drill.
// Deliberately plain Docker: the harness must run on any machine with Docker, with no
// Supabase CLI or cloud account, so that "can I verify isolation?" never depends on a vendor.
import { execFileSync } from 'node:child_process';

const NAME = process.env.DINEFLOW_PG_CONTAINER ?? 'dineflow-pg';
const PORT = process.env.DINEFLOW_PG_PORT ?? '55432';
const IMAGE = process.env.DINEFLOW_PG_IMAGE ?? 'postgres:17-alpine';
const PASSWORD = 'dineflow_local_only';

const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

const exists = () => docker(['ps', '-a', '--filter', `name=^${NAME}$`, '--format', '{{.Names}}']).trim() === NAME;
const running = () => docker(['ps', '--filter', `name=^${NAME}$`, '--format', '{{.Names}}']).trim() === NAME;

function up() {
  if (!exists()) {
    docker(['run', '-d', '--name', NAME, '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_DB=dineflow',
      '-p', `${PORT}:5432`, IMAGE, '-c', 'log_statement=none']);
  } else if (!running()) {
    docker(['start', NAME]);
  }
  // The official image starts a temporary server to initialise the cluster and then
  // restarts it, so a single successful probe can be the *temporary* server. Require
  // several consecutive successes to be sure we are past the restart.
  const deadline = Date.now() + 90_000;
  let consecutive = 0;
  while (consecutive < 3) {
    try {
      docker(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'dineflow', '-q']);
      consecutive += 1;
    } catch {
      consecutive = 0;
      if (Date.now() > deadline) throw new Error('Postgres did not become ready within 90s');
    }
    execFileSync('sh', ['-c', 'sleep 1']);
  }
  process.stdout.write(`postgres ready on localhost:${PORT}\n`);
}

function down() {
  if (exists()) docker(['rm', '-f', NAME]);
  process.stdout.write('postgres removed\n');
}

const cmd = process.argv[2];
if (cmd === 'up') up();
else if (cmd === 'down') down();
else {
  process.stderr.write('usage: db-docker.mjs up|down\n');
  process.exit(2);
}
