// Harness entry point.
//
//   npm run db:up && npm run harness
//
// Exits non-zero on any failed check, so CI can gate on it. Prints a coverage count
// (ISO-11) so shrinking coverage is visible rather than silent.
import pg from 'pg';
import { migrate } from '../src/migrate.ts';
import { assertSafeDbRole } from '../src/context.ts';
import { runSchemaGuards } from '../src/schema-guard.ts';
import { seed } from './fixtures.ts';
import { runContextLeakChecks, runIsolationMatrix, type Check } from './harness.ts';
import { runCanaries } from './canaries.ts';

const OWNER_URL = process.env.DATABASE_URL ?? 'postgres://postgres:dineflow_local_only@localhost:55432/dineflow';
const API_PASSWORD = process.env.DINEFLOW_API_PASSWORD ?? 'dineflow_api_local_only';
const API_URL = new URL(OWNER_URL.replace(/^postgres(ql)?:\/\//, 'http://'));
const apiConnectionString =
  `postgres://dineflow_api:${API_PASSWORD}@${API_URL.hostname}:${API_URL.port || 5432}${API_URL.pathname}`;

const section = (title: string) => `\n\x1b[1m${title}\x1b[0m`;

function report(title: string, checks: Check[]): number {
  process.stdout.write(section(title) + '\n');
  let failed = 0;
  for (const c of checks) {
    if (c.passed) continue;
    failed += 1;
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${c.name}${c.detail ? ` — ${c.detail}` : ''}\n`);
  }
  const passed = checks.length - failed;
  process.stdout.write(`  ${failed === 0 ? '\x1b[32m' : ''}${passed}/${checks.length} passed\x1b[0m\n`);
  return failed;
}

const owner = new pg.Client({ connectionString: OWNER_URL });
await owner.connect();

await migrate(OWNER_URL);
// The API's login role needs a password to connect; in production this is a deploy
// secret, here a local-only value.
await owner.query(`alter role dineflow_api with password '${API_PASSWORD}'`);

const api = new pg.Client({ connectionString: apiConnectionString });
await api.connect();

let failures = 0;

// 1. Role hygiene (ISO-08): if the harness itself runs with privileged rights, every
//    result below is worthless, so this is checked first and loudly.
const hygiene: Check[] = [];
try {
  await assertSafeDbRole(api);
  hygiene.push({ name: 'harness connects as a role that cannot bypass RLS', passed: true });
} catch (error) {
  hygiene.push({ name: 'harness connects as a role that cannot bypass RLS', passed: false, detail: (error as Error).message });
}
try {
  await assertSafeDbRole(owner);
  hygiene.push({ name: 'owner connection is correctly identified as privileged', passed: false, detail: 'assertSafeDbRole accepted the migration owner, so it would not catch a misconfigured API role' });
} catch {
  hygiene.push({ name: 'owner connection is correctly identified as privileged', passed: true });
}
failures += report('Role hygiene (ISO-08)', hygiene);

// 2. Structural guards (ISO-01/02, F-1…F-7).
const findings = await runSchemaGuards(owner);
failures += report('Schema guards (ISO-01, ISO-02)', [
  { name: 'schema is closed by default', passed: findings.length === 0, detail: findings.map((f) => `${f.check} on ${f.object}: ${f.detail}`).join('; ') },
]);

// 3. Behavioural matrix (ISO-03…ISO-06).
const fixtures = await seed(owner);
const { checks: matrixChecks, cells } = await runIsolationMatrix(api, fixtures);
failures += report(`Isolation matrix (ISO-03 … ISO-06) — ${cells} declared cells`, matrixChecks);

// 4. Connection reuse (ISO-07).
failures += report('Request context isolation (ISO-07)', await runContextLeakChecks(api, fixtures));

// 5. Canaries (ISO-09): does any of the above actually fail when it should?
failures += report('Sabotage canaries (ISO-09)', await runCanaries(owner, api, OWNER_URL));

// 6. Leave the database in its verified state.
await seed(owner);
await owner.end();
await api.end();

process.stdout.write(`\n${failures === 0 ? '\x1b[32mAll checks passed\x1b[0m' : `\x1b[31m${failures} check(s) failed\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
