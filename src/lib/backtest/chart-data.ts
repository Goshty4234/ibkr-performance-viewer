import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { SERIES_PALETTE } from '@/lib/chart-series';
import type { ResultSummary } from '@/lib/engine/types';
import { benchmarkSeries, noAdditions, okSummaries, portfolioDates } from './result-data';

export const MAX_CHART_POINTS = 1800;

export interface ResultSeries {
  id: string;
  label: string;
  color: string;
  kind: 'primary' | 'account' | 'benchmark';
  dates: string[];
  values: (number | null)[];
}

const BENCHMARK_COLORS = ['#8b9cb3', '#d4d4d8', '#6b7a90', '#b0a58a'];

export function portfolioColor(index: number): string {
  if (index < SERIES_PALETTE.length) return SERIES_PALETTE[index];
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue} 70% 62%)`;
}

export function portfolioSeriesId(index: number): string {
  return `pf:${index}`;
}

export function benchmarkId(ticker: string): string {
  return `bm:${ticker}`;
}

/** Portfolio and benchmark series on a common date axis (portfolio dates). */
export function buildResultSeries(
  summary: ResultSummary,
  mode: 'no_additions' | 'with_additions',
  benchmarks: string[],
): { dates: string[]; series: ResultSeries[] } {
  const pfs = okSummaries(summary);
  const series: ResultSeries[] = pfs.map((p, i) => ({
    id: portfolioSeriesId(p.index),
    label: p.name,
    color: portfolioColor(p.index),
    kind: i === 0 ? 'primary' : 'account',
    dates: portfolioDates(summary, p),
    values: mode === 'no_additions' ? noAdditions(p) : p.series.with_additions,
  }));
  let dates: string[];
  if (summary.dates.length && pfs.every((p) => p.series.dates === undefined)) {
    const first = Math.min(...pfs.map((p) => p.series.offset ?? 0));
    const last = Math.max(...pfs.map((p) => (p.series.offset ?? 0) + p.series.with_additions.length));
    dates = summary.dates.slice(first, last);
  } else {
    const dateSet = new Set<string>();
    for (const s of series) for (const d of s.dates) dateSet.add(d);
    dates = [...dateSet].sort();
  }
  benchmarks.forEach((t, k) => {
    const b = benchmarkSeries(summary, t);
    if (!b) return;
    series.push({
      id: benchmarkId(t),
      label: t,
      color: BENCHMARK_COLORS[k % BENCHMARK_COLORS.length],
      kind: 'benchmark',
      dates: b.dates,
      values: b.values,
    });
  });
  return { dates, series };
}

function alignValues(dates: string[], s: ResultSeries): (number | null)[] {
  const out: (number | null)[] = new Array(dates.length).fill(null);
  let j = 0;
  let last: number | null = null;
  for (let i = 0; i < dates.length; i++) {
    while (j < s.dates.length && s.dates[j] <= dates[i]) {
      const v = s.values[j];
      if (v !== null && Number.isFinite(v)) last = v;
      j++;
    }
    out[i] = j > 0 ? last : null;
  }
  return out;
}

/** Cumulative % from each series' first valid value. */
function toCumulativePct(values: (number | null)[]): (number | null)[] {
  let base: number | null = null;
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    if (base === null && v > 0) base = v;
    return base ? (v / base - 1) * 100 : null;
  });
}

/** Indices kept for display: uniform sampling + peak/trough of each series' max drawdown + last point. */
function sampleIndices(n: number, aligned: (number | null)[][], maxPoints: number): number[] {
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  const keep = new Set<number>();
  const step = n / maxPoints;
  for (let k = 0; k < maxPoints; k++) keep.add(Math.floor(k * step));
  keep.add(n - 1);
  for (const vals of aligned) {
    let peak = -Infinity;
    let peakIdx = 0;
    let worst = 0;
    let worstIdx = -1;
    let worstPeakIdx = 0;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (v === null) continue;
      if (v > peak) { peak = v; peakIdx = i; }
      const dd = peak > 0 ? v / peak - 1 : 0;
      if (dd < worst) { worst = dd; worstIdx = i; worstPeakIdx = peakIdx; }
    }
    if (worstIdx >= 0) { keep.add(worstIdx); keep.add(worstPeakIdx); }
  }
  return [...keep].sort((a, b) => a - b);
}

export interface PreparedCharts {
  defs: ChartSeriesDef[];
  /** Cumulative % per series, downsampled for charts. */
  pctData: MultiSeriesChartPoint[];
  /** Raw values ($) per series, downsampled. */
  valueData: MultiSeriesChartPoint[];
  /** Cumulative % at each month end (exact, for period tables). */
  monthEndData: MultiSeriesChartPoint[];
}

export function prepareCharts(dates: string[], series: ResultSeries[], maxPoints = MAX_CHART_POINTS): PreparedCharts {
  const defs: ChartSeriesDef[] = series.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    kind: s.kind,
    strokeDasharray: s.kind === 'benchmark' ? '6 4' : undefined,
  }));
  const aligned = series.map((s) => alignValues(dates, s));
  const pct = aligned.map(toCumulativePct);
  const idx = sampleIndices(dates.length, aligned, maxPoints);

  const pctData: MultiSeriesChartPoint[] = [];
  const valueData: MultiSeriesChartPoint[] = [];
  for (const i of idx) {
    const pr: MultiSeriesChartPoint = { date: dates[i] };
    const vr: MultiSeriesChartPoint = { date: dates[i] };
    series.forEach((s, k) => {
      pr[s.id] = pct[k][i] ?? undefined;
      vr[s.id] = aligned[k][i] ?? undefined;
    });
    pctData.push(pr);
    valueData.push(vr);
  }

  const monthEndData: MultiSeriesChartPoint[] = [];
  for (let i = 0; i < dates.length; i++) {
    const isFirst = i === 0;
    const isMonthEnd = i === dates.length - 1 || dates[i + 1].slice(0, 7) !== dates[i].slice(0, 7);
    if (!isFirst && !isMonthEnd) continue;
    const row: MultiSeriesChartPoint = { date: dates[i] };
    series.forEach((s, k) => { row[s.id] = pct[k][i] ?? undefined; });
    monthEndData.push(row);
  }

  return { defs, pctData, valueData, monthEndData };
}

export function sliceByDate<T extends { date: string }>(rows: T[], start: string | null, end: string | null): T[] {
  if (!start && !end) return rows;
  return rows.filter((r) => (!start || r.date >= start) && (!end || r.date <= end));
}

/** Rebases cumulative % rows so the first row of the range is 0 %. */
export function rebasePct(rows: MultiSeriesChartPoint[], ids: string[]): MultiSeriesChartPoint[] {
  if (!rows.length) return rows;
  const base: Record<string, number | null> = {};
  for (const id of ids) {
    const first = rows.find((r) => typeof r[id] === 'number');
    base[id] = first ? (first[id] as number) : null;
  }
  return rows.map((r) => {
    const out: MultiSeriesChartPoint = { date: r.date };
    for (const id of ids) {
      const v = r[id];
      const b = base[id];
      out[id] = typeof v === 'number' && b !== null ? ((1 + v / 100) / (1 + b / 100) - 1) * 100 : undefined;
    }
    return out;
  });
}

export const STAT_COLUMNS: { key: string; label: string; title?: string }[] = [
  { key: 'CAGR', label: 'CAGR' },
  { key: 'Total Return', label: 'Rendement total' },
  { key: 'MaxDrawdown', label: 'Max DD' },
  { key: 'Volatility', label: 'Volatilité' },
  { key: 'Sharpe', label: 'Sharpe' },
  { key: 'Sortino', label: 'Sortino' },
  { key: 'UlcerIndex', label: 'Ulcer' },
  { key: 'UPI', label: 'UPI' },
  { key: 'Beta', label: 'Bêta' },
  { key: 'MWRR', label: 'MWRR', title: 'Rendement pondéré par l’argent (tient compte des ajouts)' },
  { key: 'Total Return (Contributed)', label: 'Rend. / apports' },
];

export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
