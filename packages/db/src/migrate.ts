// Minimal migration runner: ordered SQL files, each applied once, inside a transaction,
// recorded with its checksum. Kept dependency-free so it runs identically in CI, on a
// laptop and against Supabase (Part 1 §9).
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export type MigrationResult = { applied: string[]; skipped: string[] };

export type MigrateOptions = {
  /**
   * Re-run every migration even if it is already recorded. Migrations are written to
   * be idempotent, so this restores a schema that was altered out of band — used by
   * the sabotage canaries and the restore drill.
   */
  reapply?: boolean;
};

export async function migrate(connectionString: string, options: MigrateOptions = {}): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'select filename, checksum from schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous && !options.reapply) {
        // An edited migration means the database and the repository disagree about
        // history. Fail loudly rather than quietly running something different.
        if (previous !== checksum) {
          throw new Error(`migration ${file} changed after it was applied (expected ${previous}, got ${checksum})`);
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          `insert into schema_migrations (filename, checksum) values ($1, $2)
             on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()`,
          [file, checksum]);
        await client.query('commit');
        result.applied.push(file);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return result;
  } finally {
    await client.end();
  }
}

if (import.meta.filename === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(2);
  }
  const { applied, skipped } = await migrate(url);
  process.stdout.write(`applied ${applied.length} migration(s)${applied.length ? ': ' + applied.join(', ') : ''}; ` +
    `${skipped.length} already present\n`);
}
