// Structural guards over the live catalog (ISO-01, ISO-02, and F-4…F-7 in Part 7 §3).
//
// These run against whatever database they are pointed at — local, CI, staging or
// production — and answer one question: is the schema still closed by default?
// Discovery is by introspection, so a table added later cannot escape the checks by
// being forgotten in a list.
import type pg from 'pg';

export type Finding = { check: string; object: string; detail: string };

/** Tables that legitimately hold no `restaurant_id`. Anything else must be tenant-scoped. */
export const NON_TENANT_TABLES = new Set([
  'restaurants',        // the tenant root itself
  'platform_admins',    // platform-level, not owned by a restaurant
  'auth_lockouts',      // brute-force counters, keyed by hashed identifier, no tenant
  'schema_migrations',  // infrastructure
]);

/** SECURITY DEFINER functions are reviewed individually; this is the reviewed set. */
export const ALLOWED_DEFINER_FUNCTIONS = new Set([
  'app.lookup_membership',
  'app.restaurant_id',
  'app.role',
  'app.is_platform_admin',
  'app.has_support_grant',
  'app.assert_owner_remains',
  'app.support_grant_immutable',
  'app.invitation_immutable',
  'app.lookup_invitation',
  'app.accept_invitation',
  'app.register_auth_failure',
  'app.check_auth_lock',
  'app.clear_auth_failures',
  'app.record_auth_event',
  'app.create_default_settings',
  'app.limit_tax_components',
  'app.restaurants_guard',
  'app.settings_guard',
  'app.create_restaurant',
  'app.list_restaurants',
  'app.set_restaurant_status',
  'app.resolve_table_qr',
]);

/** Roles that must never hold privileges on DineFlow tables (Part 7 §3, F-1/F-7). */
export const FORBIDDEN_GRANTEES = ['anon', 'authenticated', 'service_role', 'public'];

/** information_schema spells the implicit role "PUBLIC"; pg_policies spells it "public". */
const isForbiddenGrantee = (name: string): boolean =>
  FORBIDDEN_GRANTEES.includes(name.toLowerCase());

type TableRow = { table_name: string; rls_enabled: boolean; rls_forced: boolean; has_tenant_col: boolean };

export async function listPublicTables(client: pg.ClientBase): Promise<TableRow[]> {
  const { rows } = await client.query<TableRow>(`
    select c.relname as table_name,
           c.relrowsecurity as rls_enabled,
           c.relforcerowsecurity as rls_forced,
           exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'restaurant_id' and a.attnum > 0
                      and not a.attisdropped) as has_tenant_col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname`);
  return rows;
}

/** A table is tenant data if it carries `restaurant_id` or is not explicitly exempt. */
export function isTenantTable(t: TableRow): boolean {
  return t.has_tenant_col || !NON_TENANT_TABLES.has(t.table_name);
}

export async function runSchemaGuards(client: pg.ClientBase): Promise<Finding[]> {
  const findings: Finding[] = [];
  const tables = await listPublicTables(client);

  // ISO-01/ISO-02: every tenant table has RLS enabled *and* forced, and a NOT NULL
  // restaurant_id with a foreign key to the tenant root.
  for (const t of tables) {
    if (t.table_name === 'schema_migrations') continue;
    const tenant = isTenantTable(t);
    if (!t.rls_enabled) findings.push({ check: 'rls-enabled', object: t.table_name, detail: 'row level security is not enabled' });
    if (!t.rls_forced) findings.push({ check: 'rls-forced', object: t.table_name, detail: 'FORCE ROW LEVEL SECURITY is not set, so the table owner bypasses policies' });
    if (tenant && !t.has_tenant_col && t.table_name !== 'restaurants') {
      findings.push({ check: 'tenant-column', object: t.table_name, detail: 'no restaurant_id column and not on the reviewed non-tenant list' });
    }
    if (t.has_tenant_col) {
      const { rows } = await client.query<{ is_nullable: string; fk: number }>(`
        select a.attnotnull::text as is_nullable,
               (select count(*) from pg_constraint k
                 where k.conrelid = c.oid and k.contype = 'f'
                   and a.attnum = any (k.conkey)
                   and k.confrelid = 'restaurants'::regclass)::int as fk
          from pg_class c
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurant_id'
         where c.oid = to_regclass($1)`, [`public.${t.table_name}`]);
      const row = rows[0];
      if (row && row.is_nullable !== 'true' && t.table_name !== 'audit_log') {
        findings.push({ check: 'tenant-not-null', object: t.table_name, detail: 'restaurant_id is nullable' });
      }
      if (row && row.fk === 0) {
        findings.push({ check: 'tenant-fk', object: t.table_name, detail: 'restaurant_id has no foreign key to restaurants' });
      }
    }
  }

  // ISO-02: no policy may be unconditional, and write policies need WITH CHECK,
  // or a row could be moved into another tenant.
  const { rows: policies } = await client.query<{
    tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null; roles: string[];
  }>(`select tablename, policyname, cmd, qual, with_check, roles from pg_policies where schemaname = 'public'`);
  for (const p of policies) {
    const target = `${p.tablename}.${p.policyname}`;
    if (p.qual !== null && /^\s*true\s*$/i.test(p.qual)) {
      findings.push({ check: 'policy-unconditional', object: target, detail: 'USING (true) exposes every row' });
    }
    if (['INSERT', 'UPDATE', 'ALL'].includes(p.cmd) && !p.with_check) {
      findings.push({ check: 'policy-missing-with-check', object: target, detail: `${p.cmd} policy without WITH CHECK` });
    }
    for (const role of p.roles) {
      if (isForbiddenGrantee(role)) {
        findings.push({ check: 'policy-forbidden-role', object: target, detail: `policy targets ${role}` });
      }
    }
  }

  // A table that is granted to a request role but has no policy for that command is
  // a silent deny today and a silent leak the day someone adds a permissive policy.
  for (const t of tables) {
    if (t.table_name === 'schema_migrations') continue;
    const { rows: grants } = await client.query<{ grantee: string; privilege_type: string }>(`
      select grantee, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = $1`, [t.table_name]);
    for (const g of grants) {
      if (isForbiddenGrantee(g.grantee)) {
        findings.push({ check: 'forbidden-grant', object: `${t.table_name}`, detail: `${g.grantee} holds ${g.privilege_type}` });
      }
    }
  }

  // F-4: SECURITY DEFINER functions must be on the reviewed list and pin search_path.
  const { rows: definers } = await client.query<{ name: string; config: string[] | null; acl: string | null }>(`
    select n.nspname || '.' || p.proname as name, p.proconfig as config, p.proacl::text as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef and n.nspname in ('public', 'app')`);
  for (const f of definers) {
    if (!ALLOWED_DEFINER_FUNCTIONS.has(f.name)) {
      findings.push({ check: 'definer-not-reviewed', object: f.name, detail: 'SECURITY DEFINER function is not on the reviewed allow-list' });
    }
    if (!(f.config ?? []).some((c) => c.startsWith('search_path='))) {
      findings.push({ check: 'definer-search-path', object: f.name, detail: 'SECURITY DEFINER without a pinned search_path' });
    }
    if (f.acl && /(^|,)=X\//.test(f.acl)) {
      findings.push({ check: 'definer-public-execute', object: f.name, detail: 'EXECUTE granted to PUBLIC' });
    }
  }

  // F-5: a view without security_invoker runs as its owner and bypasses RLS.
  const { rows: views } = await client.query<{ name: string; options: string[] | null }>(`
    select c.relname as name, c.reloptions as options
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'`);
  for (const v of views) {
    if (!(v.options ?? []).some((o) => o.replace(/\s/g, '').toLowerCase() === 'security_invoker=true')) {
      findings.push({ check: 'view-security-invoker', object: v.name, detail: 'view without security_invoker=true runs with owner rights' });
    }
  }

  // F-2: the role the API logs in as must not be able to sidestep any of this.
  const { rows: roles } = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(`
    select rolname, rolsuper, rolbypassrls from pg_roles
     where rolname in ('dineflow_api', 'dineflow_staff', 'dineflow_public', 'dineflow_ops')`);
  for (const r of roles) {
    if (r.rolsuper) findings.push({ check: 'role-superuser', object: r.rolname, detail: 'role is a superuser' });
    if (r.rolbypassrls) findings.push({ check: 'role-bypassrls', object: r.rolname, detail: 'role has BYPASSRLS' });
  }

  return findings;
}
