import test from 'node:test';
import assert from 'node:assert/strict';
import { can, canManageRole, permissionsFor, PERMISSIONS, type Principal } from './permissions.ts';
import type { StaffRole } from './order-status.ts';

const staff = (role: StaffRole, aal: 'aal1' | 'aal2' = 'aal1'): Principal =>
  ({ kind: 'staff', role, restaurantId: 'r1', userId: 'u1', aal });
const admin = (aal: 'aal1' | 'aal2' = 'aal2'): Principal => ({ kind: 'platform_admin', userId: 'a1', aal });

test('roles get the permissions the PRD gives them', () => {
  assert.ok(can(staff('owner'), 'bill.void'));
  assert.ok(can(staff('manager'), 'bill.void'));
  assert.ok(can(staff('kitchen'), 'menu.item.toggleAvailability'));
  assert.ok(can(staff('billing'), 'payment.record'));
});

test('roles are denied what the PRD withholds', () => {
  assert.equal(can(staff('kitchen'), 'menu.write'), false);
  assert.equal(can(staff('kitchen'), 'order.read.contact'), false, 'kitchen must never see customer contact details');
  assert.equal(can(staff('billing'), 'bill.discount.apply'), false);
  assert.equal(can(staff('billing'), 'bill.void'), false);
  assert.equal(can(staff('manager'), 'restaurant.settings.update'), false);
  assert.equal(can(staff('manager'), 'restaurant.tax.update'), false);
  assert.equal(can(staff('manager'), 'audit.read.all'), false);
});

test('platform powers need the admin kind and a second factor', () => {
  assert.ok(can(admin('aal2'), 'platform.restaurant.create'));
  assert.equal(can(admin('aal1'), 'platform.restaurant.create'), false, 'MFA is mandatory for platform admins');
  assert.equal(can(staff('owner'), 'platform.restaurant.create'), false, 'no staff role grants platform powers');
});

test('platform admins hold no tenant permissions', () => {
  for (const key of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
    assert.equal(can(admin('aal2'), key), false, `platform admin must not hold ${key}`);
  }
});

test('nobody may grant a role at or above their own', () => {
  assert.ok(canManageRole(staff('owner'), 'owner'));
  assert.ok(canManageRole(staff('manager'), 'kitchen'));
  assert.ok(canManageRole(staff('manager'), 'billing'));
  assert.equal(canManageRole(staff('manager'), 'manager'), false);
  assert.equal(canManageRole(staff('manager'), 'owner'), false, 'privilege escalation');
  assert.equal(canManageRole(staff('kitchen'), 'kitchen'), false);
  assert.equal(canManageRole(staff('billing'), 'kitchen'), false);
  assert.equal(canManageRole(admin(), 'owner'), false, 'platform admins do not manage tenant staff');
});

test('the UI permission list matches can() exactly', () => {
  for (const role of ['owner', 'manager', 'kitchen', 'billing'] as StaffRole[]) {
    const principal = staff(role);
    const listed = new Set(permissionsFor(principal));
    for (const key of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      assert.equal(listed.has(key), can(principal, key), `${role} / ${key} disagrees`);
    }
  }
});

test('an unknown permission key is denied, not allowed by omission', () => {
  // Cast deliberately: this is what a typo in a route declaration looks like at runtime.
  assert.equal(can(staff('owner'), 'menu.delete.everything' as never), false);
});
