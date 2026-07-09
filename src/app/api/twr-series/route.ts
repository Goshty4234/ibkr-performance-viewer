import { createClient } from '@/lib/supabase/server';
import { dbToStatement } from '@/lib/db-mapper';
import { ensureTwrSeriesTable } from '@/lib/db-migrate';
import { getIbkrTwrDailyPoints } from '@/lib/performance';
import { dbToTwrSeries, mergeTwrPoints } from '@/lib/twr-mapper';
import {
  hashIbkrAccountId,
  sanitizeImportLabel,
  sanitizeStatementForClient,
  sanitizeTwrForClient,
} from '@/lib/privacy';
import { verifyCsvAccountForPortfolio } from '@/lib/verify-csv-account';
import type { DailyTwrPoint } from '@/lib/types';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const portfolioAccountId = searchParams.get('portfolioAccountId');
  if (!portfolioAccountId) {
    return NextResponse.json({ error: 'Compte requis' }, { status: 400 });
  }

  await ensureTwrSeriesTable();

  const { data, error } = await supabase
    .from('twr_series')
    .select('*')
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId)
    .maybeSingle();

  if (error) {
    if (error.code === '42P01') {
      return NextResponse.json(
        { error: 'Table twr_series manquante — relancez /api/setup?secret=...' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (data) {
    return NextResponse.json(sanitizeTwrForClient(dbToTwrSeries(data)));
  }

  const { data: stmts } = await supabase
    .from('statements')
    .select('*')
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId)
    .order('period_start', { ascending: true });

  const points = getIbkrTwrDailyPoints((stmts ?? []).map(dbToStatement));
  if (points.length < 2) {
    return NextResponse.json(null);
  }

  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sanitizeStatementForClient(
    dbToStatement((stmts ?? [])[stmts!.length - 1]),
  );
  return NextResponse.json(
    sanitizeTwrForClient({
      id: 'legacy',
      user_id: user.id,
      portfolioAccountId,
      accountId: '',
      accountAlias: '',
      baseCurrency: latest.baseCurrency,
      periodStart: sorted[0].date,
      periodEnd: sorted[sorted.length - 1].date,
      twrr: latest.twrr,
      filename: sanitizeImportLabel('twr', sorted[0].date, sorted[sorted.length - 1].date),
      points: sorted,
      imported_at: latest.imported_at,
    }),
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  await ensureTwrSeriesTable();

  const body = await request.json();
  const portfolioAccountId = body.portfolioAccountId as string;
  const accountId = body.accountId as string;
  const incoming = body.points as DailyTwrPoint[] | undefined;

  if (!portfolioAccountId) {
    return NextResponse.json({ error: 'Compte requis' }, { status: 400 });
  }
  if (!incoming?.length) {
    return NextResponse.json({ error: 'Points TWR journaliers requis' }, { status: 400 });
  }

  const verify = await verifyCsvAccountForPortfolio(
    supabase,
    user.id,
    portfolioAccountId,
    accountId,
  );
  if (!verify.ok) {
    return NextResponse.json({ error: verify.error }, { status: verify.status });
  }

  const sorted = [...incoming].sort((a, b) => a.date.localeCompare(b.date));
  const periodStart = (body.periodStart as string) || sorted[0].date;
  const periodEnd = (body.periodEnd as string) || sorted[sorted.length - 1].date;

  const { data: existing } = await supabase
    .from('twr_series')
    .select('*')
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId)
    .maybeSingle();

  const merged = mergeTwrPoints(
    existing ? ((existing.points as DailyTwrPoint[]) ?? []) : [],
    sorted,
  );

  const row = {
    user_id: user.id,
    portfolio_account_id: portfolioAccountId,
    account_id: hashIbkrAccountId(accountId, user.id),
    account_alias: '',
    base_currency: body.baseCurrency ?? 'CAD',
    period_start: periodStart,
    period_end: periodEnd,
    twrr: body.twrr ?? 0,
    filename: sanitizeImportLabel('twr', periodStart, periodEnd),
    points: merged,
    imported_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabase
      .from('twr_series')
      .update(row)
      .eq('id', existing.id)
      .eq('user_id', user.id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({
      series: sanitizeTwrForClient(dbToTwrSeries(data)),
      meta: { action: 'updated', days: merged.length },
    });
  }

  const { data, error } = await supabase.from('twr_series').insert(row).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    series: sanitizeTwrForClient(dbToTwrSeries(data)),
    meta: { action: 'created', days: merged.length },
  });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const portfolioAccountId = searchParams.get('portfolioAccountId');
  if (!portfolioAccountId) {
    return NextResponse.json({ error: 'Compte requis' }, { status: 400 });
  }

  const { error } = await supabase
    .from('twr_series')
    .delete()
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
