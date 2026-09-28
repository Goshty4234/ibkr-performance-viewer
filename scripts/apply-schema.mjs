// Applies supabase/schema.sql (idempotent) using DATABASE_URL from .env.local.
//   node scripts/apply-schema.mjs
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

const root = process.cwd();
const envFile = join(root, '.env.local');
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(readFileSync(join(root, 'supabase', 'schema.sql'), 'utf8'));
  const { rows } = await client.query(`SELECT
    to_regclass('public.backtest_runs') IS NOT NULL AS runs,
    to_regclass('public.backtest_portfolios') IS NOT NULL AS portfolios,
    EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'backtest-results') AS bucket`);
  console.log('Schema applied:', rows[0]);
} finally {
  await client.end();
}
