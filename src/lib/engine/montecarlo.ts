import type { EngineClient } from './client';
import type { PortfolioConfig, RunOptions } from './types';

/** Monte Carlo on real stocks: each draw takes `n_pick` tickers of the universe at random and runs
 * every portfolio on exactly those stocks (a normal run), then the next draw takes others. */
export type McUniverseSource = 'sp500' | 'us' | 'portfolios' | 'list';

export interface McOptions {
  n_draws: number;
  n_pick: number;
  seed: number;
  universe: { source: McUniverseSource; tickers: string[] };
  start_date: string | null;
  end_date: string | null;
  baseline: boolean;
  points: number;
}

export const MC_DEFAULTS: McOptions = {
  n_draws: 50,
  n_pick: 30,
  seed: 12345,
  universe: { source: 'sp500', tickers: [] },
  start_date: '2005-01-01',
  end_date: null,
  baseline: true,
  points: 400,
};

/** Statistics per draw, in Construire's units (returns and drawdowns in %). */
export type McStatKey =
  | 'CAGR' | 'Total Return' | 'MaxDrawdown' | 'Volatility' | 'Sharpe' | 'Sortino' | 'UlcerIndex' | 'UPI' | 'Beta' | 'MWRR'
  | 'Final Value (with)' | 'Final Value (no_additions)' | 'holdings' | 'cash';

export interface McStat {
  n: number;
  mean: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
  p5: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
}

export interface McSeries {
  name: string;
  kind: 'portfolio' | 'baseline';
  stats: Record<McStatKey, (number | null)[]>;
  summary: Record<McStatKey, McStat>;
  fan: Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', (number | null)[]>;
  /** Value of the portfolio without contributions, 1 = start of the draw, on `dates`. */
  curves: (number | null)[][];
}

export interface McPair {
  a: number;
  b: number;
  n: number;
  cagr_win: number | null;
  sharpe_win: number | null;
  drawdown_win: number | null;
  /** CAGR of a minus CAGR of b, in points per year, over the draws. */
  cagr_diff: McStat;
}

export interface McDraw {
  draw: number;
  tickers: string[];
  start: string | null;
  end: string | null;
  error: string | null;
}

export interface McResult {
  format: number;
  options: McOptions & { workers: number };
  universe: { label: string; count: number; missing: string[]; stale: string[]; short: string[]; n_missing: number; n_stale: number; n_short: number };
  window: { start: string; end: string };
  dates: string[];
  warnings: string[];
  /** One verdict per portfolio sent, in the same order. */
  portfolios: McVerdict[];
  elapsed_s: number;
  busy_s: number;
  series: McSeries[];
  pairs: McPair[];
  draws: McDraw[];
  errors: { draw: number; portfolio?: string; error: string | null }[];
  benchmark: { ticker: string; curve: (number | null)[] } | null;
}

/** What the engine says about one portfolio: a Monte Carlo only makes sense for momentum or equal-weight baskets. */
export type McVerdictKind = 'momentum' | 'equal_weight' | 'static' | 'single' | 'targeted' | 'fusion';
export interface McVerdict {
  name: string;
  status: 'included' | 'excluded';
  kind: McVerdictKind | null;
  /** Why a portfolio is left out (French, ready to display). */
  reason: string | null;
  /** Things to know about an included portfolio (top-N that filters nothing, equal weight conversion…). */
  notes: string[];
}

export interface McJob {
  id: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  error: string | null;
}

export function mcSubmit(client: EngineClient, portfolios: PortfolioConfig[], options: Partial<RunOptions>, mc: McOptions, label?: string): Promise<McJob> {
  return client.text('/montecarlo', { method: 'POST', body: JSON.stringify({ portfolios, options, mc, label }) }).then((t) => JSON.parse(t) as McJob);
}

/** Asks the engine which of these portfolios a Monte Carlo would keep (nothing is run). */
export function mcCheck(client: EngineClient, portfolios: PortfolioConfig[], mc: Pick<McOptions, 'n_pick'>): Promise<McVerdict[]> {
  return client
    .text('/montecarlo/check', { method: 'POST', body: JSON.stringify({ portfolios, options: {}, mc }) })
    .then((t) => (JSON.parse(t) as { portfolios: McVerdict[] }).portfolios);
}

export function mcJob(client: EngineClient, id: string): Promise<McJob> {
  return client.text(`/montecarlo/${id}`).then((t) => JSON.parse(t) as McJob);
}

export function mcCancel(client: EngineClient, id: string): Promise<McJob> {
  return client.text(`/montecarlo/${id}`, { method: 'DELETE' }).then((t) => JSON.parse(t) as McJob);
}

export function mcResult(client: EngineClient, id: string): Promise<McResult> {
  return client.text(`/montecarlo/${id}/result`).then((t) => JSON.parse(t) as McResult);
}

/** Tickers typed or pasted in any format (spaces, commas, new lines, semicolons). */
export function parseTickers(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean))];
}

/** Histogram of several samples on shared bins (counts as % of each sample). */
export function histogram(samples: (number | null)[][], bins = 30, clip = 0.01): { centers: number[]; shares: number[][] } {
  const all = samples.flat().filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!all.length) return { centers: [], shares: samples.map(() => []) };
  const lo = all[Math.floor(all.length * clip)];
  const hi = all[Math.min(all.length - 1, Math.ceil(all.length * (1 - clip)))];
  const span = hi - lo || 1;
  const w = span / bins;
  const centers = Array.from({ length: bins }, (_, i) => lo + (i + 0.5) * w);
  const shares = samples.map((s) => {
    const counts = new Array<number>(bins).fill(0);
    let n = 0;
    for (const v of s) {
      if (v === null || !Number.isFinite(v)) continue;
      n += 1;
      counts[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)))] += 1;
    }
    return counts.map((c) => (n ? (100 * c) / n : 0));
  });
  return { centers, shares };
}

/** Pair (a, b) of the result, a and b being series indexes. */
export function pairOf(result: McResult, a: number, b: number): McPair | undefined {
  return result.pairs.find((p) => p.a === a && p.b === b);
}

// ------------------------------------------------------------------------------------------------
// A window of the result: every curve re-based to 0 % on the first day of the window
// ------------------------------------------------------------------------------------------------

export type McQuantiles = Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', number | null>;
const Q_KEYS = ['p5', 'p25', 'p50', 'p75', 'p95'] as const;
const Q_AT = [0.05, 0.25, 0.5, 0.75, 0.95];

export interface McWindowSeries {
  name: string;
  kind: 'portfolio' | 'baseline';
  /** Index of the series in the result. */
  index: number;
  /** Draws that cover the window (start within its first 3 %). */
  covered: number;
  /** Re-based curves, 1 = first day of the window, null before a draw's start. One entry per draw, null if not covered. */
  curves: (number[] | null)[];
  fan: Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', (number | null)[]>;
  /** Over the window, in %: total return, annualised return, deepest drawdown (grid points). */
  ret: McQuantiles;
  cagr: McQuantiles;
  drawdown: McQuantiles;
  /** Per draw, same units: kept to compare portfolios draw by draw. */
  retByDraw: (number | null)[];
}

export interface McWindow {
  dates: string[];
  series: McWindowSeries[];
  /** Share of draws (both covered) where the portfolio's return beats the reference basket's; null without reference. */
  beatBaseline: (number | null)[];
  nDraws: number;
  /** The result grid is ~400 points: drawdowns and annualisation are measured on it, not day by day. */
  gridPoints: number;
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function quantiles(values: number[]): McQuantiles {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out = {} as McQuantiles;
  Q_KEYS.forEach((k, i) => { out[k] = quantile(sorted, Q_AT[i]); });
  return out;
}

const DAY = 86_400_000;
const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY;

/** Index range of `dates` inside [start, end] (inclusive), or null when fewer than 2 points. */
export function windowIndexes(dates: string[], start: string, end: string): [number, number] | null {
  let i0 = dates.findIndex((d) => d >= start);
  if (i0 < 0) return null;
  let i1 = -1;
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    if (dates[i] <= end) { i1 = i; break; }
  }
  if (i1 - i0 < 1) return null;
  i0 = Math.max(0, i0);
  return [i0, i1];
}

export function windowOf(result: McResult, start: string, end: string): McWindow | null {
  const idx = windowIndexes(result.dates, start, end);
  if (!idx) return null;
  const [i0, i1] = idx;
  const n = i1 - i0 + 1;
  const dates = result.dates.slice(i0, i1 + 1);
  const days = dates.map(dayNumber);
  const slack = Math.max(2, Math.floor(n * 0.03));
  const nDraws = result.draws.length;

  const series: McWindowSeries[] = result.series.map((s, index) => {
    const curves: (number[] | null)[] = [];
    const retByDraw: (number | null)[] = [];
    const rets: number[] = [];
    const cagrs: number[] = [];
    const dds: number[] = [];
    let covered = 0;
    for (let d = 0; d < nDraws; d += 1) {
      const raw = s.curves[d]?.slice(i0, i1 + 1);
      let f = -1;
      if (raw) {
        for (let k = 0; k < n; k += 1) {
          if (raw[k] !== null && raw[k]! > 0) { f = k; break; }
        }
      }
      if (!raw || f < 0 || f > slack) { curves.push(null); retByDraw.push(null); continue; }
      const base = raw[f]!;
      const c = raw.map((v, k) => (k < f || v === null || v <= 0 ? null : v / base)) as number[];
      let last = n - 1;
      while (last > f && c[last] === null) last -= 1;
      if (last <= f) { curves.push(null); retByDraw.push(null); continue; }
      covered += 1;
      curves.push(c);
      const total = c[last] - 1;
      rets.push(total * 100);
      retByDraw.push(total * 100);
      const years = (days[last] - days[f]) / 365.25;
      if (years >= 0.25 && 1 + total > 0) cagrs.push((Math.pow(1 + total, 1 / years) - 1) * 100);
      let peak = 1;
      let worst = 0;
      for (let k = f; k <= last; k += 1) {
        const v = c[k];
        if (v === null) continue;
        if (v > peak) peak = v;
        const dd = v / peak - 1;
        if (dd < worst) worst = dd;
      }
      dds.push(worst * 100);
    }
    const fan = { p5: [], p25: [], p50: [], p75: [], p95: [] } as unknown as McWindowSeries['fan'];
    for (let k = 0; k < n; k += 1) {
      const col: number[] = [];
      for (const c of curves) {
        const v = c?.[k];
        if (v !== null && v !== undefined) col.push(v);
      }
      col.sort((a, b) => a - b);
      Q_KEYS.forEach((key, qi) => { fan[key].push(quantile(col, Q_AT[qi])); });
    }
    return {
      name: s.name, kind: s.kind, index, covered, curves, fan, retByDraw,
      ret: quantiles(rets), cagr: quantiles(cagrs), drawdown: quantiles(dds),
    };
  });

  const base = series.find((s) => s.kind === 'baseline');
  const beatBaseline = series.map((s) => {
    if (!base || s === base) return null;
    let wins = 0;
    let both = 0;
    for (let d = 0; d < nDraws; d += 1) {
      const a = s.retByDraw[d];
      const b = base.retByDraw[d];
      if (a === null || b === null || a === undefined || b === undefined) continue;
      both += 1;
      if (a > b) wins += 1;
    }
    return both ? wins / both : null;
  });
  return { dates, series, beatBaseline, nDraws, gridPoints: n };
}

// ---- date helpers shared by the period bar -----------------------------------------------------

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round(dayNumber(b) - dayNumber(a));
}
