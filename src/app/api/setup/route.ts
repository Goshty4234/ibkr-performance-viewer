import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';
import pg from 'pg';

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (!secret || secret !== process.env.SETUP_SECRET) {
    return NextResponse.json({ error: 'Secret invalide' }, { status: 401 });
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json(
      { error: 'DATABASE_URL manquant dans Vercel' },
      { status: 500 },
    );
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const check = await client.query(
      `SELECT
        to_regclass('public.accounts') AS accounts_tbl,
        to_regclass('public.statements') AS statements_tbl,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'statements'
            AND column_name = 'daily_events'
        ) AS has_daily_events,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'statements'
            AND column_name = 'portfolio_account_id'
        ) AS has_portfolio_account_id,
        to_regclass('public.nav_series') AS nav_series_tbl`,
    );
    const hasAccounts = Boolean(check.rows[0]?.accounts_tbl);
    const hasStatements = Boolean(check.rows[0]?.statements_tbl);
    const hasDailyEvents = Boolean(check.rows[0]?.has_daily_events);
    const hasPortfolioAccountId = Boolean(check.rows[0]?.has_portfolio_account_id);
    const hasNavSeries = Boolean(check.rows[0]?.nav_series_tbl);

    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'schema.sql'),
      'utf8',
    );

    if (!hasAccounts || !hasStatements || !hasDailyEvents || !hasPortfolioAccountId || !hasNavSeries) {
      await client.query(sql);
      return NextResponse.json({
        ok: true,
        message: !hasStatements
          ? 'Base de données initialisée avec succès ✓'
          : !hasAccounts
            ? 'Migration comptes appliquée ✓'
            : !hasDailyEvents
              ? 'Migration daily_events appliquée ✓'
              : !hasPortfolioAccountId
                ? 'Migration portfolio_account_id appliquée ✓'
                : 'Migration nav_series appliquée ✓',
      });
    }

    return NextResponse.json({
      ok: true,
      message: 'Base de données déjà configurée ✓',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
  }
}

/** POST body: { migrate: true } — adds accounts table to existing DB */
export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (!secret || secret !== process.env.SETUP_SECRET) {
    return NextResponse.json({ error: 'Secret invalide' }, { status: 401 });
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json({ error: 'DATABASE_URL manquant' }, { status: 500 });
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const sql = readFileSync(join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');
    await client.query(sql);
    return NextResponse.json({ ok: true, message: 'Migration appliquée ✓' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
  }
}
