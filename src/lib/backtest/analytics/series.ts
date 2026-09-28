import type { PortfolioConfig, PortfolioSummaryOk, ResultSummary, SeriesRef } from '@/lib/engine/types';

const DAY_MS = 86_400_000;

export function dayNumber(d: string): number {
  return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS;
}

export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** pandas weekday: Monday = 0 (1970-01-01 was a Thursday). */
export function weekday(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

/** A portfolio's daily series decoded to typed arrays (null -> NaN). */
export interface PfSeries {
  index: number;
  name: string;
  config: PortfolioConfig;
  dates: string[];
  days: Int32Array;
  /** year * 12 + month0, per row */
  months: Int32Array;
  withAdd: Float64Array;
  noAdd: Float64Array;
}

function toFloat(values: (number | null)[]): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = v === null || v === undefined ? NaN : v;
  }
  return out;
}

function refDates(summary: ResultSummary, ref: { offset?: number; dates?: string[] }, length: number): string[] {
  if (ref.dates) return ref.dates;
  const start = ref.offset ?? 0;
  return summary.dates.slice(start, start + length);
}

export function decodePortfolio(summary: ResultSummary, p: PortfolioSummaryOk): PfSeries {
  const dates = refDates(summary, p.series, p.series.with_additions.length);
  const n = dates.length;
  const days = new Int32Array(n);
  const months = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const d = dates[i];
    days[i] = dayNumber(d);
    months[i] = +d.slice(0, 4) * 12 + (+d.slice(5, 7) - 1);
  }
  const withAdd = toFloat(p.series.with_additions);
  const noAdd = p.series.no_additions ? toFloat(p.series.no_additions) : withAdd;
  return { index: p.index, name: p.name, config: p.config, dates, days, months, withAdd, noAdd };
}

export function decodePortfolios(summary: ResultSummary): PfSeries[] {
  return summary.portfolios
    .filter((p): p is PortfolioSummaryOk => p.ok && !!p.series?.with_additions)
    .map((p) => decodePortfolio(summary, p));
}

/** Raw benchmark Price_change on its own trading days (engine `benchmark_returns`). */
export function decodeBenchReturns(summary: ResultSummary, ticker: string): Map<number, number> | null {
  const all = summary.benchmark_returns as Record<string, SeriesRef> | undefined;
  const ref = all?.[ticker];
  if (!ref) return null;
  const dates = refDates(summary, ref, ref.values.length);
  const out = new Map<number, number>();
  for (let i = 0; i < dates.length; i++) {
    const v = ref.values[i];
    if (v !== null && v !== undefined && !Number.isNaN(v)) out.set(dayNumber(dates[i]), v);
  }
  return out;
}

/** pandas `pct_change()` (pad fill): first value and values after a missing prefix are NaN. */
export function pctChange(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const cur = Number.isNaN(v) ? prev : v;
    out[i] = Number.isNaN(prev) || Number.isNaN(cur) ? NaN : cur / prev - 1;
    prev = cur;
  }
  return out;
}

export interface Resampled {
  /** year*12+month0 (months) or year (years) for every bucket from first to last */
  keys: number[];
  values: Float64Array;
}

/** pandas `resample('ME' | 'YE').last()` on a daily series: last non-NaN value per bucket. */
export function resampleLast(values: ArrayLike<number>, bucket: ArrayLike<number>): Resampled {
  const n = values.length;
  if (!n) return { keys: [], values: new Float64Array(0) };
  const first = bucket[0];
  const last = bucket[n - 1];
  const size = last - first + 1;
  const out = new Float64Array(size).fill(NaN);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isNaN(v)) out[bucket[i] - first] = v;
  }
  return { keys: Array.from({ length: size }, (_, k) => first + k), values: out };
}

export function yearsOf(months: Int32Array): Int32Array {
  const out = new Int32Array(months.length);
  for (let i = 0; i < months.length; i++) out[i] = Math.floor(months[i] / 12);
  return out;
}

export function monthLabel(key: number): string {
  const y = Math.floor(key / 12);
  const m = (key % 12) + 1;
  return `${y}-${m < 10 ? '0' : ''}${m}`;
}
