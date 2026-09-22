import test from 'node:test';
import assert from 'node:assert/strict';
import { billActions, billState, parseDiscount, previewDiscount, rateLabel } from './logic.ts';
import type { Bill } from './api.ts';

test('actions by role and state', () => {
  const draft = { status: 'draft', paymentStatus: null } as const;
  const unpaid = { status: 'finalized', paymentStatus: 'unpaid' } as const;
  const paid = { status: 'finalized', paymentStatus: 'paid' } as const;
  const voided = { status: 'void', paymentStatus: null } as const;
  assert.deepEqual(billActions('owner', draft), ['discount', 'finalize', 'discard']);
  assert.deepEqual(billActions('billing', draft), ['finalize', 'discard'], 'billing staff give no discounts');
  assert.deepEqual(billActions('billing', unpaid), ['pay']);
  assert.deepEqual(billActions('manager', unpaid), ['pay', 'void']);
  assert.deepEqual(billActions('billing', paid), []);
  assert.deepEqual(billActions('manager', paid), ['reverse']);
  assert.deepEqual(billActions('owner', voided), []);
  assert.deepEqual(billActions('kitchen', unpaid), []);
});

test('state labels', () => {
  assert.equal(billState({ status: 'finalized', paymentStatus: 'paid' }).label, 'Paid');
  assert.equal(billState({ status: 'finalized', paymentStatus: 'unpaid' }).tone, 'warning');
  assert.equal(billState({ status: 'void', paymentStatus: null }).label, 'Void');
});

test('discount input becomes basis points or minor units', () => {
  assert.deepEqual(parseDiscount({ type: 'percent', text: '12.5' }, 'INR'), { value: 1250 });
  assert.deepEqual(parseDiscount({ type: 'percent', text: '100' }, 'INR'), { value: 10_000 });
  assert.ok('error' in parseDiscount({ type: 'percent', text: '100.01' }, 'INR'));
  assert.ok('error' in parseDiscount({ type: 'percent', text: '0' }, 'INR'));
  assert.ok('error' in parseDiscount({ type: 'percent', text: 'ten' }, 'INR'));
  assert.deepEqual(parseDiscount({ type: 'fixed', text: '49.50' }, 'INR'), { value: 4950 });
  assert.ok('error' in parseDiscount({ type: 'fixed', text: '' }, 'INR'));
  assert.ok('error' in parseDiscount({ type: 'fixed', text: '1.234' }, 'INR'));
});

test('the preview uses the bill’s own snapshot', () => {
  const bill = {
    lines: [{ name: 'Tea', quantity: 2, unitPriceMinor: 10_000, lineTotalMinor: 20_000 }],
    pricesIncludeTax: false, taxes: [{ name: 'GST', rateBps: 500, taxableMinor: 20_000, amountMinor: 1_000 }],
    serviceChargeBps: 0, roundingMode: 'none',
  } as unknown as Bill;
  const preview = previewDiscount(bill, { type: 'percent', value: 1_000 });
  assert.equal(preview.discountMinor, 2_000);
  assert.equal(preview.totalMinor, 18_900);
});

test('rate labels', () => {
  assert.equal(rateLabel(500), '5 %');
  assert.equal(rateLabel(250), '2.5 %');
  assert.equal(rateLabel(1_800), '18 %');
});
