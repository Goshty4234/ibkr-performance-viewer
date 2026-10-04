import { listRuns, loadRun, type BacktestRunRow } from './history';
import { noAdditions, portfolioDates } from './result-data';
import type { CurvePoint } from '@/lib/curve-gaps';

/** One backtest portfolio picked to be drawn over an account's chart. */
export interface BacktestPick {
  runId: string;
  /** Index of the portfolio inside the run. */
  index: number;
  label: string;
}

export interface BacktestChoice {
  runId: string;
  runLabel: string;
  createdAt: string;
  portfolios: { index: number; name: string }[];
}

/** Saved runs whose result can be opened (online or in the local library), newest first. */
export async function listBacktestChoices(): Promise<BacktestChoice[]> {
  const rows: BacktestRunRow[] = await listRuns(100);
  return rows
    .filter((r) => (r.kind ?? 'backtest') === 'backtest' && (!!r.result_path || !!r.local))
    .map((r) => ({
      runId: r.id,
      runLabel: r.label || r.created_at.slice(0, 10),
      createdAt: r.created_at,
      portfolios: r.summary
        .filter((s) => s.ok && s.index !== undefined)
        .map((s) => ({ index: s.index as number, name: s.name })),
    }))
    .filter((c) => c.portfolios.length > 0);
}

/**
 * Cumulative return curve (%) of one backtest portfolio, from its first valid value. It uses the
 * "no additions" series: the pure strategy return, comparable with an account's TWR (deposits
 * and withdrawals do not move it).
 */
export async function loadBacktestCurve(pick: BacktestPick): Promise<CurvePoint[]> {
  const { result } = await loadRun(pick.runId);
  if (!result) return [];
  const p = result.summary.portfolios.find((x) => x.ok && x.index === pick.index);
  if (!p || !p.ok) return [];
  const dates = portfolioDates(result.summary, p);
  const values = noAdditions(p);
  const out: CurvePoint[] = [];
  let base: number | null = null;
  for (let i = 0; i < dates.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || !(v > 0)) continue;
    if (base === null) base = v;
    out.push({ date: dates[i], value: (v / base - 1) * 100 });
  }
  return out;
}
