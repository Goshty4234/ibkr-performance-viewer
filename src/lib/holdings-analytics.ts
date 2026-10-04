import type { DailyNavPoint } from './types';
import type { HoldingsData, HoldingTrade } from './ibkr-flex-holdings';

/** Pure calculations behind the positions panel: allocation, evolution, positions table, trades and fees. */

export interface AllocationItem {
  key: string;
  symbol: string;
  label: string;
  assetClass: string;
  /** Value in base currency (negative for a short). */
  value: number;
  /** Share of the account total (cash included), in %. */
  pct: number;
}

export const CASH_KEY = '__cash__';
export const OTHERS_KEY = '__others__';

function navAtOrBefore(nav: DailyNavPoint[], date: string): DailyNavPoint | null {
  let lo = 0;
  let hi = nav.length - 1;
  let best: DailyNavPoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nav[mid].date <= date) { best = nav[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Index of the last holdings day on or before `date` (-1 when there is none). */
export function dayIndexAtOrBefore(h: HoldingsData, date: string): number {
  let lo = 0;
  let hi = h.days.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h.days[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Everything held on one day, with the account's cash, as shares of the account total. */
export function allocationAt(h: HoldingsData, nav: DailyNavPoint[], dayIndex: number): AllocationItem[] {
  const day = h.days[dayIndex];
  if (!day) return [];
  const point = navAtOrBefore(nav, day.date);
  const positions = day.positions.map((p) => ({
    key: `${h.symbols[p.s].assetClass}|${h.symbols[p.s].symbol}`,
    symbol: h.symbols[p.s].symbol,
    label: h.symbols[p.s].label,
    assetClass: h.symbols[p.s].assetClass,
    value: p.value,
  }));
  const held = positions.reduce((a, p) => a + p.value, 0);
  const cash = point?.cash ?? null;
  const total = point?.total ?? held + (cash ?? 0);
  const items: AllocationItem[] = positions.map((p) => ({ ...p, pct: total > 0 ? (p.value / total) * 100 : 0 }));
  if (cash !== null && Math.abs(cash) > 0.005) {
    items.push({ key: CASH_KEY, symbol: 'Cash', label: 'Cash', assetClass: 'CASH', value: cash, pct: total > 0 ? (cash / total) * 100 : 0 });
  }
  return items.sort((a, b) => b.value - a.value);
}

/** Small slices (under `minPct`) are merged so the donut stays readable. Shorts and negative cash stay out of it. */
export function donutSlices(items: AllocationItem[], minPct = 2): AllocationItem[] {
  const longs = items.filter((i) => i.value > 0);
  const big = longs.filter((i) => i.pct >= minPct || i.key === CASH_KEY);
  const small = longs.filter((i) => !(i.pct >= minPct || i.key === CASH_KEY));
  if (small.length > 1) {
    big.push({
      key: OTHERS_KEY,
      symbol: 'Autres',
      label: `${small.length} autres positions`,
      assetClass: 'MIX',
      value: small.reduce((a, i) => a + i.value, 0),
      pct: small.reduce((a, i) => a + i.pct, 0),
    });
  } else {
    big.push(...small);
  }
  return big.sort((a, b) => b.value - a.value);
}

export interface EvolutionResult {
  /** Series keys in stacking order (largest first); Cash and Others last. */
  keys: { key: string; label: string }[];
  /** One row per date with each key's share of the account total, in %. */
  rows: Record<string, number | string>[];
}

/**
 * Weight of each holding over time, for the stacked chart. The `top` holdings with the largest average
 * weight over the range are drawn one by one; the others are grouped.
 */
export function evolution(
  h: HoldingsData,
  nav: DailyNavPoint[],
  start: string,
  end: string,
  top = 12,
  maxPoints = 260,
): EvolutionResult {
  const dayIdx: number[] = [];
  for (let i = 0; i < h.days.length; i++) {
    if (h.days[i].date >= start && h.days[i].date <= end) dayIdx.push(i);
  }
  if (dayIdx.length < 2) return { keys: [], rows: [] };

  const avg = new Map<string, { label: string; sum: number }>();
  const perDay = dayIdx.map((i) => allocationAt(h, nav, i));
  for (const items of perDay) {
    for (const it of items) {
      if (it.key === CASH_KEY || it.value <= 0) continue;
      const cur = avg.get(it.key) ?? { label: it.symbol, sum: 0 };
      cur.sum += it.pct;
      avg.set(it.key, cur);
    }
  }
  const ranked = [...avg.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const shown = new Set(ranked.slice(0, top).map(([k]) => k));
  const keys = ranked.slice(0, top).map(([key, v]) => ({ key, label: v.label }));
  const hasOthers = ranked.length > top;
  if (hasOthers) keys.push({ key: OTHERS_KEY, label: 'Autres' });
  keys.push({ key: CASH_KEY, label: 'Cash' });

  const step = Math.max(1, Math.ceil(dayIdx.length / maxPoints));
  const rows: Record<string, number | string>[] = [];
  perDay.forEach((items, n) => {
    if (n % step !== 0 && n !== perDay.length - 1) return;
    const row: Record<string, number | string> = { date: h.days[dayIdx[n]].date };
    for (const k of keys) row[k.key] = 0;
    for (const it of items) {
      if (it.value <= 0) continue; // shorts do not add to the stack
      const k = it.key === CASH_KEY ? CASH_KEY : shown.has(it.key) ? it.key : OTHERS_KEY;
      row[k] = (row[k] as number) + it.pct;
    }
    rows.push(row);
  });
  return { keys, rows };
}

export interface PositionRow extends AllocationItem {
  qty: number;
  price: number;
  cost: number;
  pnl: number;
  pnlPct: number | null;
}

export function positionsAt(h: HoldingsData, nav: DailyNavPoint[], dayIndex: number): PositionRow[] {
  const day = h.days[dayIndex];
  if (!day) return [];
  const alloc = allocationAt(h, nav, dayIndex).filter((a) => a.key !== CASH_KEY);
  const byKey = new Map(alloc.map((a) => [a.key, a]));
  return day.positions.map((p) => {
    const s = h.symbols[p.s];
    const a = byKey.get(`${s.assetClass}|${s.symbol}`)!;
    return {
      ...a,
      qty: p.qty,
      price: p.price,
      cost: p.cost,
      pnl: p.pnl,
      pnlPct: Math.abs(p.cost) > 0.005 ? (p.pnl / Math.abs(p.cost)) * 100 : null,
    };
  });
}

export interface TradeStats {
  count: number;
  buys: number;
  sells: number;
  commissions: number;
  taxes: number;
  /** Commissions + taxes (always >= 0: what trading cost). */
  fees: number;
  realized: number;
  /** Money traded (absolute proceeds of stock and option trades). */
  volume: number;
  byMonth: { month: string; fees: number; realized: number; trades: number }[];
  bySymbol: { symbol: string; label: string; trades: number; fees: number; realized: number }[];
}

export function tradeStats(trades: HoldingTrade[], start: string, end: string): TradeStats {
  const t = trades.filter((x) => x.date >= start && x.date <= end);
  const months = new Map<string, { fees: number; realized: number; trades: number }>();
  const symbols = new Map<string, { label: string; trades: number; fees: number; realized: number }>();
  let commissions = 0;
  let taxes = 0;
  let realized = 0;
  let volume = 0;
  for (const x of t) {
    commissions += -x.commission;
    taxes += -x.taxes;
    realized += x.realized;
    if (x.assetClass !== 'CASH' && x.assetClass !== 'TAX') volume += Math.abs(x.proceeds);
    const m = months.get(x.date.slice(0, 7)) ?? { fees: 0, realized: 0, trades: 0 };
    m.fees += -x.commission - x.taxes;
    m.realized += x.realized;
    if (x.assetClass !== 'TAX') m.trades++;
    months.set(x.date.slice(0, 7), m);
    if (x.assetClass !== 'CASH' && x.assetClass !== 'TAX') {
      const s = symbols.get(x.symbol) ?? { label: x.label, trades: 0, fees: 0, realized: 0 };
      s.trades++;
      s.fees += -x.commission - x.taxes;
      s.realized += x.realized;
      symbols.set(x.symbol, s);
    }
  }
  return {
    count: t.filter((x) => x.assetClass !== 'TAX').length,
    buys: t.filter((x) => x.side === 'BUY' && x.assetClass !== 'TAX').length,
    sells: t.filter((x) => x.side === 'SELL' && x.assetClass !== 'TAX').length,
    commissions,
    taxes,
    fees: commissions + taxes,
    realized,
    volume,
    byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v })),
    bySymbol: [...symbols.entries()].map(([symbol, v]) => ({ symbol, ...v })).sort((a, b) => b.realized - a.realized),
  };
}
