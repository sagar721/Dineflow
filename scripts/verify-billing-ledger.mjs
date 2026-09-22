#!/usr/bin/env node
// Verifies the billing ledger of a database (Stage-2 conditions 5.1–5.3): every
// restaurant's hash chain, every issued bill's content hash, gap-free numbering and
// that every payment is ledgered. Read-only.
//
//   DATABASE_URL=postgres://… node scripts/verify-billing-ledger.mjs [--restaurant <uuid>] [--json]
//
// The connection must be able to read every billing table (the owner role). There
// is deliberately no default and no .env loading: name the database explicitly.
import pg from 'pg';
import { verifyBillingLedger } from '../packages/db/src/billing-ledger.ts';

const args = process.argv.slice(2);
const restaurantId = args.includes('--restaurant') ? args[args.indexOf('--restaurant') + 1] : undefined;
const asJson = args.includes('--json');
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('Set DATABASE_URL to the database to verify.\n');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin transaction read only');
  const report = await verifyBillingLedger(client, { restaurantId });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Billing ledger: ${report.restaurants} restaurant(s), ${report.entries} entries, ${report.issuedBills} issued bills\n`);
    for (const f of report.findings) process.stdout.write(`  FAIL ${f.check} (${f.restaurantId}): ${f.detail}\n`);
    process.stdout.write(report.ok ? 'Verified: no findings\n' : `${report.findings.length} finding(s)\n`);
  }
  process.exitCode = report.ok ? 0 : 1;
  await client.query('commit');
} finally {
  await client.end();
}
