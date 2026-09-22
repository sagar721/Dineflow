// Order-screen rules (FR-053, FR-056): run with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsFor, elapsedLabel, groupForKitchen, isLate, unannounced } from './board.ts';

const kinds = (role: Parameters<typeof actionsFor>[0], status: Parameters<typeof actionsFor>[1]) =>
  actionsFor(role, status).map((action) => `${action.kind}:${action.to}`);

test('kitchen staff get the kitchen steps and early cancel, nothing else', () => {
  assert.deepEqual(kinds('kitchen', 'pending'), ['advance:accepted', 'cancel:cancelled']);
  assert.deepEqual(kinds('kitchen', 'accepted'), ['advance:preparing', 'cancel:cancelled']);
  assert.deepEqual(kinds('kitchen', 'preparing'), ['advance:ready'], 'no cancel once preparing');
  assert.deepEqual(kinds('kitchen', 'ready'), [], 'kitchen does not serve');
});

test('billing staff only serve', () => {
  assert.deepEqual(kinds('billing', 'pending'), []);
  assert.deepEqual(kinds('billing', 'ready'), ['advance:served']);
});

test('owners and managers advance, cancel and revert one step', () => {
  assert.deepEqual(kinds('manager', 'preparing'), ['advance:ready', 'cancel:cancelled', 'revert:accepted']);
  assert.deepEqual(kinds('owner', 'served'), ['revert:ready']);
  assert.deepEqual(kinds('owner', 'pending'), ['advance:accepted', 'cancel:cancelled'], 'nothing to revert to');
});

test('finished orders offer nothing but the permitted revert', () => {
  assert.deepEqual(kinds('kitchen', 'served'), []);
  for (const role of ['owner', 'manager', 'kitchen', 'billing'] as const) {
    assert.deepEqual(kinds(role, 'cancelled'), [], `${role}: cancelled is final`);
  }
});

test('cancel and revert always ask for a reason', () => {
  for (const action of actionsFor('owner', 'accepted')) {
    assert.equal(action.needsReason, action.kind !== 'advance');
  }
});

test('the kitchen board groups active orders by status, oldest first', () => {
  const orders = [
    { id: 'b', status: 'pending' as const, placedAt: '2026-09-22T10:05:00Z' },
    { id: 'a', status: 'pending' as const, placedAt: '2026-09-22T10:00:00Z' },
    { id: 'c', status: 'ready' as const, placedAt: '2026-09-22T09:00:00Z' },
    { id: 'd', status: 'served' as const, placedAt: '2026-09-22T08:00:00Z' },
  ];
  const board = groupForKitchen(orders);
  assert.deepEqual(board.pending.map((o) => o.id), ['a', 'b']);
  assert.deepEqual(board.ready.map((o) => o.id), ['c']);
  assert.deepEqual(board.accepted, []);
  assert.equal(Object.values(board).flat().some((o) => o.id === 'd'), false, 'served orders leave the board');
});

test('elapsed time reads naturally and late orders are flagged', () => {
  const start = Date.parse('2026-09-22T10:00:00Z');
  assert.equal(elapsedLabel('2026-09-22T10:00:00Z', start + 20_000), 'Just now');
  assert.equal(elapsedLabel('2026-09-22T10:00:00Z', start + 7 * 60_000), '7 min');
  assert.equal(elapsedLabel('2026-09-22T10:00:00Z', start + 65 * 60_000), '1 h 05 min');
  assert.equal(isLate('2026-09-22T10:00:00Z', start + 14 * 60_000), false);
  assert.equal(isLate('2026-09-22T10:00:00Z', start + 15 * 60_000), true);
});

test('each new order is announced once', () => {
  const announced = new Set(['a']);
  assert.deepEqual(unannounced([{ id: 'a' }, { id: 'b' }], announced).map((o) => o.id), ['b']);
});
