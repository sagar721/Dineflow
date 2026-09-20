// Sabotage canaries (ISO-09).
//
// A test suite that has never been observed to fail is not evidence. Each canary
// deliberately breaks one protection, confirms the harness notices, and then repairs
// the damage by re-running the (idempotent) migrations. If a canary is NOT detected,
// the harness itself is broken and the run fails — which is the point.
import pg from 'pg';
import { runSchemaGuards } from '../src/schema-guard.ts';
import { runIsolationMatrix, type Check } from './harness.ts';
import { seed } from './fixtures.ts';
import { migrate } from '../src/migrate.ts';

export type Canary = {
  name: string;
  /** What we break. Runs as the migration owner. */
  sabotage: string[];
  /** Extra repair beyond re-running migrations, if the migrations cannot undo it. */
  repair?: string[];
  /** Which detector must notice: the structural guard, the behavioural matrix, or either. */
  detectedBy: 'guard' | 'matrix' | 'either';
};

export const CANARIES: Canary[] = [
  {
    name: 'RLS disabled on a tenant table',
    sabotage: ['alter table restaurant_users disable row level security'],
    detectedBy: 'either',
  },
  {
    name: 'FORCE RLS removed (table owner would bypass policies)',
    sabotage: ['alter table restaurant_users no force row level security'],
    detectedBy: 'guard',
  },
  {
    name: 'tenant read policy replaced with USING (true)',
    sabotage: [
      'drop policy if exists staff_read on restaurant_users',
      'create policy staff_read on restaurant_users for select to dineflow_staff using (true)',
    ],
    detectedBy: 'either',
  },
  {
    name: 'policy dropped entirely',
    sabotage: ['drop policy if exists restaurants_staff_read on restaurants'],
    detectedBy: 'matrix',
  },
  {
    name: 'table granted to PUBLIC',
    sabotage: ['grant select on restaurant_users to public'],
    repair: ['revoke all on restaurant_users from public'],
    detectedBy: 'guard',
  },
  {
    name: 'API login role given BYPASSRLS',
    sabotage: ['alter role dineflow_api bypassrls'],
    repair: ['alter role dineflow_api nobypassrls'],
    detectedBy: 'guard',
  },
  {
    name: 'new tenant table created without RLS',
    sabotage: [
      `create table probe_tenant_data (
         id uuid primary key default gen_random_uuid(),
         restaurant_id uuid not null references restaurants(id),
         note text)`,
      'grant select on probe_tenant_data to dineflow_staff',
    ],
    repair: ['drop table if exists probe_tenant_data'],
    detectedBy: 'either',
  },
  {
    name: 'SECURITY DEFINER function added outside the reviewed list',
    sabotage: [
      `create function app.probe_backdoor() returns setof restaurants
         language sql security definer as 'select * from restaurants'`,
    ],
    repair: ['drop function if exists app.probe_backdoor()'],
    detectedBy: 'guard',
  },
  {
    name: 'view without security_invoker exposes a tenant table',
    sabotage: ['create view probe_all_restaurants as select * from restaurants'],
    repair: ['drop view if exists probe_all_restaurants'],
    detectedBy: 'guard',
  },
];

type Detect = { guard: boolean; matrix: boolean };

async function detect(owner: pg.Client, api: pg.Client, connectionString: string): Promise<Detect> {
  const findings = await runSchemaGuards(owner);
  let matrixFailed = false;
  try {
    const fx = await seed(owner);
    const { checks } = await runIsolationMatrix(api, fx);
    matrixFailed = checks.some((c) => !c.passed);
  } catch {
    matrixFailed = true; // a probe that cannot even run counts as detection
  }
  void connectionString;
  return { guard: findings.length > 0, matrix: matrixFailed };
}

export async function runCanaries(
  owner: pg.Client,
  api: pg.Client,
  connectionString: string,
): Promise<Check[]> {
  const checks: Check[] = [];

  for (const canary of CANARIES) {
    for (const sql of canary.sabotage) await owner.query(sql);
    let detected: Detect;
    try {
      detected = await detect(owner, api, connectionString);
    } finally {
      for (const sql of canary.repair ?? []) await owner.query(sql);
      await migrate(connectionString, { reapply: true }); // restores policies, grants and RLS
    }

    const noticed =
      canary.detectedBy === 'guard' ? detected.guard
      : canary.detectedBy === 'matrix' ? detected.matrix
      : detected.guard || detected.matrix;

    checks.push({
      name: `canary detected: ${canary.name}`,
      passed: noticed,
      detail: noticed ? undefined : `sabotage went unnoticed (guard=${detected.guard} matrix=${detected.matrix})`,
    });

    // The repair must leave the schema clean again, or later canaries test nothing.
    const after = await runSchemaGuards(owner);
    checks.push({
      name: `schema repaired after: ${canary.name}`,
      passed: after.length === 0,
      detail: after.length ? after.map((f) => `${f.check}:${f.object}`).join(', ') : undefined,
    });
  }

  return checks;
}
