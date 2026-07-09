import type { BenchmarkSymbol } from './types';
import { BENCHMARK_LABELS } from './types';

export type ChartSeriesKind = 'primary' | 'account' | 'benchmark';

export interface ChartSeriesDef {
  id: string;
  label: string;
  color: string;
  kind: ChartSeriesKind;
  strokeDasharray?: string;
}

export type MultiSeriesChartPoint = {
  date: string;
  isGap?: boolean;
  [seriesId: string]: number | string | boolean | null | undefined;
};

export const SERIES_PALETTE = [
  '#4d8dff',
  '#ffb020',
  '#4ade80',
  '#c084fc',
  '#f472b6',
  '#22d3ee',
  '#fb923c',
  '#a3e635',
];

export function primarySeriesId(): string {
  return 'primary';
}

export function accountSeriesId(accountId: string): string {
  return `account:${accountId}`;
}

export function benchmarkSeriesId(symbol: BenchmarkSymbol): string {
  return `benchmark:${symbol}`;
}

export function assignSeriesColors(
  series: Omit<ChartSeriesDef, 'color'>[],
): ChartSeriesDef[] {
  return series.map((s, i) => ({
    ...s,
    color: SERIES_PALETTE[i % SERIES_PALETTE.length],
    strokeDasharray: s.kind === 'benchmark' ? '6 4' : undefined,
  }));
}

export function buildSeriesDefs(
  primaryLabel: string,
  extraAccountIds: string[],
  accountLabels: Map<string, string>,
  benchmarks: BenchmarkSymbol[],
): ChartSeriesDef[] {
  const raw: Omit<ChartSeriesDef, 'color'>[] = [
    { id: primarySeriesId(), label: primaryLabel, kind: 'primary' },
    ...extraAccountIds.map((id) => ({
      id: accountSeriesId(id),
      label: accountLabels.get(id) ?? 'Compte',
      kind: 'account' as const,
    })),
    ...benchmarks.map((sym) => ({
      id: benchmarkSeriesId(sym),
      label: BENCHMARK_LABELS[sym],
      kind: 'benchmark' as const,
    })),
  ];
  return assignSeriesColors(raw);
}

/** Aligne des prix benchmark sur les dates portefeuille (0 % au début de la plage). */
export function alignBenchmarkToDates(
  dates: string[],
  prices: Record<string, number>,
): number[] {
  const priceDates = Object.keys(prices).sort();
  let bi = 0;
  let startP: number | null = null;
  return dates.map((date) => {
    while (bi < priceDates.length && priceDates[bi] <= date) bi++;
    const bd = priceDates[bi - 1] ?? priceDates[0] ?? date;
    const price = prices[bd] ?? prices[date];
    if (price && startP === null) startP = price;
    return price && startP ? (price / startP - 1) * 100 : 0;
  });
}

/** Aligne une courbe cumulative % sur les dates de référence (forward-fill). */
export function alignPortfolioToDates(
  dates: string[],
  curve: { date: string; portfolio: number }[],
): number[] {
  if (!curve.length) return dates.map(() => 0);
  const byDate = new Map(curve.map((p) => [p.date, p.portfolio]));
  const curveDates = [...byDate.keys()].sort();
  let ci = 0;
  let last = 0;
  let started = false;
  return dates.map((date) => {
    while (ci < curveDates.length && curveDates[ci] <= date) {
      const v = byDate.get(curveDates[ci]);
      if (v !== undefined) {
        last = v;
        started = true;
      }
      ci++;
    }
    if (byDate.has(date)) {
      last = byDate.get(date)!;
      started = true;
    }
    return started ? last : 0;
  });
}

export function buildMultiSeriesChart(
  dates: string[],
  aligned: { id: string; values: (number | null)[]; gaps?: boolean[] }[],
): MultiSeriesChartPoint[] {
  return dates.map((date, i) => {
    const row: MultiSeriesChartPoint = { date };
    for (const s of aligned) {
      const v = s.values[i];
      row[s.id] = v ?? undefined;
      row[`${s.id}__gap`] = s.gaps?.[i] ?? false;
    }
    return row;
  });
}

export function seriesGapKey(seriesId: string): string {
  return `${seriesId}__gap`;
}

export function alignCurvePointsToDates(
  dates: string[],
  curve: { date: string; value: number; isGap?: boolean }[],
): { values: (number | null)[]; gaps: boolean[] } {
  if (!curve.length) {
    return { values: dates.map(() => null), gaps: dates.map(() => false) };
  }
  const byDate = new Map(curve.map((p) => [p.date, p]));
  const sorted = [...curve].sort((a, b) => a.date.localeCompare(b.date));
  let ci = 0;
  let last = 0;
  let lastGap = false;
  let started = false;
  const values: (number | null)[] = [];
  const gaps: boolean[] = [];
  for (const date of dates) {
    while (ci < sorted.length && sorted[ci].date <= date) {
      last = sorted[ci].value;
      lastGap = !!sorted[ci].isGap;
      started = true;
      ci++;
    }
    if (byDate.has(date)) {
      const p = byDate.get(date)!;
      last = p.value;
      lastGap = !!p.isGap;
      started = true;
    }
    values.push(started ? last : null);
    gaps.push(started && lastGap);
  }
  return { values, gaps };
}

export function toggleSeriesVisibility(
  hidden: Set<string>,
  seriesId: string,
): Set<string> {
  const next = new Set(hidden);
  if (next.has(seriesId)) next.delete(seriesId);
  else next.add(seriesId);
  return next;
}

export function visibleSeries(
  series: ChartSeriesDef[],
  hidden: Set<string>,
): ChartSeriesDef[] {
  return series.filter((s) => !hidden.has(s.id));
}

export function firstVisibleBenchmarkId(
  series: ChartSeriesDef[],
  hidden: Set<string>,
): string | null {
  const bench = series.find((s) => s.kind === 'benchmark' && !hidden.has(s.id));
  return bench?.id ?? null;
}
