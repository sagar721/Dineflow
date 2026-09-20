import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBps, formatMoney, MoneyError, parseMoney, roundHalfUp, sumMinor } from './money.ts';

test('formats minor units without floating point drift', () => {
  assert.equal(formatMoney(24950, 'INR').replace(/ /g, ' '), '₹249.50');
  assert.equal(formatMoney(0, 'INR').replace(/ /g, ' '), '₹0.00');
  // 0.1 + 0.2 in floats is 0.30000000000000004; in minor units it is simply 30.
  assert.equal(formatMoney(sumMinor([10, 20]), 'INR').replace(/ /g, ' '), '₹0.30');
});

test('rejects non-integer amounts rather than rounding silently', () => {
  assert.throws(() => formatMoney(249.5, 'INR'), MoneyError);
});

test('parses typed input into minor units', () => {
  assert.equal(parseMoney('249.50', 'INR'), 24950);
  assert.equal(parseMoney('249.5', 'INR'), 24950);
  assert.equal(parseMoney('1,249', 'INR'), 124900);
  assert.throws(() => parseMoney('249.505', 'INR'), MoneyError);
  assert.throws(() => parseMoney('abc', 'INR'), MoneyError);
});

test('rounds half up, symmetrically for negatives', () => {
  assert.equal(roundHalfUp(2.5), 3);
  assert.equal(roundHalfUp(2.4), 2);
  assert.equal(roundHalfUp(-2.5), -3);
});

test('applies tax rates in basis points', () => {
  assert.equal(applyBps(25000, 500), 1250);        // 5% of 250.00 = 12.50
  assert.equal(applyBps(9999, 1800), 1800);        // 18% of 99.99 = 17.998 -> 18.00
  assert.throws(() => applyBps(100, 10_001), MoneyError);
});
