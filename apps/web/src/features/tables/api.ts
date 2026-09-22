// Typed calls for the tables module. Every call goes through apiFetch, which sends
// the session cookie and the CSRF header; there is no other way to reach the API.
import { apiFetch, apiFetchBlob } from '@/lib/api.ts';
import type { QrPayload } from './QrCard.tsx';

export type TableStatus = 'active' | 'inactive';

export type DiningTable = {
  id: string;
  tableNumber: string;
  name: string | null;
  /** Staff-only; customers never see it. */
  notes: string | null;
  capacity: number;
  status: TableStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Present only for roles allowed to see QR codes. */
  qr?: { issuedAt: string } | null;
};

export type TableInput = { tableNumber: string; name: string | null; notes: string | null; capacity: number };

export type BulkInput = { prefix: string; from: number; to: number; capacity: number };

export type QrSheet = {
  restaurantName: string;
  provisional: boolean;
  cards: { tableNumber: string; name: string | null; url: string; svg: string }[];
  activeTablesWithoutQr: number;
};

export const tablesApi = {
  list: () => apiFetch<{ tables: DiningTable[]; truncated: boolean }>('/restaurant/tables'),
  create: (input: TableInput) =>
    apiFetch<{ table: DiningTable }>('/restaurant/tables', { method: 'POST', body: input }),
  update: (id: string, input: Partial<TableInput> & { version: number }) =>
    apiFetch<{ table: DiningTable }>(`/restaurant/tables/${id}`, { method: 'PATCH', body: input }),
  setStatus: (id: string, status: TableStatus, version: number, reason?: string) =>
    apiFetch<{ table: DiningTable }>(`/restaurant/tables/${id}/status`, {
      method: 'PATCH', body: { status, version, ...(reason ? { reason } : {}) },
    }),
  getQr: (id: string) => apiFetch<{ qr: QrPayload }>(`/restaurant/tables/${id}/qr`),
  issueQr: (id: string) => apiFetch<{ qr: QrPayload; created: boolean }>(`/restaurant/tables/${id}/qr`, { method: 'POST' }),
  regenerateQr: (id: string) =>
    apiFetch<{ qr: QrPayload }>(`/restaurant/tables/${id}/qr/regenerate`, { method: 'POST' }),
  revokeQr: (id: string) => apiFetch<{ revoked: boolean }>(`/restaurant/tables/${id}/qr/revoke`, { method: 'POST' }),
  bulkCreate: (input: BulkInput) =>
    apiFetch<{ tables: DiningTable[] }>('/restaurant/tables/bulk', { method: 'POST', body: input }),
  issueMissingQr: () => apiFetch<{ issued: number }>('/restaurant/tables/qr/issue-missing', { method: 'POST' }),
  qrSheet: () => apiFetch<QrSheet>('/restaurant/tables/qr-sheet'),
  qrPng: (id: string) => apiFetchBlob(`/restaurant/tables/${id}/qr/png`),
};

/** A file-name-safe form of a table number: "Patio 3/a" becomes "Patio-3-a". */
export const fileSafe = (tableNumber: string) => tableNumber.replace(/[^A-Za-z0-9-]+/g, '-');

/** Sorts table numbers the way people read them: T2 before T10. */
export const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
