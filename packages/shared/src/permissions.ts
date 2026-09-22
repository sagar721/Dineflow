// The role/permission matrix from PRD §8, as data, in one place.
//
// Three consumers: the API middleware (enforcement), the UI (hiding controls, which
// is cosmetic only), and the test generator. The database enforces the most
// sensitive parts independently through RLS, so a mistake here cannot by itself
// expose another tenant's data.

import type { StaffRole } from './order-status.ts';

export type Principal =
  | { kind: 'staff'; role: StaffRole; restaurantId: string; userId: string; aal: 'aal1' | 'aal2' }
  | { kind: 'platform_admin'; userId: string; aal: 'aal1' | 'aal2' };

export const PERMISSIONS = {
  // Restaurant profile and settings
  'restaurant.read': ['owner', 'manager', 'kitchen', 'billing'],
  'restaurant.update': ['owner', 'manager'],
  'restaurant.settings.update': ['owner'],
  'restaurant.tax.update': ['owner'],

  // Staff. "manage.any" is every role; "manage.limited" is kitchen and billing only,
  // which is what a manager may touch (FR-108, FR-109, Q-10).
  'staff.read': ['owner', 'manager'],
  'staff.manage.any': ['owner'],
  'staff.manage.limited': ['owner', 'manager'],
  'staff.invite': ['owner', 'manager'],

  // Tables and QR
  'table.read': ['owner', 'manager', 'kitchen', 'billing'],
  'table.write': ['owner', 'manager'],
  'qr.read': ['owner', 'manager'],
  'qr.rotate': ['owner', 'manager'],

  // Menu
  'menu.read': ['owner', 'manager', 'kitchen', 'billing'],
  'menu.write': ['owner', 'manager'],
  'menu.item.toggleAvailability': ['owner', 'manager', 'kitchen'],

  // Orders
  'order.read': ['owner', 'manager', 'kitchen', 'billing'],
  'order.read.contact': ['owner', 'manager', 'billing'], // kitchen never sees customer details
  'order.status.accept': ['owner', 'manager', 'kitchen'],
  'order.status.prepare': ['owner', 'manager', 'kitchen'],
  'order.status.ready': ['owner', 'manager', 'kitchen'],
  'order.status.serve': ['owner', 'manager', 'billing'],
  'order.cancel': ['owner', 'manager', 'kitchen'],
  'order.revert': ['owner', 'manager'],
  'order.staffNote': ['owner', 'manager', 'kitchen', 'billing'], // FR-059, design/02 §6.7

  // Billing
  'bill.read': ['owner', 'manager', 'billing'],
  'bill.create': ['owner', 'manager', 'billing'],
  'bill.finalize': ['owner', 'manager', 'billing'],
  'bill.discount.apply': ['owner', 'manager'], // manager additionally subject to a cap
  'bill.void': ['owner', 'manager'],
  'payment.record': ['owner', 'manager', 'billing'],
  'payment.reverse': ['owner', 'manager'],

  // Reports. Billing staff see only the sales they billed themselves (design/02 §6.8).
  'report.sales': ['owner', 'manager', 'billing'],

  // Reporting, audit, export
  'dashboard.read': ['owner', 'manager'],
  'audit.read.all': ['owner'],
  'audit.read.limited': ['owner', 'manager'],
  'export.request': ['owner'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type PermissionKey = keyof typeof PERMISSIONS;

/**
 * Platform-admin capabilities are deliberately separate: a platform admin is not a
 * staff member with extra powers, and holds no tenant permissions at all. Every one
 * of these requires a second authentication factor (FR-105).
 */
export const PLATFORM_PERMISSIONS = [
  'platform.restaurant.create',
  'platform.restaurant.status',
  'platform.restaurant.read',
  'platform.support_grant.create',
  'platform.support_grant.revoke',
  'platform.export.trigger',
] as const;

export type PlatformPermissionKey = (typeof PLATFORM_PERMISSIONS)[number];

export type AnyPermissionKey = PermissionKey | PlatformPermissionKey;

function isPlatformPermission(key: AnyPermissionKey): key is PlatformPermissionKey {
  return (PLATFORM_PERMISSIONS as readonly string[]).includes(key);
}

/**
 * The single authorization question. Returns false rather than throwing so callers
 * decide the response shape; the API turns it into 403 (or 404 where existence
 * itself is sensitive).
 */
export function can(principal: Principal, key: AnyPermissionKey): boolean {
  if (isPlatformPermission(key)) {
    // Platform powers need the admin kind AND a second factor. A staff role, however
    // senior, never grants them.
    return principal.kind === 'platform_admin' && principal.aal === 'aal2';
  }
  if (principal.kind !== 'staff') return false;
  const roles = PERMISSIONS[key] as readonly StaffRole[] | undefined;
  return roles !== undefined && roles.includes(principal.role);
}

/** Role seniority, used to stop anyone granting a role at or above their own. */
const RANK: Record<StaffRole, number> = { owner: 3, manager: 2, billing: 1, kitchen: 1 };

/**
 * Whether `actor` may create, change or deactivate a member holding `targetRole`.
 * Owners manage anyone; managers manage kitchen and billing only (FR-108/109).
 */
export function canManageRole(actor: Principal, targetRole: StaffRole): boolean {
  if (actor.kind !== 'staff') return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'manager') return RANK[targetRole] < RANK.manager;
  return false;
}

/** Permission keys a principal holds, sent to the UI so it can hide controls. */
export function permissionsFor(principal: Principal): AnyPermissionKey[] {
  const keys: AnyPermissionKey[] = [];
  for (const key of Object.keys(PERMISSIONS) as PermissionKey[]) {
    if (can(principal, key)) keys.push(key);
  }
  for (const key of PLATFORM_PERMISSIONS) {
    if (can(principal, key)) keys.push(key);
  }
  return keys;
}
