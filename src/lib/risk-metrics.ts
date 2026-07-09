/**
 * Métriques de risque — conventions alignées Portfolio Visualizer / Sortino & Price / Martin (1987).
 *
 * Taux sans risque par défaut : 3 % annualisé (proxy bon du Trésor 1 an ; ajustable).
 *
 * - Volatilité  : écart-type (N-1) des rendements quotidiens × √252
 * - Sharpe      : (CAGR − rf) / volatilité  (aligné outil PV sur fenêtres ~1 an)
 * - Sortino     : (R̄×252 − rf) / σ_d  où R̄ = moyenne arithmétique des r quotidiens,
 *                 σ_d = √(Σ min(r − rf_daily, 0)² / N) × √252  (MAR = rf, Sortino-Price)
 * - Ulcer index : √(mean(depth²)) avec depth = % positif sous le pic
 * - UPI         : CAGR / Ulcer index (Martin Performance Index, rf=0 au numérateur)
 * - Beta        : cov(r_p, r_b) / var(r_b)
 */

import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { computeDrawdownSeries, getMaxDrawdown } from '@/lib/performance';

const TRADING_DAYS = 252;
const MIN_OBS_FOR_RATIO = 2;

/** Taux sans risque annualisé en % (Portfolio Visualizer utilise le Trésor ~3 %). */
export const DEFAULT_RISK_FREE_ANNUAL_PCT = 3.0;

export interface CurveRiskMetrics {
  cagr: number;
  totalReturn: number;
  maxDrawdown: number;
  volatility: number;
  sharpe: number;
  sortino: number | null;
  ulcerIndex: number;
  upi: number | null;
  beta: number | null;
  tradingDays: number;
  calendarDays: number;
}

export interface RiskMetricsRow {
  seriesId: string;
  label: string;
  metrics: CurveRiskMetrics;
}

function calendarDaysBetween(start: string, end: string): number {
  return Math.max(1, (new Date(end).getTime() - new Date(start).getTime()) / 864e5);
}

function rfDailyFromAnnualPct(annualPct: number): number {
  return Math.pow(1 + annualPct / 100, 1 / TRADING_DAYS) - 1;
}

function dailyReturnsFromCumulative(cumPct: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < cumPct.length; i++) {
    const prev = 1 + cumPct[i - 1] / 100;
    const cur = 1 + cumPct[i] / 100;
    if (prev <= 0) continue;
    rets.push(cur / prev - 1);
  }
  return rets;
}

function mean(rets: number[]): number {
  if (!rets.length) return 0;
  return rets.reduce((a, b) => a + b, 0) / rets.length;
}

function sampleStd(rets: number[]): number {
  if (rets.length < 2) return 0;
  const m = mean(rets);
  const variance = rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < MIN_OBS_FOR_RATIO) return 0;
  const sliceA = a.slice(0, n);
  const sliceB = b.slice(0, n);
  const meanA = mean(sliceA);
  const meanB = mean(sliceB);
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (sliceA[i] - meanA) * (sliceB[i] - meanB);
  return cov / (n - 1);
}

function variance(rets: number[]): number {
  if (rets.length < MIN_OBS_FOR_RATIO) return 0;
  const m = mean(rets);
  return rets.reduce((s, r) => s + (r - m) ** 2, 0) / (rets.length - 1);
}

/** Ulcer index Martin : RMS des drawdowns positifs (% sous le pic). */
function ulcerIndexFromCumulative(cumPct: number[]): number {
  let peak = -Infinity;
  const depths: number[] = [];
  for (const pct of cumPct) {
    const level = 100 + pct;
    if (level > peak) peak = level;
    const depth = peak > 0 ? (1 - level / peak) * 100 : 0;
    depths.push(Math.max(0, depth));
  }
  if (!depths.length) return 0;
  return Math.sqrt(depths.reduce((a, d) => a + d * d, 0) / depths.length);
}

function cagrFromCumulative(cumPct: number[], dates: string[]): number {
  if (cumPct.length < 2 || dates.length < 2) return 0;
  const years = calendarDaysBetween(dates[0], dates[dates.length - 1]) / 365.25;
  if (years <= 0) return 0;
  const initial = 1 + cumPct[0] / 100;
  const final = 1 + cumPct[cumPct.length - 1] / 100;
  if (initial <= 0 || final <= 0) return 0;
  return (Math.pow(final / initial, 1 / years) - 1) * 100;
}

function totalReturnFromCumulative(cumPct: number[]): number {
  if (!cumPct.length) return 0;
  const initial = 1 + cumPct[0] / 100;
  const final = 1 + cumPct[cumPct.length - 1] / 100;
  if (initial <= 0) return 0;
  return (final / initial - 1) * 100;
}

function downsideDeviationAnnual(rets: number[], marDaily: number): number {
  if (!rets.length) return 0;
  const sumSq = rets.reduce((s, r) => s + Math.min(r - marDaily, 0) ** 2, 0);
  return Math.sqrt(sumSq / rets.length) * Math.sqrt(TRADING_DAYS);
}

function computeCurveMetrics(
  cumPct: number[],
  dates: string[],
  benchmarkDailyReturns?: number[],
  riskFreeAnnualPct: number = DEFAULT_RISK_FREE_ANNUAL_PCT,
): CurveRiskMetrics {
  const rets = dailyReturnsFromCumulative(cumPct);
  const calendarDays = calendarDaysBetween(dates[0], dates[dates.length - 1]);
  const cagr = cagrFromCumulative(cumPct, dates);
  const totalReturn = totalReturnFromCumulative(cumPct);
  const dd = computeDrawdownSeries(
    cumPct.map((portfolio, i) => ({ date: String(i), portfolio })),
  );
  const maxDrawdown = getMaxDrawdown(dd);

  const volDec = sampleStd(rets) * Math.sqrt(TRADING_DAYS);
  const volatility = volDec * 100;

  const rfDec = riskFreeAnnualPct / 100;
  const cagrDec = cagr / 100;
  const annArithmeticDec = mean(rets) * TRADING_DAYS;

  const sharpe = volDec > 0 ? (cagrDec - rfDec) / volDec : 0;

  const marDaily = rfDailyFromAnnualPct(riskFreeAnnualPct);
  const downDec = downsideDeviationAnnual(rets, marDaily);
  let sortino: number | null = null;
  if (rets.length >= MIN_OBS_FOR_RATIO) {
    if (downDec > 0) {
      sortino = (annArithmeticDec - rfDec) / downDec;
    } else if (annArithmeticDec > rfDec) {
      sortino = null;
    } else {
      sortino = 0;
    }
  }

  const ulcer = ulcerIndexFromCumulative(cumPct);
  const upi = ulcer > 0 ? cagr / ulcer : null;

  let beta: number | null = null;
  if (benchmarkDailyReturns && benchmarkDailyReturns.length >= MIN_OBS_FOR_RATIO && rets.length >= MIN_OBS_FOR_RATIO) {
    const varBench = variance(benchmarkDailyReturns);
    beta = varBench > 0 ? covariance(rets, benchmarkDailyReturns) / varBench : null;
  }

  return {
    cagr,
    totalReturn,
    maxDrawdown,
    volatility,
    sharpe,
    sortino,
    ulcerIndex: ulcer,
    upi,
    beta,
    tradingDays: rets.length,
    calendarDays,
  };
}

export function computeRiskMetricsRowsForSeries(
  data: MultiSeriesChartPoint[],
  series: ChartSeriesDef[],
  hidden: Set<string>,
  betaReferenceId: string | null,
  riskFreeAnnualPct: number = DEFAULT_RISK_FREE_ANNUAL_PCT,
): RiskMetricsRow[] {
  if (data.length < 2) return [];

  const dates = data.map((p) => p.date);
  const visible = series.filter((s) => !hidden.has(s.id));

  let refRets: number[] | undefined;
  if (betaReferenceId && !hidden.has(betaReferenceId)) {
    const refCum = data.map((p) => (p[betaReferenceId] as number) ?? 0);
    refRets = dailyReturnsFromCumulative(refCum);
  }

  return visible.map((s) => {
    const cum = data.map((p) => (p[s.id] as number) ?? 0);
    const metrics = computeCurveMetrics(cum, dates, s.kind === 'benchmark' ? undefined : refRets, riskFreeAnnualPct);
    if (s.kind === 'benchmark') metrics.beta = 1;
    return { seriesId: s.id, label: s.label, metrics };
  });
}

export function computeCurveMetricsForTest(
  cumPct: number[],
  dates: string[],
  benchmarkDailyReturns?: number[],
  riskFreeAnnualPct?: number,
): CurveRiskMetrics {
  return computeCurveMetrics(cumPct, dates, benchmarkDailyReturns, riskFreeAnnualPct);
}
