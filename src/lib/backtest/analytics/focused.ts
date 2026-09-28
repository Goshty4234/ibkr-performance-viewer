/**
 * "Focused Performance Analysis" of 1_Multi_Backtest.py: metrics of each
 * portfolio's no-additions series restricted to [start, end].
 */
import { cov, max, mean, median, min, quantile, std, sum, variance } from './math';
import { dayNumber, pctChange, resampleLast, type PfSeries, weekday } from './series';

const RF = 0.02;
const YEAR_DAYS = 365.25;

export interface FocusedRow {
  index: number;
  name: string;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  volatility: number;
  sharpe: number;
  sortino: number;
  ulcerIndex: number;
  upi: number;
  beta: number;
  finalValueNoContrib: number;
  medianDrawdown: number;
  winRate: number;
  lossRate: number;
  medianWin: number;
  medianLoss: number;
  profitFactor: number;
  bestMonth: number;
  worstMonth: number;
  medianMonthly: number;
  calmar: number;
  sterling: number;
  recoveryFactor: number;
  tailRatio: number;
}

export type FocusedKey = Exclude<keyof FocusedRow, 'index' | 'name'>;

/** Column order and display format of the Streamlit table. */
export const FOCUSED_COLUMNS: { key: FocusedKey; label: string; fmt: 'pct' | 'pct1' | 'ratio' | 'money' | 'pf'; essential?: boolean }[] = [
  { key: 'totalReturn', label: 'Total Return', fmt: 'pct', essential: true },
  { key: 'cagr', label: 'CAGR', fmt: 'pct', essential: true },
  { key: 'maxDrawdown', label: 'Max Drawdown', fmt: 'pct', essential: true },
  { key: 'volatility', label: 'Volatility', fmt: 'pct', essential: true },
  { key: 'sharpe', label: 'Sharpe', fmt: 'ratio' },
  { key: 'sortino', label: 'Sortino', fmt: 'ratio' },
  { key: 'ulcerIndex', label: 'Ulcer Index', fmt: 'ratio' },
  { key: 'upi', label: 'UPI', fmt: 'ratio' },
  { key: 'beta', label: 'Beta', fmt: 'ratio' },
  { key: 'finalValueNoContrib', label: 'Final Value (No Contributions)', fmt: 'money' },
  { key: 'medianDrawdown', label: 'Median Drawdown', fmt: 'pct' },
  { key: 'winRate', label: 'Win Rate', fmt: 'pct1' },
  { key: 'lossRate', label: 'Loss Rate', fmt: 'pct1' },
  { key: 'medianWin', label: 'Median Win', fmt: 'pct' },
  { key: 'medianLoss', label: 'Median Loss', fmt: 'pct' },
  { key: 'profitFactor', label: 'Profit Factor', fmt: 'pf' },
  { key: 'bestMonth', label: 'Best Month', fmt: 'pct' },
  { key: 'worstMonth', label: 'Worst Month', fmt: 'pct' },
  { key: 'medianMonthly', label: 'Median Monthly', fmt: 'pct' },
  { key: 'calmar', label: 'Calmar Ratio', fmt: 'ratio' },
  { key: 'sterling', label: 'Sterling Ratio', fmt: 'ratio' },
  { key: 'recoveryFactor', label: 'Recovery Factor', fmt: 'ratio' },
  { key: 'tailRatio', label: 'Tail Ratio', fmt: 'ratio' },
];

/** Streamlit `calculate_cagr` on a (dates, values) series. */
export function cagrOf(days: ArrayLike<number>, values: ArrayLike<number>): number {
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) continue;
    if (i0 < 0) i0 = i;
    i1 = i;
  }
  if (i0 < 0 || i0 === i1) return NaN;
  const a = values[i0];
  const b = values[i1];
  if (a === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  const years = (days[i1] - days[i0]) / YEAR_DAYS;
  if (!(years > 0)) return NaN;
  return (b / a) ** (1 / years) - 1;
}

export function volatilityOf(returns: ArrayLike<number>): number {
  return returns.length > 1 ? std(returns, 1) * Math.sqrt(YEAR_DAYS) : NaN;
}

export function sharpeOf(returns: ArrayLike<number>, rf = RF): number {
  if (!returns.length) return NaN;
  const d = rf / YEAR_DAYS;
  const ex = Array.from(returns, (r) => r - d);
  const s = std(ex, 1);
  if (s === 0) return NaN;
  return (mean(ex) / s) * Math.sqrt(YEAR_DAYS);
}

export function sortinoOf(returns: ArrayLike<number>, rf = RF): number {
  if (!returns.length) return NaN;
  const d = rf / YEAR_DAYS;
  const down: number[] = [];
  for (let i = 0; i < returns.length; i++) if (returns[i] < d) down.push(returns[i]);
  if (!down.length) return NaN;
  const s = std(down, 1);
  if (s === 0) return NaN;
  return ((mean(returns) - d) / s) * Math.sqrt(YEAR_DAYS);
}

function slice(pf: PfSeries, startDay: number, endDayExclusive: number) {
  let a = 0;
  while (a < pf.days.length && pf.days[a] < startDay) a++;
  let b = a;
  while (b < pf.days.length && pf.days[b] < endDayExclusive) b++;
  return { a, b };
}

export function focusedRow(pf: PfSeries, bench: Map<number, number> | null, startDay: number, endDay: number): FocusedRow | null {
  const { a, b } = slice(pf, startDay, endDay + 1);
  if (b - a <= 1) return null;
  const values = pf.noAdd.subarray(a, b);
  const days = pf.days.subarray(a, b);
  const months = pf.months.subarray(a, b);
  const n = values.length;

  const orig = pctChange(values);
  for (let i = 0; i < n; i++) if (Number.isNaN(orig[i])) orig[i] = 0;

  let active: number[] = Array.from(orig);
  let zeros = 0;
  for (let i = 0; i < n; i++) if (Math.abs(orig[i]) < 1e-5) zeros++;
  if (zeros / n > 0.25) {
    active = [];
    for (let i = 0; i < n; i++) if (weekday(days[i]) < 5 || Math.abs(orig[i]) > 1e-5) active.push(orig[i]);
  }

  const cagr = cagrOf(days, values);
  const volatility = volatilityOf(orig);
  const sharpe = sharpeOf(orig);
  const sortino = sortinoOf(orig);

  const dd = new Float64Array(n);
  let cum = 1;
  let peak = -Infinity;
  for (let i = 0; i < n; i++) {
    cum *= 1 + orig[i];
    if (cum > peak) peak = cum;
    dd[i] = (cum - peak) / peak;
  }
  const maxDrawdown = min(dd);
  let sq = 0;
  for (let i = 0; i < n; i++) sq += dd[i] * dd[i];
  const ulcerIndex = Math.sqrt(sq / n) * 100;
  const upi = ulcerIndex > 0 ? cagr / (ulcerIndex / 100) : NaN;

  let beta = NaN;
  if (bench && n >= 2) {
    const br = new Float64Array(n);
    for (let i = 0; i < n; i++) br[i] = bench.get(days[i]) ?? 0;
    const vb = variance(br, 1);
    if (vb !== 0 && !Number.isNaN(vb)) beta = cov(orig, br, 1) / vb;
  }

  const totalReturn = values[n - 1] / values[0] - 1;
  const years = (days[n - 1] - days[0]) / YEAR_DAYS;
  const finalValueNoContrib = 10000 * (1 + cagr) ** years;
  const medianDrawdown = median(dd);

  const pos = active.filter((r) => r > 1e-5);
  const neg = active.filter((r) => r < -1e-5);
  const totalActive = pos.length + neg.length;
  const winRate = totalActive > 0 ? (pos.length / totalActive) * 100 : 0;
  const lossRate = totalActive > 0 ? (neg.length / totalActive) * 100 : 0;
  const medianWin = pos.length ? median(pos) * 100 : 0;
  const medianLoss = neg.length ? median(neg) * 100 : 0;
  const grossProfit = pos.length ? sum(pos) : 0;
  const grossLoss = neg.length ? Math.abs(sum(neg)) : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  const monthly = resampleLast(values, months);
  const mr = pctChange(monthly.values).map((v) => (Number.isNaN(v) ? 0 : v * 100));
  const bestMonth = mr.length ? max(mr) : 0;
  const worstMonth = mr.length ? min(mr) : 0;
  const medianMonthly = mr.length ? median(mr) : 0;

  const calmar = maxDrawdown !== 0 ? (cagr * 100) / Math.abs(maxDrawdown * 100) : NaN;
  const sterling = medianDrawdown !== 0 ? (cagr * 100) / Math.abs(medianDrawdown * 100) : NaN;
  const recoveryFactor = maxDrawdown !== 0 ? Math.abs(totalReturn) / Math.abs(maxDrawdown) : NaN;
  const q05 = quantile(active, 0.05);
  const tailRatio = q05 !== 0 ? quantile(active, 0.95) / Math.abs(q05) : NaN;

  return {
    index: pf.index,
    name: pf.name,
    totalReturn: totalReturn * 100,
    cagr: cagr * 100,
    maxDrawdown: maxDrawdown * 100,
    volatility: volatility * 100,
    sharpe,
    sortino,
    ulcerIndex,
    upi,
    beta,
    finalValueNoContrib,
    medianDrawdown: medianDrawdown * 100,
    winRate,
    lossRate,
    medianWin,
    medianLoss,
    profitFactor,
    bestMonth,
    worstMonth,
    medianMonthly,
    calmar,
    sterling,
    recoveryFactor,
    tailRatio,
  };
}

export function focusedAnalysis(
  pfs: PfSeries[],
  benchFor: (ticker: string) => Map<number, number> | null,
  start: string,
  end: string,
): FocusedRow[] {
  const s = dayNumber(start);
  const e = dayNumber(end);
  const out: FocusedRow[] = [];
  for (const pf of pfs) {
    const t = pf.config?.benchmark_ticker;
    const row = focusedRow(pf, t ? benchFor(t) : null, s, e);
    if (row) out.push(row);
  }
  return out;
}

export function formatFocused(v: number, fmt: (typeof FOCUSED_COLUMNS)[number]['fmt']): string {
  if (fmt === 'pf' && (v === Infinity || Number.isNaN(v))) return 'N/A';
  if (Number.isNaN(v)) return fmt === 'ratio' ? 'N/A' : 'nan%';
  switch (fmt) {
    case 'pct':
      return `${v.toFixed(2)}%`;
    case 'pct1':
      return `${v.toFixed(1)}%`;
    case 'money':
      return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    default:
      return v.toFixed(2);
  }
}
