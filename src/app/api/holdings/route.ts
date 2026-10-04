import { createClient } from '@/lib/supabase/server';
import { dbToHoldings, mergeHoldings } from '@/lib/holdings-db';
import type { HoldingDay, HoldingsData, HoldingSymbol, HoldingTrade } from '@/lib/ibkr-flex-holdings';
import { NextResponse } from 'next/server';

const MISSING_TABLE = 'Table holdings_series manquante — lancez /api/setup?secret=... sur Vercel';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const portfolioAccountId = new URL(request.url).searchParams.get('portfolioAccountId');
  if (!portfolioAccountId) return NextResponse.json({ error: 'Compte requis' }, { status: 400 });

  const { data, error } = await supabase
    .from('holdings_series')
    .select('*')
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId)
    .maybeSingle();

  if (error) {
    // A missing table is not an error for the page: there are simply no positions yet.
    if (error.code === '42P01' || /holdings_series/.test(error.message)) {
      return NextResponse.json(null);
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ? dbToHoldings(data) : null);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const body = await request.json();
  const portfolioAccountId = body.portfolioAccountId as string;
  const incoming: HoldingsData = {
    symbols: (body.symbols as HoldingSymbol[]) ?? [],
    days: (body.days as HoldingDay[]) ?? [],
    trades: (body.trades as HoldingTrade[]) ?? [],
  };
  if (!portfolioAccountId) return NextResponse.json({ error: 'Compte requis' }, { status: 400 });
  if (!incoming.days.length && !incoming.trades.length) {
    return NextResponse.json({ error: 'Positions ou transactions requises' }, { status: 400 });
  }

  const { data: account } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', portfolioAccountId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!account) return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });

  const { data: existing, error: readError } = await supabase
    .from('holdings_series')
    .select('*')
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId)
    .maybeSingle();
  if (readError) {
    const missing = readError.code === '42P01' || /holdings_series/.test(readError.message);
    return NextResponse.json({ error: missing ? MISSING_TABLE : readError.message }, { status: missing ? 503 : 500 });
  }

  const merged = mergeHoldings(existing ? dbToHoldings(existing) : null, incoming);
  const row = {
    user_id: user.id,
    portfolio_account_id: portfolioAccountId,
    base_currency: body.baseCurrency ?? existing?.base_currency ?? 'CAD',
    period_start: merged.days[0]?.date ?? merged.trades[0]?.date,
    period_end: merged.days[merged.days.length - 1]?.date ?? merged.trades[merged.trades.length - 1]?.date,
    symbols: merged.symbols,
    days: merged.days,
    trades: merged.trades,
    imported_at: new Date().toISOString(),
  };

  const query = existing
    ? supabase.from('holdings_series').update(row).eq('id', existing.id).eq('user_id', user.id)
    : supabase.from('holdings_series').insert(row);
  const { data, error } = await query.select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    holdings: dbToHoldings(data),
    meta: { days: merged.days.length, symbols: merged.symbols.length, trades: merged.trades.length },
  });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const portfolioAccountId = new URL(request.url).searchParams.get('portfolioAccountId');
  if (!portfolioAccountId) return NextResponse.json({ error: 'Compte requis' }, { status: 400 });

  const { error } = await supabase
    .from('holdings_series')
    .delete()
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
