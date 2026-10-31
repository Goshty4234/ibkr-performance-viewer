import type { MetricsColumns, ReturnsRow } from '@/lib/engine/types';

const EMPTY_PERIODS = { '1W': null, '1M': null, '3M': null, '6M': null, '1Y': null } as const;

function finite(v: number | string | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Same scaling as the engine's returns table: fractions become percents, values already above 3 stay. */
function asPct(v: number | null): number | null {
  if (v === null) return null;
  return v <= 3 ? v * 100 : v;
}

/**
 * Adds every name scored on the last metrics date that the returns call did not
 * already list. Period returns stay empty for those names: they are not sent
 * back to Yahoo. Momentum is the score already stored by the backtest.
 */
export function supplementReturns(rows: ReturnsRow[] | null, metrics: MetricsColumns | undefined): ReturnsRow[] | null {
  if (!rows) return null;
  if (!metrics?.dates.length) return rows;
  const last = metrics.dates.length - 1;
  const seen = new Set(rows.map((r) => r.ticker));
  const extra: ReturnsRow[] = [];
  metrics.date_idx.forEach((d, row) => {
    if (d !== last) return;
    const ticker = metrics.tickers[metrics.ticker_idx[row]];
    if (!ticker || ticker === 'CASH' || seen.has(ticker)) return;
    seen.add(ticker);
    const momentum = finite(metrics.values.Momentum?.[row]);
    extra.push({
      ticker,
      weight: 0,
      momentum: momentum === null ? null : momentum * 100,
      beta: finite(metrics.values.Beta?.[row]),
      volatility: asPct(finite(metrics.values.Volatility?.[row])),
      ...EMPTY_PERIODS,
    });
  });
  return extra.length ? [...rows, ...extra] : rows;
}
