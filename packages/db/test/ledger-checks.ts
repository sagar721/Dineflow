// Billing ledger checks (Stage-2 conditions 5.1–5.3): the seeded ledger verifies
// clean, and each kind of tampering is detected. Every tampering runs inside a
// transaction that is rolled back, with the append-only and immutability triggers
// switched off only for that transaction — as an attacker with owner access could.
import type pg from 'pg';
import { verifyBillingLedger, type LedgerReport } from '../src/billing-ledger.ts';
import type { Fixtures } from './fixtures.ts';
import type { Check } from './harness.ts';

async function tampered(owner: pg.Client, restaurantId: string, sabotage: string[]): Promise<LedgerReport> {
  await owner.query('begin');
  try {
    for (const sql of sabotage) await owner.query(sql, sql.includes('$1') ? [restaurantId] : []);
    return await verifyBillingLedger(owner, { restaurantId });
  } finally {
    await owner.query('rollback');
  }
}

export async function runLedgerChecks(owner: pg.Client, fx: Fixtures): Promise<Check[]> {
  const checks: Check[] = [];
  const clean = await verifyBillingLedger(owner);
  checks.push({
    name: 'the seeded billing ledger verifies clean',
    passed: clean.ok && clean.entries > 0 && clean.issuedBills > 0,
    detail: `${clean.entries} entries, ${clean.issuedBills} issued bills; ${clean.findings.map((f) => `${f.check}: ${f.detail}`).join('; ')}`,
  });

  const cases: [string, string, string[]][] = [
    ['an edited ledger entry', 'chain-hash', [
      'alter table bill_ledger disable trigger trg_bill_ledger_append_only',
      `update bill_ledger set payload = '{"totalMinor": 1}' where restaurant_id = $1 and seq = 2`]],
    ['a deleted ledger entry', 'chain-link', [
      'alter table bill_ledger disable trigger trg_bill_ledger_append_only',
      'delete from bill_ledger where restaurant_id = $1 and seq = 2']],
    ['an edited line on an issued bill', 'bill-content', [
      'alter table bill_lines disable trigger trg_bill_lines_guard',
      `update bill_lines set name = 'Forged' where restaurant_id = $1`]],
    ['a rewound bill counter', 'numbering', [
      `update bill_counters set next_no = 1 where restaurant_id = $1`]],
  ];
  for (const [what, expected, sabotage] of cases) {
    const report = await tampered(owner, fx.restaurantA, sabotage);
    const found = report.findings.some((f) => f.check === expected);
    checks.push({
      name: `the verifier detects ${what}`,
      passed: !report.ok && found,
      detail: found ? undefined : `expected a ${expected} finding, got: ${report.findings.map((f) => f.check).join(', ') || 'none'}`,
    });
  }
  const after = await verifyBillingLedger(owner);
  checks.push({ name: 'the ledger is intact again after the tamper checks', passed: after.ok });
  return checks;
}
