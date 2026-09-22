// Cart rules (FR-032, FR-035): run with `node --test`, no browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addOne, browsingSubtotal, CART_TTL_MS, EMPTY_CART, parseCart, quantityOf, reconcile, removeLine,
  serializeCart, setNote, setQuantity, toRequestItems, totalQuantity, type Cart, type MenuEntry,
} from './cart.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tea: MenuEntry = { id: ID(1), available: true, priceMinor: 3000 };
const dosa: MenuEntry = { id: ID(2), available: true, priceMinor: 12050 };
const soldOut: MenuEntry = { id: ID(3), available: false, priceMinor: 9900 };
const limits = { maxQtyPerLine: 5, maxItemsPerOrder: 8 };
const menu = new Map([tea, dosa, soldOut].map((item) => [item.id, item]));

test('adding, increasing, decreasing and removing items', () => {
  let cart = addOne(EMPTY_CART, tea, limits);
  cart = addOne(cart, tea, limits);
  cart = addOne(cart, dosa, limits);
  assert.equal(quantityOf(cart, tea.id), 2);
  assert.equal(totalQuantity(cart), 3);

  cart = setQuantity(cart, tea.id, 1, limits);
  assert.equal(quantityOf(cart, tea.id), 1);
  cart = setQuantity(cart, tea.id, 0, limits);
  assert.equal(quantityOf(cart, tea.id), 0, 'zero removes the line');
  cart = removeLine(cart, dosa.id);
  assert.deepEqual(cart.lines, []);
});

test('a sold-out item cannot be added', () => {
  assert.equal(addOne(EMPTY_CART, soldOut, limits), EMPTY_CART);
});

test('quantities are whole numbers within the per-item and per-order limits', () => {
  let cart = addOne(EMPTY_CART, tea, limits);
  for (let i = 0; i < 10; i += 1) cart = addOne(cart, tea, limits);
  assert.equal(quantityOf(cart, tea.id), 5, 'per-item limit');
  assert.equal(setQuantity(cart, tea.id, 2.5, limits), cart, 'fractions are ignored');
  assert.equal(quantityOf(setQuantity(cart, tea.id, -3, limits), tea.id), 0, 'negative removes');
  cart = setQuantity(addOne(cart, dosa, limits), dosa.id, 99, limits);
  assert.equal(totalQuantity(cart), 8, 'per-order limit');
  assert.equal(addOne(cart, dosa, limits), cart, 'nothing more fits');
});

test('prices while browsing are integer minor units', () => {
  let cart = setQuantity(addOne(EMPTY_CART, dosa, limits), dosa.id, 3, limits);
  cart = addOne(cart, tea, limits);
  assert.equal(browsingSubtotal(cart, menu), 3 * 12050 + 3000);
});

test('the request carries choices only, never a price', () => {
  const cart = setNote(addOne(EMPTY_CART, tea, limits), tea.id, '  no sugar ');
  assert.deepEqual(toRequestItems(cart), [{ menuItemId: tea.id, quantity: 1, note: 'no sugar' }]);
  assert.equal(JSON.stringify(toRequestItems(addOne(EMPTY_CART, dosa, limits))).includes('price'), false);
});

test('any change to the cart drops its idempotency key; nothing else does', () => {
  const keyed: Cart = { ...addOne(EMPTY_CART, tea, limits), idempotencyKey: ID(9) };
  assert.equal(addOne(keyed, tea, limits).idempotencyKey, null);
  assert.equal(removeLine(keyed, tea.id).idempotencyKey, null);
  assert.equal(setNote(keyed, tea.id, 'x').idempotencyKey, null);
  assert.equal(removeLine(keyed, dosa.id), keyed, 'removing something absent changes nothing');
});

test('reconciling with the current menu drops sold-out and vanished items and clamps quantities', () => {
  const stale: Cart = {
    lines: [
      { menuItemId: tea.id, quantity: 7, note: '' },
      { menuItemId: soldOut.id, quantity: 1, note: '' },
      { menuItemId: ID(404), quantity: 1, note: '' },
    ],
    idempotencyKey: ID(9),
  };
  const { cart, dropped } = reconcile(stale, menu, limits);
  assert.equal(dropped, 2);
  assert.deepEqual(cart.lines, [{ menuItemId: tea.id, quantity: 5, note: '' }]);
  assert.equal(cart.idempotencyKey, null);

  const fine = addOne(EMPTY_CART, tea, limits);
  assert.equal(reconcile(fine, menu, limits).cart, fine, 'an unchanged cart keeps its identity');
});

test('the saved cart survives a reload, and anything malformed or old is discarded', () => {
  const cart: Cart = { ...addOne(EMPTY_CART, tea, limits), idempotencyKey: ID(9) };
  assert.deepEqual(parseCart(serializeCart(cart, 1000), 2000), cart);
  assert.deepEqual(parseCart(serializeCart(cart, 0), CART_TTL_MS + 1), EMPTY_CART, 'expired');
  for (const raw of [null, '', 'not json', '{"v":2}', '{"v":1,"savedAt":0,"lines":"x"}']) {
    assert.deepEqual(parseCart(raw, 0), EMPTY_CART, String(raw));
  }
  const tampered = JSON.stringify({ v: 1, savedAt: 0, idempotencyKey: 'x', lines: [
    { menuItemId: tea.id, quantity: 2, priceMinor: 1 },
    { menuItemId: tea.id, quantity: 3 },
    { menuItemId: 'bad', quantity: 1 },
    { menuItemId: dosa.id, quantity: 1000 },
    { menuItemId: soldOut.id, quantity: -1 },
  ] });
  const parsed = parseCart(tampered, 0);
  assert.deepEqual(parsed.lines, [{ menuItemId: tea.id, quantity: 2, note: '' }], 'only valid, unique lines; no price kept');
  assert.equal(parsed.idempotencyKey, null);
});
