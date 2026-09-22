// Calls and on-device storage for the customer's side: menu, quote, order, status.
import type { Currency } from '@dineflow/shared';
import { apiFetch } from '@/lib/api.ts';
import type { Diet } from '@/features/menu/api.ts';
import { EMPTY_CART, parseCart, serializeCart, toRequestItems, type Cart } from './cart.ts';

export type ContactPolicy = 'off' | 'optional' | 'require_mobile' | 'require_email' | 'require_both';

export type PublicItem = {
  id: string; name: string; description: string | null; priceMinor: number;
  imageUrl: string | null; diet: Diet; available: boolean;
};

export type PublicMenu = {
  restaurant: { name: string; brandColor: string | null; acceptingOrders: boolean; currency: Currency };
  table: { tableNumber: string; name: string | null };
  ordering: { contactPolicy: ContactPolicy; maxQtyPerLine: number; maxItemsPerOrder: number };
  categories: { id: string; name: string; items: PublicItem[] }[];
};

export type Quote = {
  currency: Currency; acceptingOrders: boolean; subtotalMinor: number;
  items: { menuItemId: string; name: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number; note: string | null }[];
};

export type PlacedOrder = {
  ref: string; number: number; status: string; placedAt: string;
  restaurant: { name: string | null; currency: Currency | null };
  table?: { tableNumber: string; name: string | null };
  items: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; note: string | null }[];
  subtotalMinor: number; specialInstructions: string | null;
};

export type Contact = { mobile?: string; email?: string };

const tablePath = (token: string) => `/public/tables/${encodeURIComponent(token)}`;

export const orderApi = {
  menu: (token: string) => apiFetch<PublicMenu>(`${tablePath(token)}/menu`),
  quote: (token: string, cart: Cart) =>
    apiFetch<Quote>(`${tablePath(token)}/quote`, { method: 'POST', body: { items: toRequestItems(cart) } }),
  place: (token: string, cart: Cart, idempotencyKey: string, extra: { specialInstructions?: string; contact?: Contact }) =>
    apiFetch<{ order: PlacedOrder; statusToken: string; replayed: boolean }>(`${tablePath(token)}/orders`, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: { items: toRequestItems(cart), ...extra },
    }),
  status: (statusToken: string) =>
    apiFetch<{ order: PlacedOrder }>(`/public/orders/${encodeURIComponent(statusToken)}`),
};

// --------------------------------------------------------------- device storage
// Browsers can refuse storage (private mode, full disk): every access is guarded,
// and the app works without it — only the cart stops surviving a reload.
const read = (key: string): string | null => {
  try { return window.localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* storage unavailable: the cart simply is not kept */ }
};

// Keyed by a short fingerprint of the QR token, not the token itself.
const cartKey = (token: string) => {
  let hash = 0;
  for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `dineflow:cart:v1:${(hash >>> 0).toString(36)}`;
};

export const loadCart = (token: string): Cart => (typeof window === 'undefined' ? EMPTY_CART : parseCart(read(cartKey(token))));
export const saveCart = (token: string, cart: Cart) => write(cartKey(token), cart.lines.length ? serializeCart(cart) : null);

/** Orders placed from this device, newest first, so the customer can find them again (FR-042). */
export type MyOrder = { statusToken: string; ref: string; placedAt: string; tableToken: string };
const ORDERS_KEY = 'dineflow:orders:v1';

export function loadMyOrders(): MyOrder[] {
  try {
    const parsed = JSON.parse(read(ORDERS_KEY) ?? '[]') as MyOrder[];
    return Array.isArray(parsed)
      ? parsed.filter((each) => typeof each?.statusToken === 'string' && /^[A-Za-z0-9_-]{22}$/.test(each.statusToken)).slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

export function rememberOrder(order: MyOrder) {
  const rest = loadMyOrders().filter((each) => each.statusToken !== order.statusToken);
  write(ORDERS_KEY, JSON.stringify([order, ...rest].slice(0, 20)));
}
