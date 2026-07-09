/** Diagnose twr_daily in database. Usage: npx tsx scripts/diag-db-twr.ts */
import { readFileSync, existsSync } from 'fs';
import pg from 'pg';

function loadEnv() {
  const path = '.env.local';
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

loadEnv();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const col = await client.query(`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'statements' AND column_name = 'twr_daily'
  ) AS has_col
`);
console.log('twr_daily column:', col.rows[0]?.has_col);

const rows = await client.query(`
  SELECT id, filename, period_start, period_end, twrr,
    jsonb_array_length(COALESCE(twr_daily, '[]'::jsonb)) AS twr_days,
    jsonb_array_length(COALESCE(daily_events, '[]'::jsonb)) AS event_days
  FROM public.statements
  ORDER BY imported_at DESC
  LIMIT 10
`);
console.log('\nRecent statements:');
for (const r of rows.rows) {
  console.log(
    `  ${r.filename} | ${r.period_start}..${r.period_end} | twrr=${(Number(r.twrr) * 100).toFixed(1)}% | twr_days=${r.twr_days} | events=${r.event_days}`,
  );
}

await client.end();
