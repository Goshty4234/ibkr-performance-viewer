import { NextRequest, NextResponse } from 'next/server';

const CURRENCIES = new Set(['USD', 'CAD', 'EUR', 'GBP', 'JPY', 'AUD', 'CHF']);

async function quote(pair: string): Promise<{ rate: number; time: number } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair)}?range=5d&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 IBKR-Performance-Viewer' },
    next: { revalidate: 4 * 3600 },
  });
  if (!res.ok) return null;
  const meta = (await res.json())?.chart?.result?.[0]?.meta;
  const rate = Number(meta?.regularMarketPrice);
  return Number.isFinite(rate) && rate > 0 ? { rate, time: Number(meta?.regularMarketTime) || 0 } : null;
}

/** Exchange rate for the Allocations currency converter (1 `from` = rate `to`). */
export async function GET(request: NextRequest) {
  const from = (request.nextUrl.searchParams.get('from') || '').toUpperCase();
  const to = (request.nextUrl.searchParams.get('to') || '').toUpperCase();
  if (!CURRENCIES.has(from) || !CURRENCIES.has(to)) {
    return NextResponse.json({ error: 'Devise non prise en charge' }, { status: 400 });
  }
  if (from === to) return NextResponse.json({ from, to, rate: 1, as_of: new Date().toISOString() });
  try {
    // Yahoo only lists some pairs one way (e.g. USDCAD=X); fall back to the inverse.
    const direct = await quote(`${from}${to}=X`);
    const inverse = direct ? null : await quote(`${to}${from}=X`);
    const q = direct ?? (inverse ? { rate: 1 / inverse.rate, time: inverse.time } : null);
    if (!q) return NextResponse.json({ error: 'Taux indisponible (Yahoo Finance)' }, { status: 502 });
    return NextResponse.json({
      from,
      to,
      rate: q.rate,
      as_of: q.time ? new Date(q.time * 1000).toISOString() : new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ error: 'Taux indisponible (Yahoo Finance)' }, { status: 502 });
  }
}
