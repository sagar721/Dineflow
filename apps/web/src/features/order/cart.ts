// The customer's cart (FR-032, FR-035). Pure functions, no React, no imports from
// the app, so the rules are unit-tested directly.
//
// The cart is a list of choices only — item ids, quantities and notes. Prices shown
// while browsing come from the menu the server sent; the review screen asks the
// server to price the cart, and the server prices it again when the order is
// placed. Nothing here is ever sent as a price.

export type CartLine = { menuItemId: string; quantity: number; note: string };

export type Cart = {
  lines: CartLine[];
  /**
   * The Idempotency-Key for placing this exact cart. Made on the first attempt and
   * kept through retries and reloads, so a lost response never makes a second
   * order; cleared whenever the cart changes, since a different cart is a
   * different order.
   */
  idempotencyKey: string | null;
};

export type Limits = { maxQtyPerLine: number; maxItemsPerOrder: number };

/** What the cart needs to know about a menu item. */
export type MenuEntry = { id: string; available: boolean; priceMinor: number };

export const EMPTY_CART: Cart = { lines: [], idempotencyKey: null };
export const MAX_NOTE = 200;

const changed = (lines: CartLine[]): Cart => ({ lines, idempotencyKey: null });

export function quantityOf(cart: Cart, menuItemId: string): number {
  return cart.lines.find((line) => line.menuItemId === menuItemId)?.quantity ?? 0;
}

export function totalQuantity(cart: Cart): number {
  return cart.lines.reduce((total, line) => total + line.quantity, 0);
}

/**
 * Adds one of an item. Refused (the cart comes back unchanged) for a sold-out
 * item, or past the per-item or per-order limit.
 */
export function addOne(cart: Cart, item: MenuEntry, limits: Limits): Cart {
  if (!item.available) return cart;
  if (totalQuantity(cart) >= limits.maxItemsPerOrder) return cart;
  const current = quantityOf(cart, item.id);
  if (current >= limits.maxQtyPerLine) return cart;
  return current === 0
    ? changed([...cart.lines, { menuItemId: item.id, quantity: 1, note: '' }])
    : setQuantity(cart, item.id, current + 1, limits);
}

/** Sets a line's quantity; 0 or less removes the line. Clamped to the limits. */
export function setQuantity(cart: Cart, menuItemId: string, quantity: number, limits: Limits): Cart {
  if (!Number.isInteger(quantity)) return cart;
  if (quantity <= 0) return removeLine(cart, menuItemId);
  const others = totalQuantity(cart) - quantityOf(cart, menuItemId);
  const allowed = Math.min(quantity, limits.maxQtyPerLine, limits.maxItemsPerOrder - others);
  if (allowed <= 0 || allowed === quantityOf(cart, menuItemId)) return cart;
  return changed(cart.lines.map((line) => (line.menuItemId === menuItemId ? { ...line, quantity: allowed } : line)));
}

export function removeLine(cart: Cart, menuItemId: string): Cart {
  if (!cart.lines.some((line) => line.menuItemId === menuItemId)) return cart;
  return changed(cart.lines.filter((line) => line.menuItemId !== menuItemId));
}

export function setNote(cart: Cart, menuItemId: string, note: string): Cart {
  const trimmed = note.slice(0, MAX_NOTE);
  return changed(cart.lines.map((line) => (line.menuItemId === menuItemId ? { ...line, note: trimmed } : line)));
}

/** The estimate shown while browsing, in minor units (integers only). */
export function browsingSubtotal(cart: Cart, menu: ReadonlyMap<string, MenuEntry>): number {
  return cart.lines.reduce((total, line) => total + (menu.get(line.menuItemId)?.priceMinor ?? 0) * line.quantity, 0);
}

/**
 * Brings a cart back in line with the current menu: lines for items no longer on
 * it or sold out are dropped, and quantities are clamped to today's limits. Says
 * whether anything was dropped, so the customer can be told.
 */
export function reconcile(cart: Cart, menu: ReadonlyMap<string, MenuEntry>, limits: Limits): { cart: Cart; dropped: number } {
  let lines = cart.lines.filter((line) => menu.get(line.menuItemId)?.available);
  const dropped = cart.lines.length - lines.length;
  let remaining = limits.maxItemsPerOrder;
  lines = lines
    .map((line) => {
      const quantity = Math.max(0, Math.min(line.quantity, limits.maxQtyPerLine, remaining));
      remaining -= quantity;
      return { ...line, quantity };
    })
    .filter((line) => line.quantity > 0);
  const same = dropped === 0 && lines.length === cart.lines.length
    && lines.every((line, index) => line.quantity === cart.lines[index]!.quantity);
  return { cart: same ? cart : changed(lines), dropped };
}

/** The body for the quote and order endpoints: choices only, no prices. */
export function toRequestItems(cart: Cart) {
  return cart.lines.map((line) => ({
    menuItemId: line.menuItemId,
    quantity: line.quantity,
    ...(line.note.trim() ? { note: line.note.trim() } : {}),
  }));
}

// ---------------------------------------------------------------- persistence
// Kept on this device only (FR-035), per table, for a limited time. Anything
// unreadable is discarded rather than trusted.
const VERSION = 1;
export const CART_TTL_MS = 12 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function serializeCart(cart: Cart, now = Date.now()): string {
  return JSON.stringify({ v: VERSION, savedAt: now, lines: cart.lines, idempotencyKey: cart.idempotencyKey });
}

export function parseCart(raw: string | null, now = Date.now()): Cart {
  if (!raw) return EMPTY_CART;
  try {
    const data = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; lines?: unknown; idempotencyKey?: unknown };
    if (data.v !== VERSION || typeof data.savedAt !== 'number' || now - data.savedAt > CART_TTL_MS) return EMPTY_CART;
    if (!Array.isArray(data.lines) || data.lines.length > 200) return EMPTY_CART;
    const seen = new Set<string>();
    const lines: CartLine[] = [];
    for (const each of data.lines as Record<string, unknown>[]) {
      const id = each?.menuItemId;
      const quantity = each?.quantity;
      if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) continue;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) continue;
      seen.add(id);
      lines.push({ menuItemId: id, quantity, note: typeof each.note === 'string' ? each.note.slice(0, MAX_NOTE) : '' });
    }
    const key = typeof data.idempotencyKey === 'string' && UUID.test(data.idempotencyKey) ? data.idempotencyKey : null;
    return { lines, idempotencyKey: lines.length ? key : null };
  } catch {
    return EMPTY_CART;
  }
}
