#!/usr/bin/env node
// Restore drill, level R1 (Part 7 §4).
//
// Backup → encrypt → restore → verify, as one command, so the question "can we get
// the data back?" is answered by evidence on every run rather than by a note in a
// runbook. The drill fails if the restored database differs in data OR in security
// posture: a restore that loses RLS policies would otherwise look like a success
// while quietly exposing every tenant.
//
//   node scripts/restore-drill/run.mjs
//
// Requires: docker (Postgres container), age. pg_dump/pg_restore run inside the
// container, so no local Postgres client tooling is needed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../../packages/db/src/migrate.ts';
import { runSchemaGuards } from '../../packages/db/src/schema-guard.ts';
import { seed } from '../../packages/db/test/fixtures.ts';
import { verifyBillingLedger } from '../../packages/db/src/billing-ledger.ts';

const CONTAINER = process.env.DINEFLOW_PG_CONTAINER ?? 'dineflow-pg';
const PORT = process.env.DINEFLOW_PG_PORT ?? '55432';
const PASSWORD = 'dineflow_local_only';
const SOURCE_DB = 'dineflow';
const TARGET_DB = `dineflow_restore_${Date.now()}`;
const url = (db) => `postgres://postgres:${PASSWORD}@localhost:${PORT}/${db}`;

const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, ...opts });
const dockerText = (args) => docker(args).toString('utf8');
const psql = (db, sql) => dockerText(['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-At', '-c', sql]).trim();

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  process.stdout.write(`  ${passed ? '\x1b[32mok  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${passed || !detail ? '' : ` — ${detail}`}\n`);
};

const work = mkdtempSync(join(tmpdir(), 'dineflow-drill-'));
const started = Date.now();
let sourceClient;
let targetClient;

try {
  process.stdout.write('\x1b[1mRestore drill (R1)\x1b[0m\n');

  // ---------------------------------------------------------------- 1. prepare
  await migrate(url(SOURCE_DB));
  sourceClient = new pg.Client({ connectionString: url(SOURCE_DB) });
  await sourceClient.connect();
  const fixtures = await seed(sourceClient);
  check('source database seeded', Boolean(fixtures.restaurantA));

  // Fingerprints taken BEFORE the dump are what the restored copy must match.
  const fingerprint = async (client) => ({
    schema: await client.query(`
      select md5(string_agg(sig, '|' order by sig)) as hash from (
        select c.relname || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) ||
               ':' || a.attnotnull::text as sig
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         where n.nspname = 'public' and c.relkind = 'r') s`),
    policies: await client.query(`
      select md5(string_agg(sig, '|' order by sig)) as hash from (
        select tablename || ':' || policyname || ':' || cmd || ':' ||
               coalesce(qual, '') || ':' || coalesce(with_check, '') || ':' || array_to_string(roles, ',') as sig
          from pg_policies where schemaname = 'public') s`),
    rls: await client.query(`
      select md5(string_agg(c.relname || ':' || c.relrowsecurity::text || c.relforcerowsecurity::text, '|' order by c.relname)) as hash
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`),
    grants: await client.query(`
      select md5(string_agg(sig, '|' order by sig)) as hash from (
        select table_name || ':' || grantee || ':' || privilege_type as sig
          from information_schema.role_table_grants where table_schema = 'public') s`),
    data: await client.query(`
      select md5(string_agg(sig, '|' order by sig)) as hash from (
        select 'restaurants:' || id || name || status as sig from restaurants
        union all select 'staff:' || id || role || status || coalesce(display_name, '') from restaurant_users
        union all select 'grants:' || id || reason from support_grants
        union all select 'audit:' || id || action || summary::text from audit_log) s`),
    // Bills, payments and the billing ledger: every issued bill's content hash and
    // every ledger entry's hash, so a restore that lost or altered one is caught.
    billing: await client.query(`
      select md5(string_agg(sig, '|' order by sig)) as hash from (
        select 'bill:' || id || status || coalesce(bill_no::text, '') || total_minor || coalesce(encode(content_hash, 'hex'), '') as sig from bills
        union all select 'payment:' || id || amount_minor || coalesce(reversed_at::text, '') from payments
        union all select 'counter:' || restaurant_id || series || next_no from bill_counters
        union all select 'ledger:' || restaurant_id || ':' || seq || ':' || encode(entry_hash, 'hex') from bill_ledger
        union all select 'head:' || restaurant_id || ':' || seq || ':' || encode(last_hash, 'hex') from bill_ledger_heads) s`),
    counts: await client.query(`
      select (select count(*) from restaurants) || '/' ||
             (select count(*) from restaurant_users) || '/' ||
             (select count(*) from support_grants) || '/' ||
             (select count(*) from audit_log) as hash`),
  });

  const before = await fingerprint(sourceClient);
  const sourceLedger = await verifyBillingLedger(sourceClient);
  check('source billing ledger verifies before the backup', sourceLedger.ok && sourceLedger.entries > 0,
    sourceLedger.findings.map((f) => f.check).join(', '));
  await sourceClient.end();
  sourceClient = undefined;

  // ------------------------------------------------------------------ 2. dump
  const dumpPath = join(work, 'dineflow.dump');
  writeFileSync(dumpPath, docker(['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', SOURCE_DB, '-Fc']));
  const dumpSize = statSync(dumpPath).size;
  check('pg_dump produced a non-empty backup', dumpSize > 1000, `${dumpSize} bytes`);

  // --------------------------------------------------------------- 3. encrypt
  // The drill generates a throwaway key pair. In production the public key lives in
  // CI and the private key stays offline with two custodians (Part 7 §4.4).
  const identityPath = join(work, 'drill.key');
  execFileSync('sh', ['-c', `age-keygen -o ${identityPath} 2>/dev/null`]);
  const recipient = readFileSync(identityPath, 'utf8').match(/public key: (age1\S+)/)?.[1];
  const encPath = `${dumpPath}.age`;
  execFileSync('sh', ['-c', `age -r ${recipient} -o ${encPath} ${dumpPath}`]);
  const cipher = readFileSync(encPath);
  check('backup encrypted before leaving the machine', cipher.length > 0 && !cipher.includes(Buffer.from('PGDMP')),
    'ciphertext still contains the plain dump header');

  // Negative test: the wrong key must fail, not silently produce garbage.
  const wrongKey = join(work, 'wrong.key');
  execFileSync('sh', ['-c', `age-keygen -o ${wrongKey} 2>/dev/null`]);
  let wrongKeyRejected = false;
  try {
    execFileSync('sh', ['-c', `age -d -i ${wrongKey} ${encPath} > /dev/null 2>&1`]);
  } catch {
    wrongKeyRejected = true;
  }
  check('decryption with the wrong key fails', wrongKeyRejected);

  // Negative test: a truncated backup must be detected, not half-restored.
  const truncated = join(work, 'truncated.dump.age');
  writeFileSync(truncated, cipher.subarray(0, Math.floor(cipher.length / 2)));
  let truncationDetected = false;
  try {
    execFileSync('sh', ['-c', `age -d -i ${identityPath} ${truncated} > /dev/null 2>&1`]);
  } catch {
    truncationDetected = true;
  }
  check('truncated backup is rejected', truncationDetected);

  // ---------------------------------------------------------------- 4. restore
  const restoredPath = join(work, 'restored.dump');
  execFileSync('sh', ['-c', `age -d -i ${identityPath} -o ${restoredPath} ${encPath}`]);
  check('decrypted backup is byte-identical to the original',
    Buffer.compare(readFileSync(dumpPath), readFileSync(restoredPath)) === 0);

  psql('postgres', `create database ${TARGET_DB}`);
  docker(['exec', '-i', CONTAINER, 'pg_restore', '-U', 'postgres', '-d', TARGET_DB, '--no-owner'],
    { input: readFileSync(restoredPath) });

  targetClient = new pg.Client({ connectionString: url(TARGET_DB) });
  await targetClient.connect();
  const after = await fingerprint(targetClient);

  // ----------------------------------------------------------------- 5. verify
  for (const key of ['schema', 'policies', 'rls', 'grants', 'data', 'billing', 'counts']) {
    const a = before[key].rows[0].hash;
    const b = after[key].rows[0].hash;
    check(`restored ${key} matches the source`, a === b, `source=${a} restored=${b}`);
  }

  const findings = await runSchemaGuards(targetClient);
  check('restored database is still closed by default', findings.length === 0,
    findings.map((f) => `${f.check}:${f.object}`).join(', '));

  const brokenFks = psql(TARGET_DB, `
    select count(*) from (
      select conrelid::regclass::text as t, conname from pg_constraint where contype = 'f') c`);
  check('foreign keys present after restore', Number(brokenFks) > 0, `${brokenFks} constraints`);

  // The billing ledger recomputes on the restored copy: chains, bill content
  // hashes, gap-free numbers, and counters that will not reissue a number.
  const restoredLedger = await verifyBillingLedger(targetClient);
  check('restored billing ledger verifies (chains, content hashes, numbering)', restoredLedger.ok
    && restoredLedger.entries === sourceLedger.entries && restoredLedger.issuedBills === sourceLedger.issuedBills,
    restoredLedger.findings.map((f) => `${f.check}: ${f.detail}`).join('; '));
  const counters = await targetClient.query(`
    select count(*)::int as behind from bill_counters c
     where c.next_no <= coalesce((select max(bill_no) from bills b where b.restaurant_id = c.restaurant_id and b.bill_series = c.series), 0)`);
  check('restored bill counters are ahead of every issued number', counters.rows[0].behind === 0);

  // Tamper test: an edited ledger entry on the restored copy must be detected.
  await targetClient.query('alter table bill_ledger disable trigger trg_bill_ledger_append_only');
  await targetClient.query(`update bill_ledger set payload = '{"tampered": true}' where seq = 1`);
  const tamperedLedger = await verifyBillingLedger(targetClient);
  check('a modified ledger entry is detected on the restored copy',
    !tamperedLedger.ok && tamperedLedger.findings.some((f) => f.check === 'chain-hash'));

  // Tamper test: a changed row must show up as a checksum mismatch.
  await targetClient.query(`update restaurants set name = name || ' tampered' where slug = 'tenant-a'`);
  const tampered = await fingerprint(targetClient);
  check('a modified row is detected by the data checksum',
    tampered.data.rows[0].hash !== before.data.rows[0].hash);
} finally {
  if (sourceClient) await sourceClient.end().catch(() => {});
  if (targetClient) await targetClient.end().catch(() => {});
  try { psql('postgres', `drop database if exists ${TARGET_DB}`); } catch {}
  rmSync(work, { recursive: true, force: true });  // never leave a decrypted dump behind
}

const failed = results.filter((r) => !r.passed).length;
const seconds = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(`\n  ${results.length - failed}/${results.length} checks passed in ${seconds}s\n`);
process.stdout.write(failed === 0
  ? '\x1b[32mRestore drill passed\x1b[0m\n'
  : `\x1b[31mRestore drill FAILED (${failed})\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
