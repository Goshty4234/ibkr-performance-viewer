import type { EngineClient } from './client';

export interface McSynthetic {
  market_mu: number;
  rf: number;
  market_vol: number;
  beta_sd: number;
  idio_vol: number;
  idio_vol_dispersion: number;
  alpha_sd: number;
  alpha_halflife_days: number;
  tail_df: number;
  market_tail_df: number;
  crisis_per_year: number;
  crisis_days: number;
  crisis_vol_mult: number;
  crisis_drift: number;
  extreme_per_year: number;
  extreme_up_share: number;
}

export interface McOptions {
  n_sims: number;
  n_assets: number;
  years: number;
  seed: number;
  generator: 'synthetic' | 'bootstrap';
  synthetic: McSynthetic;
  bootstrap: { block_days: number; demean: boolean };
  cost_bps: number;
  risk_free: number;
}

export const MC_DEFAULTS: McOptions = {
  n_sims: 300,
  n_assets: 20,
  years: 10,
  seed: 12345,
  generator: 'synthetic',
  synthetic: {
    market_mu: 0.07, rf: 0.02, market_vol: 0.16, beta_sd: 0.3, idio_vol: 0.28, idio_vol_dispersion: 0.4,
    alpha_sd: 0, alpha_halflife_days: 250, tail_df: 4, market_tail_df: 6, crisis_per_year: 0.3, crisis_days: 90,
    crisis_vol_mult: 2.2, crisis_drift: -0.35, extreme_per_year: 0.02, extreme_up_share: 0.55,
  },
  bootstrap: { block_days: 21, demean: true },
  cost_bps: 0,
  risk_free: 0.02,
};

export type McMetric = 'total_return' | 'cagr' | 'max_dd' | 'vol' | 'sharpe' | 'sortino' | 'calmar' | 'turnover' | 'avg_holdings' | 'cash_pct';

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

export interface McProbabilities {
  positive_cagr: number;
  lost_money: number;
  drawdown_over_50: number;
  beats_baseline_cagr: number | null;
  beats_baseline_sharpe: number | null;
  smaller_drawdown_than_baseline: number | null;
}

export interface McSeries {
  id: string;
  name: string;
  kind: 'portfolio' | 'baseline';
  warnings: string[];
  metrics: Record<McMetric, (number | null)[]>;
  summary: Record<McMetric, McStat>;
  fan: Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', (number | null)[]>;
  probabilities?: McProbabilities;
}

export interface McResult {
  format: number;
  options: McOptions & { workers: number; chunks: number };
  calendar: { eval_days: number; start: string; end: string; fan_dates: string[]; tdays_per_year: number };
  series: McSeries[];
  pairwise_cagr: { names: string[]; matrix: (number | null)[][] };
  elapsed_s: number;
  universe_note: string;
}

export interface McJob {
  id: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  message: string;
  error: string | null;
}

export function mcSubmit(client: EngineClient, portfolios: unknown[], options: Partial<McOptions> & { bootstrap?: Record<string, unknown> }, label?: string): Promise<McJob> {
  return client.text('/montecarlo', { method: 'POST', body: JSON.stringify({ portfolios, options, label }) }).then((t) => JSON.parse(t) as McJob);
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

export function mcRealUniverse(client: EngineClient): Promise<{ tickers: string[]; min_rows: number }> {
  return client.text('/montecarlo/real-universe').then((t) => JSON.parse(t));
}

/** Histogram of several samples on shared bins (counts as % of each sample). */
export function histogram(samples: (number | null)[][], bins = 40, clip = 0.01): { centers: number[]; shares: number[][] } {
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
