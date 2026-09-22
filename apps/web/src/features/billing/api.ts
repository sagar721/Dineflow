// Calls for the billing screens. Every call goes through apiFetch (session cookie +
// CSRF header); the restaurant is always the signed-in member's own.
import type { Currency, DiscountType, RoundingMode } from '@dineflow/shared';
import { apiFetch, apiFetchBlob } from '@/lib/api.ts';

export type BillStatus = 'draft' | 'finalized' | 'void';
export type PaymentMethod = 'cash' | 'card' | 'upi' | 'other';

export type Payment = {
  id: string; method: PaymentMethod; amountMinor: number; reference: string | null;
  recordedAt: string; recordedBy: string | null;
  reversedAt: string | null; reversedBy: string | null; reversalReason: string | null;
};

export type Bill = {
  id: string; status: BillStatus; paymentStatus: 'paid' | 'unpaid' | null;
  series: string; number: number | null; ref: string | null;
  table: { id: string; tableNumber: string; name: string | null };
  orders: { id: string; ref: string; status: string; released: boolean }[];
  currency: Currency; pricesIncludeTax: boolean; serviceChargeBps: number; roundingMode: RoundingMode;
  lines: { name: string; quantity: number; unitPriceMinor: number; lineTotalMinor: number }[];
  taxes: { name: string; rateBps: number; taxableMinor: number; amountMinor: number }[];
  subtotalMinor: number;
  discount: { type: DiscountType; value: number; reason: string | null } | null;
  discountMinor: number; serviceChargeMinor: number; taxTotalMinor: number; roundingMinor: number; totalMinor: number;
  issuer: {
    name?: string; addressLines?: string[]; phone?: string | null; email?: string | null;
    taxRegistrationNo?: string | null; footer?: string | null;
  };
  contentHash: string | null;
  createdAt: string; createdBy: string | null;
  finalizedAt: string | null; finalizedBy: string | null;
  voidedAt: string | null; voidedBy: string | null; voidReason: string | null;
  payments: Payment[];
  version: number;
};

export type BillSummary = {
  id: string; status: BillStatus; ref: string | null; totalMinor: number; tableNumber: string; orderRefs: string[];
  createdAt: string; finalizedAt: string | null; paymentStatus: 'paid' | 'unpaid' | null; version: number;
};

export type BillPage = { bills: BillSummary[]; nextCursor: string | null; timezone: string; currency: Currency };
export type BillFilters = { status?: BillStatus; payment?: 'paid' | 'unpaid'; q?: string; from?: string; to?: string };

export type BillableTable = { id: string; tableNumber: string; name: string | null; orderCount: number; subtotalMinor: number };
export type BillableOrder = {
  id: string; ref: string; status: string; placedAt: string; subtotalMinor: number; items: { name: string; quantity: number }[];
};

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const billingApi = {
  list: (filters: BillFilters, cursor?: string) => apiFetch<BillPage>(`/restaurant/bills${query({ ...filters, cursor })}`),
  billableTables: () => apiFetch<{ currency: Currency; tables: BillableTable[] }>('/restaurant/bills/billable'),
  billableOrders: (tableId: string) =>
    apiFetch<{ currency: Currency; orders: BillableOrder[] }>(`/restaurant/bills/billable${query({ table: tableId })}`),
  detail: (id: string) => apiFetch<{ bill: Bill }>(`/restaurant/bills/${id}`),
  create: (orderIds: string[]) => apiFetch<{ bill: Bill }>('/restaurant/bills', { method: 'POST', body: { orderIds } }),
  discount: (id: string, body: { type: DiscountType; value: number; reason: string } | { type: null }, version: number) =>
    apiFetch<{ bill: Bill }>(`/restaurant/bills/${id}/discount`, { method: 'PATCH', body: { ...body, version } }),
  discard: (id: string) => apiFetch<void>(`/restaurant/bills/${id}`, { method: 'DELETE' }),
  finalize: (id: string, version: number) =>
    apiFetch<{ bill: Bill; repeated: boolean }>(`/restaurant/bills/${id}/finalize`, { method: 'POST', body: { version } }),
  void: (id: string, reason: string, version: number) =>
    apiFetch<{ bill: Bill }>(`/restaurant/bills/${id}/void`, { method: 'POST', body: { reason, version } }),
  pay: (id: string, method: PaymentMethod, amountMinor: number, reference?: string) =>
    apiFetch<{ bill: Bill; repeated: boolean }>(`/restaurant/bills/${id}/payments`,
      { method: 'POST', body: { method, amountMinor, ...(reference ? { reference } : {}) } }),
  reverse: (paymentId: string, reason: string) =>
    apiFetch<{ bill: Bill }>(`/restaurant/payments/${paymentId}/reverse`, { method: 'POST', body: { reason } }),
  // Copies are POSTs, not GETs: each one is recorded in the billing ledger and
  // numbered, so the first is the original and later ones are duplicates.
  recordPrint: (id: string) =>
    apiFetch<{ bill: Bill; copy: BillCopy }>(`/restaurant/bills/${id}/print`, { method: 'POST' }),
  pdf: (id: string) => apiFetchBlob(`/restaurant/bills/${id}/pdf`, { method: 'POST' }),
  sales: (params: SalesParams) => apiFetch<SalesReport>(`/restaurant/reports/sales${query(params)}`),
  // The export is a POST: it is recorded in the activity log, and a write must not
  // sit behind a GET, which the CSRF guard exempts.
  salesCsv: (params: SalesParams) =>
    apiFetchBlob(`/restaurant/reports/sales/export${query(params)}`, { method: 'POST' }),
};

export type BillCopy = { number: number; duplicate: boolean; mark: string | null };
export type SalesParams = { from: string; to: string; groupBy: 'day' | 'method' };
export type SalesDay = {
  day: string; bills: number; voidedBills: number; subtotalMinor: number; discountMinor: number;
  serviceChargeMinor: number; taxMinor: number; roundingMinor: number; totalMinor: number;
};
export type SalesMethod = { method: PaymentMethod; payments: number; amountMinor: number };
export type SalesReport = {
  from: string; to: string; groupBy: 'day' | 'method'; timezone: string; currency: Currency;
  /** "mine" for billing staff, who see only the sales they billed (design/02 §6.8). */
  scope: 'mine' | 'all';
  rows: SalesDay[] | SalesMethod[];
  totals: Record<string, number>;
};
