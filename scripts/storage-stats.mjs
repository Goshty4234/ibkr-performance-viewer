// Prints how much the run history uses (rows + Storage bytes).
//   node scripts/storage-stats.mjs
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

const envFile = join(process.cwd(), '.env.local');
if (!process.env.DATABASE_URL && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const runs = await client.query(`select count(*)::int as n, coalesce(sum(result_size),0)::bigint as bytes,
    coalesce(avg(result_size),0)::bigint as avg_bytes, coalesce(max(result_size),0)::bigint as max_bytes,
    coalesce(avg(jsonb_array_length(summary)),0)::numeric(6,1) as avg_portfolios
    from public.backtest_runs`);
  const objects = await client.query(`select bucket_id, count(*)::int as files,
    coalesce(sum((metadata->>'size')::bigint),0)::bigint as bytes from storage.objects group by bucket_id`);
  const db = await client.query(`select pg_database_size(current_database())::bigint as bytes`);
  const lib = await client.query(`select count(*)::int as n from public.backtest_portfolios`);
  console.log(JSON.stringify({ runs: runs.rows[0], storage: objects.rows, database_bytes: db.rows[0].bytes, library: lib.rows[0] }, null, 2));
} finally {
  await client.end();
}
