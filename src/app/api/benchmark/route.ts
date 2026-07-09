import { NextRequest, NextResponse } from 'next/server';
import type { BenchmarkSymbol } from '@/lib/types';

const SYMBOL_MAP: Record<BenchmarkSymbol, string> = {
  SPY: 'SPY',
  QQQ: 'QQQ',
  XIU: 'XIU.TO',
};

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const symbol = (searchParams.get('symbol') || 'SPY').toUpperCase() as BenchmarkSymbol;
  const start = searchParams.get('start');
  const end = searchParams.get('end');

  if (!SYMBOL_MAP[symbol]) {
    return NextResponse.json({ error: 'Symbole invalide' }, { status: 400 });
  }
  if (!start || !end) {
    return NextResponse.json({ error: 'Paramètres start et end requis' }, { status: 400 });
  }

  const period1 = Math.floor(new Date(start + 'T12:00:00Z').getTime() / 1000);
  const period2 = Math.floor(new Date(end + 'T12:00:00Z').getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL_MAP[symbol])}?period1=${period1}&period2=${period2}&interval=1d`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 IBKR-Performance-Viewer' },
      next: { revalidate: 3600 },
    });
    if (!response.ok) {
      return NextResponse.json({ error: 'Yahoo Finance indisponible' }, { status: 502 });
    }

    const json = await response.json();
    const result = json?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];

    const prices: Record<string, number> = {};
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null) continue;
      prices[new Date(timestamps[i] * 1000).toISOString().slice(0, 10)] = close;
    }

    return NextResponse.json({ symbol, prices });
  } catch {
    return NextResponse.json({ error: 'Erreur benchmark' }, { status: 500 });
  }
}
