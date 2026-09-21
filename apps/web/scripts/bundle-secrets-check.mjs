#!/usr/bin/env node
// Fails if anything that must stay on the server appears in the browser bundle.
//
// Everything under dist/ is public the moment it is deployed. A server-only
// variable name appearing there means code that reads it was bundled, which is how
// secrets reach browsers by accident (threat T-31, NFR-S08).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const FORBIDDEN = [
  'SUPABASE_SERVICE_KEY', 'SUPABASE_JWT_SECRET', 'SUPABASE_DB_PASSWORD', 'DATABASE_URL',
  'QR_SIGNING_KEYS', 'sb_secret_', 'service_role', 'dineflow_api', 'postgres://', 'postgresql://',
];

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(dist);

let problems = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) {
      problems += 1;
      console.log(`  FAIL ${needle} found in ${file.replace(dist, 'dist')}`);
    }
  }
}
console.log(problems === 0
  ? `  ok   ${files.length} bundle files contain no server-only names`
  : `\n${problems} server-only reference(s) in the browser bundle`);
process.exit(problems === 0 ? 0 : 1);
