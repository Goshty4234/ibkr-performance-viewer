/**
 * Migre twr_series + valide la courbe depuis le CSV Performance IBKR.
 * Usage: npx tsx scripts/migrate-and-validate-twr.ts [fichier.csv]
 */
import { readFileSync, existsSync } from 'fs';
import pg from 'pg';
import {
  isIbkrPerformanceReportCsv,
  parseIbkrPerformanceReportCsv,
} from '../src/lib/ibkr-performance-report';
import { buildCurveFromIbkrTwrDaily } from '../src/lib/performance';

function loadEnv() {
  if (!existsSync('.env.local')) return;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
}

async function main() {
  loadEnv();
  const file = process.argv[2] ?? 'Nicolas_Cool_U16150944_December_02_2024_July_08_2026.csv';
  const text = readFileSync(file, 'utf8');
  if (!isIbkrPerformanceReportCsv(text)) throw new Error('Not a performance report CSV');

  const parsed = parseIbkrPerformanceReportCsv(text, file);
  const curve = buildCurveFromIbkrTwrDaily(
    parsed.twrDaily ?? [],
    parsed.periodStart,
    parsed.periodEnd,
  );
  const values = curve.map((p) => p.portfolio);
  const r2 = (() => {
    const n = values.length;
    const xs = values.map((_, i) => i);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = values.reduce((a, b) => a + b, 0) / n;
    let ssTot = 0;
    let ssRes = 0;
    const slope =
      xs.reduce((s, x, i) => s + (x - meanX) * (values[i] - meanY), 0) /
      xs.reduce((s, x) => s + (x - meanX) ** 2, 0);
    const intercept = meanY - slope * meanX;
    for (let i = 0; i < n; i++) {
      const pred = intercept + slope * xs[i];
      ssRes += (values[i] - pred) ** 2;
      ssTot += (values[i] - meanY) ** 2;
    }
    return ssTot > 0 ? 1 - ssRes / ssTot : 1;
  })();

  console.log('CSV parse:', parsed.twrDaily?.length, 'days, TWRR', (parsed.twrr * 100).toFixed(2) + '%');
  console.log('Curve end:', curve.at(-1)?.portfolio.toFixed(2) + '%', 'linear R2:', r2.toFixed(4));

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('No DATABASE_URL — skip DB migration test');
    process.exit(r2 < 0.999 ? 0 : 1);
  }

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(readFileSync('supabase/schema.sql', 'utf8'));

  const col = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'twr_series'
    ) AS ok
  `);
  console.log('twr_series table:', col.rows[0]?.ok);

  await client.end();
  process.exit(r2 < 0.999 && (parsed.twrDaily?.length ?? 0) >= 100 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
