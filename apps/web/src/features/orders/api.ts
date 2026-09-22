// Calls for the staff order screens. Every call goes through apiFetch (session
// cookie + CSRF header); the restaurant is always the signed-in member's own.
import type { Currency, OrderStatus, StaffRole } from '@dineflow/shared';
import { apiFetch } from '@/lib/api.ts';

export type OrderSummary = {
  id: string; ref: string; number: number; status: OrderStatus; placedAt: string; statusUpdatedAt: string;
  subtotalMinor: number; itemCount: number; version: number;
  table: { id: string; tableNumber: string; name: string | null };
  items: { name: string; quantity: number; note: string | null }[];
  specialInstructions: string | null; staffNote: string | null; cancelReason: string | null;
};

export type OrderDetail = OrderSummary & {
  lines: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number; note: string | null }[];
  history: { from: OrderStatus | null; to: OrderStatus; byRole: StaffRole | null; reason: string | null; at: string }[];
  /** Present only for roles allowed contact details; null when the customer gave none. */
  contact?: { mobile: string | null; email: string | null } | null;
  /** Present only for roles that work with bills: the live bill this order is on, if any. */
  bill?: { id: string; status: 'draft' | 'finalized'; ref: string | null } | null;
  timezone: string;
  currency: Currency;
};

export type OrderPage = { orders: OrderSummary[]; nextCursor: string | null; truncated: boolean; timezone: string; currency: Currency };

export type OrderFilters = { status?: string; table?: string; from?: string; to?: string; q?: string };

export type LiveUpdate = {
  cursor: string;
  changes: { id: string; version: number }[];
  newOrders: { id: string; ref: string; tableNumber: string }[];
};

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const ordersApi = {
  list: (filters: OrderFilters, cursor?: string) =>
    apiFetch<OrderPage>(`/restaurant/orders${query({ ...filters, cursor })}`),
  kitchen: () => apiFetch<OrderPage>('/restaurant/orders?view=kitchen'),
  detail: (id: string) => apiFetch<{ order: OrderDetail }>(`/restaurant/orders/${id}`),
  live: (since?: string) => apiFetch<LiveUpdate>(`/restaurant/orders/live${query({ since })}`),
  setStatus: (id: string, to: OrderStatus, version: number, reason?: string) =>
    apiFetch<{ order: OrderDetail }>(`/restaurant/orders/${id}/status`,
      { method: 'POST', body: { to, version, ...(reason ? { reason } : {}) } }),
  revert: (id: string, version: number, reason: string) =>
    apiFetch<{ order: OrderDetail }>(`/restaurant/orders/${id}/revert`, { method: 'POST', body: { version, reason } }),
  setNote: (id: string, note: string | null, version: number) =>
    apiFetch<{ order: OrderDetail }>(`/restaurant/orders/${id}/staff-note`, { method: 'PATCH', body: { note, version } }),
};

/** A time in the restaurant's own timezone (NFR-D05), e.g. "7:42 pm". */
export const timeIn = (iso: string, timezone: string) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
export const dateTimeIn = (iso: string, timezone: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: timezone });
