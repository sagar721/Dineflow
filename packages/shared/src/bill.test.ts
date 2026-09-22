// Bill arithmetic (FR-073, FR-075, FR-082, BR-BILL-04/05): worked examples and
// property tests over random inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BillError, billIdentityHolds, canonicalBillText, computeBill, type BillInput } from './bill.ts';

const base: BillInput = {
  lines: [], pricesIncludeTax: false, taxes: [], serviceChargeBps: 0, discount: null, roundingMode: 'none',
};

test('the PRD worked example: 2 × ₹100 and 1 × ₹50 at 5 % exclusive is ₹262.50 (US-08)', () => {
  const bill = computeBill({
    ...base, lines: [{ unitPriceMinor: 10_000, quantity: 2 }, { unitPriceMinor: 5_000, quantity: 1 }],
    taxes: [{ name: 'GST', rateBps: 500 }],
  });
  assert.equal(bill.subtotalMinor, 25_000);
  assert.equal(bill.taxTotalMinor, 1_250);
  assert.equal(bill.totalMinor, 26_250);
});

test('exclusive tax with several components applies each to the base', () => {
  const bill = computeBill({
    ...base, lines: [{ unitPriceMinor: 33_333, quantity: 1 }],
    taxes: [{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }],
  });
  assert.deepEqual(bill.taxes.map((t) => t.amountMinor), [833, 833]); // 833.325 rounds half-up to 833
  assert.equal(bill.totalMinor, 33_333 + 1_666);
});

test('inclusive tax extracts the combined rate once, remainder on the last component', () => {
  const bill = computeBill({
    ...base, pricesIncludeTax: true, lines: [{ unitPriceMinor: 10_500, quantity: 1 }],
    taxes: [{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }],
  });
  assert.equal(bill.taxes[0]!.taxableMinor, 10_000);
  assert.deepEqual(bill.taxes.map((t) => t.amountMinor), [250, 250]);
  assert.equal(bill.totalMinor, 10_500, 'inclusive tax never changes the total');
});

test('inclusive tax with an awkward split still adds up exactly', () => {
  const bill = computeBill({
    ...base, pricesIncludeTax: true, lines: [{ unitPriceMinor: 999, quantity: 1 }],
    taxes: [{ name: 'A', rateBps: 300 }, { name: 'B', rateBps: 300 }, { name: 'C', rateBps: 300 }],
  });
  const taxable = bill.taxes[0]!.taxableMinor;
  assert.equal(taxable + bill.taxTotalMinor, 999);
});

test('discounts: percentage and fixed, never above the subtotal', () => {
  const lines = [{ unitPriceMinor: 10_000, quantity: 1 }];
  assert.equal(computeBill({ ...base, lines, discount: { type: 'percent', value: 1_250 } }).discountMinor, 1_250);
  assert.equal(computeBill({ ...base, lines, discount: { type: 'fixed', value: 3_000 } }).discountMinor, 3_000);
  assert.equal(computeBill({ ...base, lines, discount: { type: 'fixed', value: 10_000 } }).totalMinor, 0);
  assert.throws(() => computeBill({ ...base, lines, discount: { type: 'fixed', value: 10_001 } }), BillError);
  assert.throws(() => computeBill({ ...base, lines, discount: { type: 'percent', value: 10_001 } }), BillError);
});

test('tax and service charge are on the post-discount base; service charge is not taxed', () => {
  const bill = computeBill({
    ...base, lines: [{ unitPriceMinor: 20_000, quantity: 1 }], discount: { type: 'fixed', value: 10_000 },
    serviceChargeBps: 1_000, taxes: [{ name: 'GST', rateBps: 500 }],
  });
  assert.equal(bill.serviceChargeMinor, 1_000);
  assert.equal(bill.taxTotalMinor, 500, 'tax on the 100.00 base, not on base + service');
  assert.equal(bill.totalMinor, 11_500);
});

test('rounding to 0.50 and to 1.00, half up, shown as its own line', () => {
  const lines = [{ unitPriceMinor: 12_324, quantity: 1 }];
  const fifty = computeBill({ ...base, lines, roundingMode: 'nearest_50' });
  assert.deepEqual([fifty.totalMinor, fifty.roundingMinor], [12_300, -24]);
  const one = computeBill({ ...base, lines: [{ unitPriceMinor: 12_350, quantity: 1 }], roundingMode: 'nearest_1' });
  assert.deepEqual([one.totalMinor, one.roundingMinor], [12_400, 50]);
});

test('invalid input is refused', () => {
  for (const bad of [
    { ...base, lines: [{ unitPriceMinor: -1, quantity: 1 }] },
    { ...base, lines: [{ unitPriceMinor: 1.5, quantity: 1 }] },
    { ...base, lines: [{ unitPriceMinor: 1, quantity: 0 }] },
    { ...base, taxes: [{ name: 'X', rateBps: 10_001 }] },
  ]) assert.throws(() => computeBill(bad), BillError);
});

test('property: for random bills the stored identity holds and money stays whole', () => {
  let seed = 42;
  const rand = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed % n; };
  for (let i = 0; i < 5_000; i += 1) {
    const lines = Array.from({ length: 1 + rand(6) }, () => ({ unitPriceMinor: rand(200_000), quantity: 1 + rand(20) }));
    const subtotal = lines.reduce((t, l) => t + l.unitPriceMinor * l.quantity, 0);
    const input: BillInput = {
      lines, pricesIncludeTax: rand(2) === 1,
      taxes: Array.from({ length: rand(4) }, (_, k) => ({ name: `T${k}`, rateBps: rand(2_800) })),
      serviceChargeBps: rand(3) === 0 ? rand(1_500) : 0,
      discount: rand(3) === 0 ? (rand(2) ? { type: 'percent', value: rand(10_001) } : { type: 'fixed', value: rand(subtotal + 1) }) : null,
      roundingMode: (['none', 'nearest_50', 'nearest_1'] as const)[rand(3)]!,
    };
    const t = computeBill(input);
    assert.ok(billIdentityHolds(t, input.pricesIncludeTax), `identity, case ${i}`);
    for (const value of [t.subtotalMinor, t.discountMinor, t.serviceChargeMinor, t.taxTotalMinor, t.totalMinor, t.roundingMinor]) {
      assert.ok(Number.isSafeInteger(value), `whole minor units, case ${i}`);
    }
    assert.ok(t.discountMinor <= t.subtotalMinor && t.totalMinor >= 0);
    if (input.pricesIncludeTax && t.taxes.length) assert.equal(t.taxes[0]!.taxableMinor + t.taxTotalMinor, t.baseMinor);
    const step = input.roundingMode === 'nearest_50' ? 50 : input.roundingMode === 'nearest_1' ? 100 : 1;
    assert.equal(t.totalMinor % step, 0);
    assert.ok(Math.abs(t.roundingMinor) <= step / 2);
  }
});

test('the canonical text is stable and changes when any amount changes', () => {
  const bill = {
    restaurantId: 'r', billNo: 7, billRef: '7', series: 'main', currency: 'INR', pricesIncludeTax: false,
    issuer: { name: 'Cafe', phone: null, address: 'X' }, tableNumber: '4', orderRefs: ['12', '10'],
    lines: [{ name: 'Tea', quantity: 2, unitPriceMinor: 3_000, lineTotalMinor: 6_000 }],
    taxes: [{ name: 'GST', rateBps: 500, taxableMinor: 6_000, amountMinor: 300 }],
    subtotalMinor: 6_000, discountType: null, discountValue: null, discountMinor: 0, discountReason: null,
    serviceChargeBps: 0, serviceChargeMinor: 0, taxTotalMinor: 300, roundingMode: 'none' as const, roundingMinor: 0, totalMinor: 6_300,
  };
  const text = canonicalBillText(bill);
  assert.equal(canonicalBillText({ ...bill, issuer: { address: 'X', phone: null, name: 'Cafe' }, orderRefs: ['10', '12'] }), text,
    'key and list order do not matter');
  assert.notEqual(canonicalBillText({ ...bill, totalMinor: 6_301 }), text);
});
