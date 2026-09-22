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
  // An owner setting up a new restaurant must be able to work before it goes live,
  // or onboarding cannot be completed (migration 005).
  { id: 'owner-P',        description: 'owner of a restaurant still being provisioned', tenantOf: 'restaurantP', how: { kind: 'staff', userOf: 'ownerP' } },
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
  /**
   * Marker column for public (customer) principals, when the staff one is not in
   * the column-level grant. Reading a column the public may not see would fail for
   * the wrong reason and hide whether row scoping actually works.
   */
  publicMarkerColumn?: string;
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
      'owner-P':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
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
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
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
      'owner-P':        { read: 'none', insertOwn: 'deny',  updateOwn: 'deny' },
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
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'deny' },
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
    table: 'restaurant_settings',
    tenantColumn: 'restaurant_id',
    markerColumn: 'coalesce(bill_footer, \'\')',
    // The bill footer is staff-only; a customer sees just the ordering rules.
    publicMarkerColumn: 'contact_policy::text',
    cells: {
      // Settings shape money and tax, so only the owner may change them; everyone
      // on the team can read them because order limits and the bill header affect
      // their work.
      'owner-A':        { read: 'own',  insertOwn: 'deny', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'deny', updateOwn: 'deny' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny', updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny', updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'deny', updateOwn: 'allow' },
      'owner-P':        { read: 'own',  insertOwn: 'deny', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny', updateOwn: 'deny' },
      'public-A':       { read: 'own',  insertOwn: 'deny', updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'tax_components',
    tenantColumn: 'restaurant_id',
    markerColumn: 'name',
    cells: {
      'owner-A':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      // The customer needs the tax lines to see an estimated total (D-17).
      'public-A':       { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'order_counters',
    tenantColumn: 'restaurant_id',
    markerColumn: 'next_no::text',
    cells: {
      // Reached only through app.next_order_no(); no role holds any privilege on it.
      'owner-A':        deny('none'),
      'manager-A':      deny('none'),
      'kitchen-A':      deny('none'),
      'billing-A':      deny('none'),
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        deny('none'),
      'owner-P':        deny('none'),
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  deny('none'),
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'orders',
    tenantColumn: 'restaurant_id',
    markerColumn: "coalesce(special_instructions, '')",
    cells: {
      // Every staff role reads and works on its restaurant's orders (which status
      // changes each may make is the database guard's decision, tested in the API
      // suite). Customers place orders but can read one back only with its status
      // token, which a probe does not hold.
      'owner-A':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'owner-P':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'public-A':       { read: 'none', insertOwn: 'allow', updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'order_status_history',
    tenantColumn: 'restaurant_id',
    markerColumn: "coalesce((select o.special_instructions from orders o where o.id = order_id), '')",
    cells: {
      // Every staff role reads its restaurant's history; nobody writes or edits it.
      // Rows come only from the status trigger, and the table is append-only.
      'owner-A':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'manager-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'owner-P':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'order_items',
    tenantColumn: 'restaurant_id',
    markerColumn: 'name_snapshot',
    cells: {
      'owner-A':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'manager-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'owner-P':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      // Lines are written with their order; the commit-time total check refuses a
      // line added to an order afterwards (tested in the API suite).
      'public-A':       { read: 'none', insertOwn: 'allow', updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'order_customers',
    tenantColumn: 'restaurant_id',
    markerColumn: "upper(coalesce(email, ''))",
    cells: {
      // Contact details: owner, manager and billing only. Never kitchen (PRD §8),
      // and not support access either.
      'owner-A':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'manager-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'kitchen-A':      deny('none'),
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'owner-P':        { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  deny('none'),
      'public-A':       { read: 'none', insertOwn: 'allow', updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'menu_categories',
    tenantColumn: 'restaurant_id',
    markerColumn: 'name',
    publicReadable: true,
    cells: {
      // Every staff role reads the menu; only owners and managers shape it (menu.write).
      'owner-A':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      // The customer's menu: shown, live categories of their one restaurant.
      'public-A':       { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'menu_items',
    tenantColumn: 'restaurant_id',
    markerColumn: 'name',
    publicReadable: true,
    cells: {
      'owner-A':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      // Kitchen may toggle availability only; the probe changes the price, which
      // the column trigger refuses (the availability toggle is tested in the API suite).
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'public-A':       { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'dining_tables',
    tenantColumn: 'restaurant_id',
    markerColumn: "coalesce(name, '')",
    cells: {
      // Every staff role reads the tables (kitchen needs table numbers on orders);
      // only owners and managers change them (PRD §8, table.write).
      'owner-A':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'kitchen-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'billing-A':      { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  { read: 'own',  insertOwn: 'deny',  updateOwn: 'deny' },
      // Customers reach one table through a verified token and the resolver,
      // never by reading this table.
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
  {
    table: 'table_qr_tokens',
    tenantColumn: 'restaurant_id',
    markerColumn: 'qr_id::text',
    cells: {
      // A qr_id is half of a working capability: only the roles that print and
      // rotate QR codes see it, and support access does not reach it.
      'owner-A':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'manager-A':      { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'kitchen-A':      deny('none'),
      'billing-A':      deny('none'),
      'deactivated-A':  deny('none'),
      'owner-S':        deny('none'),
      'owner-B':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
      'admin-no-mfa':   deny('none'),
      'admin':          deny('none'),
      'admin-granted':  deny('none'),
      'public-A':       deny('none'),
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
      'owner-P':        { read: 'own',  insertOwn: 'allow', updateOwn: 'allow' },
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
      'owner-P':        deny('none'),
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
      'owner-P':        deny('none'),
      'admin-no-mfa':   deny('self'),
      'admin':          deny('self'),
      'admin-granted':  deny('self'),
      'public-A':       deny('none'),
      'public-none':    deny('none'),
      'api-no-context': deny('none'),
    },
  },
];
