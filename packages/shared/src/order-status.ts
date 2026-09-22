// The order state machine, shared by the UI and (later) the API and database.
//
// One definition, three consumers: the UI hides actions it may not take, the API
// enforces them, and a contract test checks the database trigger agrees. Colour is
// never the only signal — every status carries a label.

export const ORDER_STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'served', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type StaffRole = 'owner' | 'manager' | 'kitchen' | 'billing';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
  cancelled: 'Cancelled',
};

/** Which roles may perform each forward transition (PRD §8, Q-10 assumption). */
const TRANSITIONS: { from: OrderStatus; to: OrderStatus; roles: readonly StaffRole[] }[] = [
  { from: 'pending',   to: 'accepted',  roles: ['owner', 'manager', 'kitchen'] },
  { from: 'accepted',  to: 'preparing', roles: ['owner', 'manager', 'kitchen'] },
  { from: 'preparing', to: 'ready',     roles: ['owner', 'manager', 'kitchen'] },
  { from: 'ready',     to: 'served',    roles: ['owner', 'manager', 'billing'] },
  { from: 'pending',   to: 'cancelled', roles: ['owner', 'manager', 'kitchen'] },
  { from: 'accepted',  to: 'cancelled', roles: ['owner', 'manager', 'kitchen'] },
  { from: 'preparing', to: 'cancelled', roles: ['owner', 'manager'] },
];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['served', 'cancelled'];

export function canTransition(role: StaffRole, from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.roles.includes(role));
}

/** Forward transitions a role may take from `from`, for building UI actions. */
export function allowedTransitions(role: StaffRole, from: OrderStatus): OrderStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.roles.includes(role)).map((t) => t.to);
}

/** Cancelling always needs a reason; so does reverting. Mirrors the database rules. */
export function requiresReason(to: OrderStatus): boolean {
  return to === 'cancelled';
}

/** Statuses the kitchen works on: everything before the order reaches the table. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = ['pending', 'accepted', 'preparing', 'ready'];

/** Roles that may take an order one step back (FR-053, BR-ORD-03). */
export const REVERT_ROLES: readonly StaffRole[] = ['owner', 'manager'];

/**
 * The status an order returns to when an owner or manager reverts it one step, or
 * null when it cannot be reverted. Cancelled is terminal: it is never reverted.
 * Served → ready is allowed only while the order is on no live bill (BR-ORD-03);
 * bills do not exist yet, so that condition is checked by the billing module.
 */
export function revertTarget(from: OrderStatus): OrderStatus | null {
  const index = ['pending', 'accepted', 'preparing', 'ready', 'served'].indexOf(from);
  return index > 0 ? (['pending', 'accepted', 'preparing', 'ready'] as const)[index - 1]! : null;
}

export function canRevert(role: StaffRole, from: OrderStatus): boolean {
  return REVERT_ROLES.includes(role) && revertTarget(from) !== null;
}
