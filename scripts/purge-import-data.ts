/**
 * Purge all imported CSV data (statements, NAV, TWR) and reset IBKR account links.
 * Keeps workspace accounts (display names). Usage: npx tsx scripts/purge-import-data.ts
 */
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
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

async function main() {
  loadEnv();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL manquant dans .env.local');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const before = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.statements) AS statements,
        (SELECT COUNT(*)::int FROM public.nav_series) AS nav_series,
        (SELECT COUNT(*)::int FROM public.twr_series) AS twr_series,
        (SELECT COUNT(*)::int FROM public.accounts) AS accounts
    `);
    console.log('Avant purge:', before.rows[0]);

    await client.query('BEGIN');
    await client.query('DELETE FROM public.statements');
    await client.query('DELETE FROM public.nav_series');
    await client.query('DELETE FROM public.twr_series');

    const { rows: accountRows } = await client.query<{ id: string }>(
      'SELECT id FROM public.accounts',
    );
    for (const row of accountRows) {
      await client.query(
        `UPDATE public.accounts
         SET ibkr_account_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [`pending:${randomUUID()}`, row.id],
      );
    }

    await client.query('COMMIT');

    const after = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.statements) AS statements,
        (SELECT COUNT(*)::int FROM public.nav_series) AS nav_series,
        (SELECT COUNT(*)::int FROM public.twr_series) AS twr_series,
        (SELECT COUNT(*)::int FROM public.accounts) AS accounts
    `);
    console.log('Après purge:', after.rows[0]);
    console.log('OK — données CSV supprimées, comptes workspace conservés (liens IBKR réinitialisés).');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
