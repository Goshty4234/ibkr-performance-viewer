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
  elapsed_s: number;
  busy_s: number;
  series: McSeries[];
  pairs: McPair[];
  draws: McDraw[];
  errors: { draw: number; portfolio?: string; error: string | null }[];
  benchmark: { ticker: string; curve: (number | null)[] } | null;
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
