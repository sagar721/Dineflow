// Order-screen rules as pure functions: which actions a role gets, how the kitchen
// board groups and sorts, and elapsed time. Imports only the shared package, so the
// rules are unit-tested with `node --test`, no browser needed.
import {
  canRevert, canTransition, ORDER_STATUS_LABEL, revertTarget,
  type OrderStatus, type StaffRole,
} from '../../../../../packages/shared/src/index.ts';

export type OrderAction = { kind: 'advance' | 'cancel' | 'revert'; to: OrderStatus; label: string; needsReason: boolean };

/** The forward step each status has, with its button label. */
const FORWARD: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  pending: { to: 'accepted', label: 'Accept' },
  accepted: { to: 'preparing', label: 'Start preparing' },
  preparing: { to: 'ready', label: 'Mark ready' },
  ready: { to: 'served', label: 'Mark served' },
};

/**
 * The actions a role may take on an order in this status, in the order they should
 * appear. Mirrors the server exactly (same shared state machine); the server still
 * decides, so a stale screen can never do more than this.
 */
export function actionsFor(role: StaffRole, status: OrderStatus): OrderAction[] {
  const actions: OrderAction[] = [];
  const forward = FORWARD[status];
  if (forward && canTransition(role, status, forward.to)) {
    actions.push({ kind: 'advance', to: forward.to, label: forward.label, needsReason: false });
  }
  if (canTransition(role, status, 'cancelled')) {
    actions.push({ kind: 'cancel', to: 'cancelled', label: 'Cancel order', needsReason: true });
  }
  const back = revertTarget(status);
  if (back && canRevert(role, status)) {
    actions.push({ kind: 'revert', to: back, label: `Back to ${ORDER_STATUS_LABEL[back]}`, needsReason: true });
  }
  return actions;
}

export type BoardOrder = { id: string; status: OrderStatus; placedAt: string };

export type KitchenColumn = 'pending' | 'accepted' | 'preparing' | 'ready';

/** The kitchen board (FR-056): one column per active status, oldest order first. */
export function groupForKitchen<T extends BoardOrder>(orders: readonly T[]): Record<KitchenColumn, T[]> {
  const columns = { pending: [] as T[], accepted: [] as T[], preparing: [] as T[], ready: [] as T[] };
  for (const order of orders) {
    if (order.status in columns) columns[order.status as keyof typeof columns].push(order);
  }
  for (const column of Object.values(columns)) {
    column.sort((a, b) => Date.parse(a.placedAt) - Date.parse(b.placedAt) || a.id.localeCompare(b.id));
  }
  return columns;
}

/** "Just now", "7 min", "1 h 05 min" — how long an order has been waiting. */
export function elapsedLabel(fromIso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** Orders waiting at least this long are highlighted on the board. */
export const LATE_AFTER_MINUTES = 15;

export function isLate(fromIso: string, now: number): boolean {
  return now - Date.parse(fromIso) >= LATE_AFTER_MINUTES * 60_000;
}

/**
 * Which orders are genuinely new since the last poll, given what has already been
 * announced — so one order rings the alert once, however often it is reported.
 */
export function unannounced<T extends { id: string }>(newOrders: readonly T[], announced: ReadonlySet<string>): T[] {
  return newOrders.filter((order) => !announced.has(order.id));
}
