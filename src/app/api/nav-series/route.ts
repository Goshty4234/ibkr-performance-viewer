import { cashFlowsToDateMap } from '@/lib/ibkr-flex-cash';
import { createClient } from '@/lib/supabase/server';
import { dbToNavSeries, mergeNavPoints } from '@/lib/nav-mapper';
import type { CashFlow, DailyNavPoint } from '@/lib/types';
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

  const { data, error } = await supabase
    .from('nav_series')
    .select('*')
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId)
    .maybeSingle();

  if (error) {
    if (error.code === '42P01') {
      return NextResponse.json(
        { error: 'Table nav_series manquante — lancez /api/setup?secret=...' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ? dbToNavSeries(data) : null);
}

function mergeCashFlows(existing: CashFlow[], incoming: CashFlow[]): CashFlow[] {
  const map = cashFlowsToDateMap([...existing, ...incoming]);
  return [...map.entries()].map(([date, amount]) => ({
    date,
    amount,
    description: '',
    isExternal: true,
  }));
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const userId = user.id;

  const body = await request.json();
  const portfolioAccountId = body.portfolioAccountId as string;
  const accountId = body.accountId as string;
  const incoming = body.points as DailyNavPoint[] | undefined;
  const incomingFlows = body.cashFlows as CashFlow[] | undefined;

  if (!portfolioAccountId || !accountId) {
    return NextResponse.json({ error: 'Compte requis' }, { status: 400 });
  }
  if (!incoming?.length && !incomingFlows?.length) {
    return NextResponse.json({ error: 'Données NAV ou Cash Transactions requises' }, { status: 400 });
  }

  const { data: portfolioAccount } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', portfolioAccountId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!portfolioAccount) {
    return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
  }

  const { data: existing } = await supabase
    .from('nav_series')
    .select('*')
    .eq('user_id', userId)
    .eq('portfolio_account_id', portfolioAccountId)
    .maybeSingle();

  const merged = incoming?.length
    ? mergeNavPoints(existing ? (existing.points as DailyNavPoint[]) : [], incoming)
    : (existing?.points as DailyNavPoint[]) ?? [];
  const mergedFlows = incomingFlows?.length
    ? mergeCashFlows(existing ? (existing.cash_flows as CashFlow[]) ?? [] : [], incomingFlows)
    : (existing?.cash_flows as CashFlow[]) ?? [];

  if (!merged.length && !existing) {
    return NextResponse.json({ error: 'Importez d\'abord un Flex NAV' }, { status: 400 });
  }

  const periodStart = merged[0]?.date ?? existing?.period_start ?? incomingFlows![0].date;
  const periodEnd =
    merged[merged.length - 1]?.date ?? existing?.period_end ?? incomingFlows!.at(-1)!.date;
  const now = new Date().toISOString();

  const row = {
    user_id: userId,
    portfolio_account_id: portfolioAccountId,
    account_id: accountId,
    account_alias: body.accountAlias ?? existing?.account_alias ?? '',
    base_currency: body.baseCurrency ?? existing?.base_currency ?? 'CAD',
    period_start: periodStart,
    period_end: periodEnd,
    filename: body.filename ?? existing?.filename ?? 'flex-nav.csv',
    points: merged,
    cash_flows: mergedFlows,
    imported_at: now,
  };

  const rowWithoutCashFlows = { ...row };
  delete (rowWithoutCashFlows as { cash_flows?: CashFlow[] }).cash_flows;

  async function persist(payload: typeof row | typeof rowWithoutCashFlows) {
    if (existing) {
      return supabase
        .from('nav_series')
        .update(payload)
        .eq('id', existing.id)
        .eq('user_id', userId)
        .select()
        .single();
    }
    return supabase.from('nav_series').insert(payload).select().single();
  }

  let { data, error } = await persist(row);
  let cashFlowsStored = true;
  if (error && /cash_flows/i.test(error.message)) {
    ({ data, error } = await persist(rowWithoutCashFlows));
    cashFlowsStored = false;
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    series: dbToNavSeries(data),
    meta: {
      action: existing ? 'updated' : 'created',
      days: merged.length,
      added: incoming?.length ?? 0,
      cashFlowDays: mergedFlows.length,
      cashFlowsStored,
      ...(cashFlowsStored
        ? {}
        : { warning: 'Colonne cash_flows absente — lancez /api/setup?secret=... sur Vercel' }),
    },
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
    .from('nav_series')
    .delete()
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
