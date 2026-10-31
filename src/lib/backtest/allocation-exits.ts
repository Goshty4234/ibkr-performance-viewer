/** Book held on a chosen date, compared with today's target. */

/** Ignore leftovers below 0.1 % of the book. */
const HELD_PCT = 0.1;

export interface ExitedHolding {
  ticker: string;
  /** Allocation on the reference date, in percent. */
  prevPct: number;
}

export interface ReferenceBook {
  /** Trading session actually used. Null when the history is not loaded. */
  date: string | null;
  /** Ticker → allocation percent that session. Cash is excluded. */
  held: Map<string, number>;
}

/** Stored weights are fractions (0–1) or, in older payloads, already percents. */
function percentScale(weights: Record<string, (number | null)[]>): number {
  for (const series of Object.values(weights)) {
    for (const v of series) {
      if (v != null && v > 1.5) return 1;
    }
  }
  return 100;
}

/**
 * Session to read. An exact date wins. Otherwise the first session on or after
 * the request (the 1st of a month often falls on a weekend; the rebalance runs
 * the next open day). If the request is past the history, the last session.
 */
export function bookDate(dates: readonly string[], requested: string | null): string | null {
  if (!dates.length) return null;
  if (!requested) return dates[dates.length - 1];
  if (dates.includes(requested)) return requested;
  const after = dates.find((d) => d >= requested);
  return after ?? dates[dates.length - 1];
}

/** Holdings of the backtest at `requested` (snapped to a trading session). */
export function referenceBook(
  allocations: { dates: string[]; weights: Record<string, (number | null)[]> } | null | undefined,
  requested: string | null,
): ReferenceBook {
  if (!allocations?.dates.length) return { date: null, held: new Map() };
  const date = bookDate(allocations.dates, requested);
  if (!date) return { date: null, held: new Map() };
  const i = allocations.dates.indexOf(date);
  const scale = percentScale(allocations.weights);
  const heldMin = HELD_PCT / scale;
  const held = new Map<string, number>();
  for (const [ticker, series] of Object.entries(allocations.weights)) {
    if (!ticker || ticker === 'CASH') continue;
    const w = series[i];
    if (w != null && w > heldMin) held.set(ticker, w * scale);
  }
  return { date, held };
}

/** Names held on the reference date that are absent from today's target. */
export function exitsFromBook(held: ReadonlyMap<string, number>, current: ReadonlySet<string>): ExitedHolding[] {
  const out: ExitedHolding[] = [];
  for (const [ticker, prevPct] of held) {
    if (!current.has(ticker)) out.push({ ticker, prevPct });
  }
  out.sort((a, b) => b.prevPct - a.prevPct || a.ticker.localeCompare(b.ticker));
  return out;
}
