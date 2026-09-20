// The declared isolation matrix (ISO-03).
//
// For every table × principal, the expected outcome is written down here. The runner
// fails on any combination that is NOT declared ("unspecified cell"), so adding a
// table or a role forces someone to state what that role may see and do, rather than
// inheriting whatever the policies happen to allow.
import type { Fixtures } from './fixtures.ts';

export type ReadExpectation =
  | 'own'        // sees rows of the caller's own tenant only, and at least one
  | 'none'       // sees nothing (denied or empty)
  | 'all'        // sees rows of more than one tenant (platform-level view)
  | 'self'       // sees exactly the caller's own row
  | 'platform';  // sees platform-level rows only (restaurant_id is null)

export type WriteExpectation = 'allow' | 'deny';

export type Cell = {
  read: ReadExpectation;
  insertOwn: WriteExpectation;
  updateOwn: WriteExpectation;
};

export type PrincipalKind =
  | { kind: 'staff'; userOf: keyof Fixtures; aal?: 'aal1' | 'aal2' }
  | { kind: 'public'; restaurantOf: keyof Fixtures | null }
  | { kind: 'none' };

export type Principal = {
  id: string;
  description: string;
  /** Which tenant's rows this principal may legitimately see, if any. */
  tenantOf: keyof Fixtures | null;
  how: PrincipalKind;
};

export const PRINCIPALS: Principal[] = [
  { id: 'owner-A',        description: 'owner of restaurant A',                    tenantOf: 'restaurantA', how: { kind: 'staff', userOf: 'ownerA' } },
  { id: 'manager-A',      description: 'manager of restaurant A',                  tenantOf: 'restaurantA', how: { kind: 'staff', userOf: 'managerA' } },
  { id: 'kitchen-A',      description: 'kitchen staff of restaurant A',            tenantOf: 'restaurantA', how: { kind: 'staff', userOf: 'kitchenA' } },
  { id: 'billing-A',      description: 'billing staff of restaurant A',            tenantOf: 'restaurantA', how: { kind: 'staff', userOf: 'billingA' } },
  { id: 'deactivated-A',  description: 'deactivated staff of restaurant A',        tenantOf: null,          how: { kind: 'staff', userOf: 'deactivatedA' } },
  { id: 'owner-S',        description: 'owner of a suspended restaurant',          tenantOf: null,          how: { kind: 'staff', userOf: 'ownerS' } },
  { id: 'owner-B',        description: 'owner of restaurant B (the other tenant)', tenantOf: 'restaurantB', how: { kind: 'staff', userOf: 'ownerB' } },
  { id: 'admin-no-mfa',   description: 'platform admin without MFA',               tenantOf: null,          how: { kind: 'staff', userOf: 'adminPlain', aal: 'aal1' } },
  { id: 'admin',          description: 'platform admin (aal2), no support grant',  tenantOf: null,          how: { kind: 'staff', userOf: 'adminPlain', aal: 'aal2' } },
  { id: 'admin-granted',  description: 'platform admin (aal2) with a live grant for A', tenantOf: 'restaurantA', how: { kind: 'staff', userOf: 'adminGranted', aal: 'aal2' } },
  { id: 'public-A',       description: 'anonymous customer scoped to restaurant A', tenantOf: 'restaurantA', how: { kind: 'public', restaurantOf: 'restaurantA' } },
  { id: 'public-none',    description: 'anonymous request with no resolved restaurant', tenantOf: null,      how: { kind: 'public', restaurantOf: null } },
  { id: 'api-no-context', description: 'the API login role with no request context', tenantOf: null,         how: { kind: 'none' } },
];

export type TableSpec = {
  table: string;
  /** Column identifying the owning tenant, used to detect foreign rows. */
  tenantColumn: string;
  /** Column carrying the fixture marker string. */
  markerColumn: string;
  /** Columns a public (customer) principal is allowed to read, if any. */
  publicReadable?: boolean;
  cells: Record<string, Cell>;
};

const deny = (read: ReadExpectation): Cell => ({ read, insertOwn: 'deny', updateOwn: 'deny' });

export const TABLES: TableSpec[] = [
  {
    table: 'restaurants',
    tenantColumn: 'id',
    markerColumn: 'name',
    publicReadable: true,
    cells: {
      'owner-A':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),   // suspension locks staff out everywhere
      'owner-B':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),   // platform powers require a second factor
      'admin':          { read: 'all',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-granted':  { read: 'all',  insertOwn: 'allow', updateOwn: 'allow' },
      'public-A':       { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'restaurant_users',
    tenantColumn: 'restaurant_id',
    markerColumn: 'display_name',
    cells: {
      'owner-A':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),   // platform admins get no tenant staff data by default
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },  // read-only support access
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'support_grants',
    tenantColumn: 'restaurant_id',
    markerColumn: 'reason',
    cells: {
      'owner-A':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },  // visible to the owner (FR-123)
      'manager-A':      deny('none'),
      'kitchen-A':      deny('none'),
      'billing-A':      deny('none'),
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'admin-no-mfa':   deny('none'),
      'admin':          { read: 'all',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-granted':  { read: 'all',  insertOwn: 'allow', updateOwn: 'allow' },
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'audit_log',
    tenantColumn: 'restaurant_id',
    markerColumn: 'summary::text',
    cells: {
      // Append-only for everyone: no principal may update an audit row (BR-DATA-01).
      'owner-A':        { read: 'own',      insertOwn: 'allow', updateOwn: 'deny' },
      'manager-A':      { read: 'own',      insertOwn: 'allow', updateOwn: 'deny' },
      'kitchen-A':      { read: 'none',     insertOwn: 'allow', updateOwn: 'deny' },
      'billing-A':      { read: 'none',     insertOwn: 'allow', updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',      insertOwn: 'allow', updateOwn: 'deny' },
      'admin-no-mfa':   deny('none'),
      // Platform admins write audit rows for their own actions on a tenant
      // (suspend, support grant); they still cannot read a tenant's audit history.
      'admin':          { read: 'platform', insertOwn: 'allow', updateOwn: 'deny' },
      'admin-granted':  { read: 'platform', insertOwn: 'allow', updateOwn: 'deny' },
      'public-A':       { read: 'none',     insertOwn: 'allow', updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'invitations',
    tenantColumn: 'restaurant_id',
    markerColumn: 'email::text',
    cells: {
      // Only the roles that may manage staff can see who has been invited; an
      // invitation reveals an email address and a role about to be granted.
      'owner-A':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'kitchen-A':      deny('none'),
      'billing-A':      deny('none'),
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),   // platform admins do not read tenant staff data
      'admin-granted':  deny('none'),   // support access is read-only and excludes invitations
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'auth_lockouts',
    tenantColumn: 'key_kind',
    markerColumn: 'key_kind',
    cells: {
      // Brute-force counters are reachable only through SECURITY DEFINER functions
      // called by the API's login role, because the caller is not yet authenticated.
      'owner-A':        deny('none'),
      'manager-A':      deny('none'),
      'kitchen-A':      deny('none'),
      'billing-A':      deny('none'),
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        deny('none'),
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  deny('none'),
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'platform_admins',
    tenantColumn: 'user_id',
    markerColumn: 'user_id::text',
    cells: {
      'owner-A':        deny('none'),
      'manager-A':      deny('none'),
      'kitchen-A':      deny('none'),
      'billing-A':      deny('none'),
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        deny('none'),
      'admin-no-mfa':   deny('self'),
      'admin':          deny('self'),
      'admin-granted':  deny('self'),
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
];
