/**
 * Metrics of the Backtester "Focused Performance Analysis" that an account can compute from its own
 * cumulative return curve (TWR): the same definitions, so the two pages read the same way.
 * Everything comes from the daily curve already on the page: nothing is guessed or estimated.
 */
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { computeCurveMetricsForTest } from '@/lib/risk-metrics';

export interface ExtendedMetrics {
  medianDrawdown: number;
  winRate: number;
  lossRate: number;
  medianWin: number;
  medianLoss: number;
  profitFactor: number | null;
  bestDay: number;
  worstDay: number;
  bestMonth: number | null;
  worstMonth: number | null;
  medianMonthly: number | null;
  positiveMonthsPct: number | null;
  calmar: number | null;
  sterling: number | null;
  recoveryFactor: number | null;
  tailRatio: number | null;
  longestDrawdownDays: number;
  currentDrawdown: number;
}

export interface ExtendedMetricsRow {
  seriesId: string;
  label: string;
  metrics: ExtendedMetrics;
}

const EPS = 1e-5;

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(v: number[], q: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function ratio(a: number, b: number): number | null {
  return b !== 0 && Number.isFinite(a / b) ? a / b : null;
}

export function computeExtendedMetrics(cumPct: number[], dates: string[]): ExtendedMetrics | null {
  if (cumPct.length < 3 || dates.length !== cumPct.length) return null;

  // Daily returns in %. Days with no change at all (flat copy past the end of a curve) are not days.
  const daily: number[] = [];
  for (let i = 1; i < cumPct.length; i++) {
    const prev = 1 + cumPct[i - 1] / 100;
    const cur = 1 + cumPct[i] / 100;
    if (prev > 0) daily.push((cur / prev - 1) * 100);
  }
  const wins = daily.filter((r) => r > EPS);
  const losses = daily.filter((r) => r < -EPS);
  const active = wins.length + losses.length;

  // Drawdown depth (%) below the running peak, and how long the account stayed under water.
  let peak = -Infinity;
  const depth: number[] = [];
  let run = 0;
  let longest = 0;
  for (let i = 0; i < cumPct.length; i++) {
    const level = 100 + cumPct[i];
    if (level >= peak) {
      peak = level;
      run = 0;
    } else {
      run++;
      longest = Math.max(longest, run);
    }
    depth.push(peak > 0 ? (level / peak - 1) * 100 : 0);
  }
  // Longest stretch in calendar days, not in rows.
  let longestCal = 0;
  {
    let start: string | null = null;
    let pk = -Infinity;
    for (let i = 0; i < cumPct.length; i++) {
      const level = 100 + cumPct[i];
      if (level >= pk) {
        pk = level;
        start = dates[i];
      } else if (start) {
        longestCal = Math.max(
          longestCal,
          Math.round((new Date(dates[i]).getTime() - new Date(start).getTime()) / 864e5),
        );
      }
    }
  }

  // Monthly returns: last level of each month against the last level of the month before.
  const monthEnd = new Map<string, number>();
  for (let i = 0; i < cumPct.length; i++) monthEnd.set(dates[i].slice(0, 7), 100 + cumPct[i]);
  const keys = [...monthEnd.keys()].sort();
  const monthly: number[] = [];
  let prevLevel = 100 + cumPct[0];
  for (const k of keys) {
    const level = monthEnd.get(k)!;
    if (prevLevel > 0) monthly.push((level / prevLevel - 1) * 100);
    prevLevel = level;
  }

  const base = computeCurveMetricsForTest(cumPct, dates);
  const mdd = Math.abs(base.maxDrawdown);
  const medDd = median(depth);
  const p95 = quantile(daily, 0.95);
  const p5 = quantile(daily, 0.05);
  const gains = wins.reduce((a, b) => a + b, 0);
  const lossSum = Math.abs(losses.reduce((a, b) => a + b, 0));

  return {
    medianDrawdown: medDd,
    winRate: active ? (wins.length / active) * 100 : 0,
    lossRate: active ? (losses.length / active) * 100 : 0,
    medianWin: median(wins),
    medianLoss: median(losses),
    profitFactor: lossSum > 0 ? gains / lossSum : null,
    bestDay: daily.length ? Math.max(...daily) : 0,
    worstDay: daily.length ? Math.min(...daily) : 0,
    bestMonth: monthly.length ? Math.max(...monthly) : null,
    worstMonth: monthly.length ? Math.min(...monthly) : null,
    medianMonthly: monthly.length ? median(monthly) : null,
    positiveMonthsPct: monthly.length ? (monthly.filter((m) => m > 0).length / monthly.length) * 100 : null,
    calmar: ratio(base.cagr, mdd),
    sterling: ratio(base.cagr, Math.abs(medDd)),
    recoveryFactor: ratio(base.totalReturn, mdd),
    tailRatio: ratio(p95, Math.abs(p5)),
    longestDrawdownDays: longestCal,
    currentDrawdown: depth[depth.length - 1] ?? 0,
  };
}

export function computeExtendedRows(
  data: MultiSeriesChartPoint[],
  series: ChartSeriesDef[],
  hidden: Set<string>,
): ExtendedMetricsRow[] {
  if (data.length < 3) return [];
  const dates = data.map((p) => p.date);
  const out: ExtendedMetricsRow[] = [];
  for (const s of series) {
    if (hidden.has(s.id)) continue;
    const cum = data.map((p) => (typeof p[s.id] === 'number' ? (p[s.id] as number) : 0));
    const metrics = computeExtendedMetrics(cum, dates);
    if (metrics) out.push({ seriesId: s.id, label: s.label, metrics });
  }
  return out;
}
