// Placeholder data for the design review only.
//
// There is no API yet, so the dashboard must not pretend otherwise: every screen
// that uses this file also renders <DemoBanner />, and this module throws if it is
// ever imported into a production build (PRD §8: demo data is labelled and removed).
import type { OrderStatus } from '@dineflow/shared';

// A production build refuses to load this module unless it opts in. The scaffold
// opts in today because the dashboard has nothing else to show; when the orders
// module lands, delete VITE_ALLOW_DEMO_DATA from the build script and this file,
// and the guard will stop any demo data from reaching a customer.
if (import.meta.env?.PROD && !import.meta.env?.VITE_ALLOW_DEMO_DATA) {
  throw new Error('demo data must not ship to production');
}

export type DemoOrder = {
  ref: string;
  table: string;
  items: number;
  totalMinor: number;
  status: OrderStatus;
  placedAt: Date;
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

export const DEMO_ORDERS: DemoOrder[] = [
  { ref: 'SG-1042', table: '12', items: 4, totalMinor: 96500, status: 'pending', placedAt: minutesAgo(2) },
  { ref: 'SG-1041', table: '4', items: 2, totalMinor: 47000, status: 'preparing', placedAt: minutesAgo(9) },
  { ref: 'SG-1040', table: 'Patio 2', items: 6, totalMinor: 141500, status: 'ready', placedAt: minutesAgo(14) },
  { ref: 'SG-1039', table: '7', items: 3, totalMinor: 62500, status: 'served', placedAt: minutesAgo(38) },
  { ref: 'SG-1038', table: '1', items: 1, totalMinor: 18000, status: 'cancelled', placedAt: minutesAgo(52) },
];

export const DEMO_SUMMARY = {
  ordersToday: 38,
  pendingOrders: 3,
  // Sales counts finalized, paid, non-void bills only — the definition is shown in
  // the UI because "today's sales" is ambiguous until it is stated (FR-092).
  salesTodayMinor: 2_148_500,
  unbilledMinor: 285_000,
  activeTables: 6,
  totalTables: 18,
};
