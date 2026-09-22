// The billing ledger verifier (Stage-2 conditions 5.1–5.3; approved decision 9).
//
// Recomputes, from the stored rows alone, everything the ledger promises:
//   1. each restaurant's chain: sequence numbers 1, 2, 3 … with no gaps; each
//      entry's prev_hash is the previous entry's hash; each entry_hash is the
//      SHA-256 of prev_hash + its entry text (rebuilt here in TypeScript, not by
//      the database's own function); the head row matches the last entry;
//   2. each issued bill: its content hash is the SHA-256 of its canonical text,
//      rebuilt from its lines, taxes, orders and snapshot; the ledger's
//      bill_finalized entry carries that same hash;
//   3. numbering: every series is 1 … n with no gaps or repeats, and the counter
//      stands at n + 1;
//   4. every finalization, void, payment and reversal has its ledger entry.
//
// Run it with an owner connection (it reads every restaurant): after a restore,
// in the restore drill, or on demand via scripts/verify-billing-ledger.mjs.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { canonicalBillText, type DiscountType, type RoundingMode } from '../../shared/src/bill.ts';

export type LedgerFinding = { check: string; restaurantId: string; detail: string };
export type LedgerReport = {
  ok: boolean;
  restaurants: number;
  entries: number;
  issuedBills: number;
  findings: LedgerFinding[];
};

const GENESIS = Buffer.alloc(32);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

type EntryRow = {
  restaurant_id: string; seq: string; event: string; bill_id: string; payment_id: string | null;
  content_hash: Buffer | null; payload_text: string; actor_user_id: string | null; actor_role: string | null;
  at_us: string; prev_hash: Buffer; entry_hash: Buffer;
};

/** The text an entry's hash covers; must match app.bill_ledger_entry_text (012). */
export function ledgerEntryText(e: Omit<EntryRow, 'prev_hash' | 'entry_hash'>): string {
  return ['v1', e.restaurant_id, e.seq, e.event, e.bill_id, e.payment_id ?? '', e.content_hash?.toString('hex') ?? '',
    e.actor_user_id ?? '', e.actor_role ?? '', e.at_us, e.payload_text].join('|');
}

export async function verifyBillingLedger(client: pg.Client | pg.PoolClient, options: { restaurantId?: string } = {}): Promise<LedgerReport> {
  const findings: LedgerFinding[] = [];
  const only = options.restaurantId ?? null;
  const add = (check: string, restaurantId: string, detail: string) => findings.push({ check, restaurantId, detail });

  // ------------------------------------------------------------------ 1. chain
  const { rows: entries } = await client.query<EntryRow>(
    // ORDER BY is qualified with the table alias on purpose: the output columns are
    // text casts, and ordering by those would put seq 10 before seq 2 and read a
    // sound chain as a broken one.
    `select l.restaurant_id::text, l.seq::text, l.event::text, l.bill_id::text, l.payment_id::text, l.content_hash,
            l.payload::text as payload_text, l.actor_user_id::text, l.actor_role::text,
            (extract(epoch from l.created_at) * 1000000)::bigint::text as at_us, l.prev_hash, l.entry_hash
       from bill_ledger l where ($1::uuid is null or l.restaurant_id = $1)
      order by l.restaurant_id, l.seq`, [only]);
  const { rows: heads } = await client.query<{ restaurant_id: string; seq: string; last_hash: Buffer }>(
    `select restaurant_id::text, seq::text, last_hash from bill_ledger_heads where ($1::uuid is null or restaurant_id = $1)`, [only]);

  const byRestaurant = new Map<string, EntryRow[]>();
  for (const entry of entries) {
    const list = byRestaurant.get(entry.restaurant_id) ?? [];
    list.push(entry);
    byRestaurant.set(entry.restaurant_id, list);
  }
  for (const [restaurantId, list] of byRestaurant) {
    let prev: EntryRow['prev_hash'] = GENESIS;
    list.forEach((entry, index) => {
      const expectedSeq = String(index + 1);
      if (entry.seq !== expectedSeq) add('chain-sequence', restaurantId, `expected seq ${expectedSeq}, found ${entry.seq}`);
      if (!entry.prev_hash.equals(prev)) add('chain-link', restaurantId, `seq ${entry.seq}: prev_hash does not match the previous entry`);
      const recomputed = sha256(Buffer.concat([entry.prev_hash, Buffer.from(ledgerEntryText(entry), 'utf8')]));
      if (!recomputed.equals(entry.entry_hash)) add('chain-hash', restaurantId, `seq ${entry.seq} (${entry.event}): entry hash does not match its content`);
      prev = entry.entry_hash;
    });
    const head = heads.find((h) => h.restaurant_id === restaurantId);
    const last = list[list.length - 1]!;
    if (!head) add('chain-head', restaurantId, 'no head row');
    else if (head.seq !== last.seq || !head.last_hash.equals(last.entry_hash)) {
      add('chain-head', restaurantId, `head is at seq ${head.seq}, last entry is seq ${last.seq}`);
    }
  }
  for (const head of heads) {
    if (!byRestaurant.has(head.restaurant_id) && head.seq !== '0') add('chain-head', head.restaurant_id, 'head without entries');
  }

  // ------------------------------------------------------ 2. issued bills' hashes
  const { rows: bills } = await client.query<{
    id: string; restaurant_id: string; status: string; bill_series: string; bill_no: number; bill_ref: string;
    currency: string; prices_include_tax: boolean; issuer_snapshot: Record<string, unknown>; table_number: string;
    subtotal_minor: string; discount_type: DiscountType | null; discount_value: string | null; discount_minor: string;
    discount_reason: string | null; service_charge_bps: number; service_charge_minor: string; tax_total_minor: string;
    rounding_mode: RoundingMode; rounding_minor: string; total_minor: string; content_hash: Buffer | null;
    order_refs: string[];
    lines: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
    taxes: { name: string; rateBps: number; taxableMinor: number; amountMinor: number }[];
  }>(
    `select b.id::text, b.restaurant_id::text, b.status::text, b.bill_series, b.bill_no, b.bill_ref, b.currency,
            b.prices_include_tax, b.issuer_snapshot, t.table_number, b.subtotal_minor, b.discount_type, b.discount_value,
            b.discount_minor, b.discount_reason, b.service_charge_bps, b.service_charge_minor, b.tax_total_minor,
            b.rounding_mode, b.rounding_minor, b.total_minor, b.content_hash,
            array(select o.order_ref from bill_orders bo join orders o on o.id = bo.order_id where bo.bill_id = b.id) as order_refs,
            coalesce((select json_agg(json_build_object('name', l.name, 'quantity', l.quantity,
                              'unitPriceMinor', l.unit_price_minor, 'lineTotalMinor', l.line_total_minor) order by l.position)
                        from bill_lines l where l.bill_id = b.id), '[]') as lines,
            coalesce((select json_agg(json_build_object('name', x.name, 'rateBps', x.rate_bps,
                              'taxableMinor', x.taxable_minor, 'amountMinor', x.amount_minor) order by x.position)
                        from bill_taxes x where x.bill_id = b.id), '[]') as taxes
       from bills b join dining_tables t on t.id = b.table_id
      where b.status <> 'draft' and ($1::uuid is null or b.restaurant_id = $1)`, [only]);

  const eventsFor = (restaurantId: string, billId: string, event: string) =>
    (byRestaurant.get(restaurantId) ?? []).filter((e) => e.bill_id === billId && e.event === event);

  for (const bill of bills) {
    const text = canonicalBillText({
      restaurantId: bill.restaurant_id, billNo: bill.bill_no, billRef: bill.bill_ref, series: bill.bill_series,
      currency: bill.currency, pricesIncludeTax: bill.prices_include_tax, issuer: bill.issuer_snapshot,
      tableNumber: bill.table_number, orderRefs: bill.order_refs,
      lines: bill.lines.map((l) => ({ ...l, unitPriceMinor: Number(l.unitPriceMinor), lineTotalMinor: Number(l.lineTotalMinor) })),
      taxes: bill.taxes.map((x) => ({ ...x, taxableMinor: Number(x.taxableMinor), amountMinor: Number(x.amountMinor) })),
      subtotalMinor: Number(bill.subtotal_minor), discountType: bill.discount_type,
      discountValue: bill.discount_value === null ? null : Number(bill.discount_value),
      discountMinor: Number(bill.discount_minor), discountReason: bill.discount_reason,
      serviceChargeBps: bill.service_charge_bps, serviceChargeMinor: Number(bill.service_charge_minor),
      taxTotalMinor: Number(bill.tax_total_minor), roundingMode: bill.rounding_mode,
      roundingMinor: Number(bill.rounding_minor), totalMinor: Number(bill.total_minor),
    });
    const hash = sha256(text);
    const label = `bill ${bill.bill_series}/${bill.bill_ref}`;
    if (!bill.content_hash || !hash.equals(bill.content_hash)) {
      add('bill-content', bill.restaurant_id, `${label}: stored content does not match its content hash`);
    }
    const finalized = eventsFor(bill.restaurant_id, bill.id, 'bill_finalized');
    if (finalized.length !== 1) add('bill-ledgered', bill.restaurant_id, `${label}: ${finalized.length} bill_finalized entries`);
    else if (!finalized[0]!.content_hash?.equals(hash)) {
      add('bill-ledgered', bill.restaurant_id, `${label}: the ledger records a different content hash`);
    }
    if (bill.status === 'void' && eventsFor(bill.restaurant_id, bill.id, 'bill_voided').length !== 1) {
      add('bill-ledgered', bill.restaurant_id, `${label}: void without exactly one bill_voided entry`);
    }
  }

  // ------------------------------------------------------------- 3. numbering
  const { rows: series } = await client.query<{ restaurant_id: string; series: string; n: number; max: number; distinct: number; next_no: number | null }>(
    `select b.restaurant_id::text, b.bill_series as series, count(*)::int as n, max(b.bill_no) as max,
            count(distinct b.bill_no)::int as distinct,
            (select c.next_no from bill_counters c where c.restaurant_id = b.restaurant_id and c.series = b.bill_series) as next_no
       from bills b where b.bill_no is not null and ($1::uuid is null or b.restaurant_id = $1)
      group by b.restaurant_id, b.bill_series`, [only]);
  for (const s of series) {
    if (s.distinct !== s.n) add('numbering', s.restaurant_id, `series ${s.series}: a number is used twice`);
    if (s.max !== s.n) add('numbering', s.restaurant_id, `series ${s.series}: ${s.n} bills but the highest number is ${s.max} (a gap)`);
    if (s.next_no !== s.max + 1) {
      add('numbering', s.restaurant_id, `series ${s.series}: counter is at ${s.next_no ?? 'missing'}, expected ${s.max + 1}`);
    }
  }

  // ---------------------------------------------------------- 4. payments
  const { rows: payments } = await client.query<{ id: string; restaurant_id: string; reversed: boolean }>(
    `select id::text, restaurant_id::text, reversed_at is not null as reversed from payments
      where ($1::uuid is null or restaurant_id = $1)`, [only]);
  for (const payment of payments) {
    const list = (byRestaurant.get(payment.restaurant_id) ?? []).filter((e) => e.payment_id === payment.id);
    if (list.filter((e) => e.event === 'payment_recorded').length !== 1) {
      add('payment-ledgered', payment.restaurant_id, `payment ${payment.id}: no single payment_recorded entry`);
    }
    if (payment.reversed && list.filter((e) => e.event === 'payment_reversed').length !== 1) {
      add('payment-ledgered', payment.restaurant_id, `payment ${payment.id}: reversal not ledgered`);
    }
  }

  return {
    ok: findings.length === 0,
    restaurants: byRestaurant.size,
    entries: entries.length,
    issuedBills: bills.length,
    findings,
  };
}
