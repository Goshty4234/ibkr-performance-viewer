/**
 * Valide les métriques SPY vs Portfolio Visualizer (2025-07-08 → 2026-07-08).
 * npx tsx scripts/validate-spy-metrics.ts
 */
import { computeCurveMetricsForTest, DEFAULT_RISK_FREE_ANNUAL_PCT } from '../src/lib/risk-metrics';

const START = '2025-07-08';
const END = '2026-07-08';

const PV_REF = {
  sharpe: 1.366,
  sortino: 1.816,
  upi: 9.278,
  ulcerIndex: 2.174,
  cagr: 20.16,
  volatility: 12.5,
};

async function fetchSpyPrices(): Promise<Record<string, number>> {
  const period1 = Math.floor(new Date(START + 'T12:00:00Z').getTime() / 1000);
  const period2 = Math.floor(new Date(END + 'T12:00:00Z').getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp ?? [];
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
  const adj: (number | null)[] = result?.indicators?.adjclose?.[0]?.adjclose ?? [];

  const prices: Record<string, number> = {};
  const adjPrices: Record<string, number> = {};
  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    if (closes[i] != null) prices[d] = closes[i]!;
    if (adj[i] != null) adjPrices[d] = adj[i]!;
  }
  return { close: prices, adjclose: adjPrices };
}

function buildCumCurve(prices: Record<string, number>, start: string, end: string) {
  const dates = Object.keys(prices).filter((d) => d >= start && d <= end).sort();
  if (!dates.length) return { dates: [], cum: [] as number[] };
  const p0 = prices[dates[0]];
  const cum = dates.map((d) => ((prices[d] / p0) - 1) * 100);
  return { dates, cum };
}

function approx(a: number, b: number, tol: number) {
  return Math.abs(a - b) <= tol;
}

function report(label: string, m: ReturnType<typeof computeCurveMetricsForTest>) {
  console.log(`\n=== ${label} ===`);
  console.log(`CAGR:        ${m.cagr.toFixed(3)}%  (ref ~${PV_REF.cagr}%)`);
  console.log(`Total:       ${m.totalReturn.toFixed(3)}%`);
  console.log(`Volatility:  ${m.volatility.toFixed(3)}%  (ref ~${PV_REF.volatility}%)`);
  console.log(`Sharpe:      ${m.sharpe.toFixed(3)}  (ref ${PV_REF.sharpe})`);
  console.log(`Sortino:     ${m.sortino?.toFixed(3)}  (ref ${PV_REF.sortino})`);
  console.log(`Ulcer:       ${m.ulcerIndex.toFixed(3)}%  (ref ${PV_REF.ulcerIndex}%)`);
  console.log(`UPI:         ${m.upi?.toFixed(3)}  (ref ${PV_REF.upi})`);
  console.log(`Max DD:      ${m.maxDrawdown.toFixed(3)}%`);
  console.log(`Trading days: ${m.tradingDays}, calendar: ${m.calendarDays}`);
}

async function main() {
  const { close, adjclose } = await fetchSpyPrices() as { close: Record<string, number>; adjclose: Record<string, number> };

  const closeCurve = buildCumCurve(close, START, END);
  const adjCurve = buildCumCurve(adjclose, START, END);

  const mClose = computeCurveMetricsForTest(closeCurve.cum, closeCurve.dates, undefined, DEFAULT_RISK_FREE_ANNUAL_PCT);
  const mAdj = computeCurveMetricsForTest(adjCurve.cum, adjCurve.dates);

  report('SPY close (prix, comme notre benchmark)', mClose);
  report('SPY adjclose (total return avec dividendes)', mAdj);

  console.log('\n=== Écarts vs référence utilisateur (close) ===');
  const checks = [
    ['Sharpe', mClose.sharpe, PV_REF.sharpe, 0.08],
    ['Sortino', mClose.sortino ?? 0, PV_REF.sortino, 0.08],
    ['Ulcer', mClose.ulcerIndex, PV_REF.ulcerIndex, 0.15],
    ['UPI', mClose.upi ?? 0, PV_REF.upi, 0.15],
  ] as const;
  for (const [name, got, ref, tol] of checks) {
    const ok = approx(got, ref, tol);
    console.log(`${ok ? '✓' : '✗'} ${name}: ${got.toFixed(3)} vs ${ref} (Δ ${(got - ref).toFixed(3)})`);
  }

  // Variantes Sharpe / Sortino / Ulcer
  const rets = closeCurve.cum.slice(1).map((_, i) => {
    const prev = 1 + closeCurve.cum[i] / 100;
    const cur = 1 + closeCurve.cum[i + 1] / 100;
    return cur / prev - 1;
  });
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const popStd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n);
  const sampStd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  const cagr = mClose.cagr / 100;
  const volPop = popStd * Math.sqrt(252);
  const volSamp = sampStd * Math.sqrt(252);

  console.log('\n=== Variantes Sharpe ===');
  console.log(`arith/sampStd*sqrt252: ${(mean / sampStd) * Math.sqrt(252)}`);
  console.log(`arith/popStd*sqrt252:  ${(mean / popStd) * Math.sqrt(252)}`);
  console.log(`CAGR/volSamp:          ${cagr / volSamp}`);
  console.log(`CAGR/volPop:           ${cagr / volPop}`);
  console.log(`mean*252/volSamp:      ${(mean * 252) / volSamp}`);

  // Ulcer variants
  let peak = -Infinity;
  const depths: number[] = [];
  for (const c of closeCurve.cum) {
    const level = 100 + c;
    if (level > peak) peak = level;
    const dd = peak > 0 ? (1 - level / peak) * 100 : 0; // positive depth
    depths.push(dd);
  }
  const ulcerPos = Math.sqrt(depths.reduce((a, d) => a + d * d, 0) / depths.length);
  console.log('\n=== Ulcer (depth positive %) ===', ulcerPos.toFixed(3));

  // Sortino with RF
  const downVarN = rets.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / n;
  const downPop = Math.sqrt(downVarN) * Math.sqrt(252);
  console.log(`Sortino arith/popDown: ${(mean * 252) / downPop}`);

  for (const rfAnn of [0, 0.02, 0.03, 0.04, 0.045]) {
    const rfDaily = Math.pow(1 + rfAnn, 1 / 252) - 1;
    const excess = rets.map((r) => r - rfDaily);
    const exMean = excess.reduce((a, b) => a + b, 0) / n;
    const exStd = Math.sqrt(excess.reduce((s, r) => s + (r - exMean) ** 2, 0) / (n - 1));
    const sharpeEx = (exMean / exStd) * Math.sqrt(252);
    const downMar = Math.sqrt(
      rets.reduce((s, r) => s + Math.min(r - rfDaily, 0) ** 2, 0) / n,
    ) * Math.sqrt(252);
    const downEx = Math.sqrt(excess.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / n) * Math.sqrt(252);
    const cagrDec = mClose.cagr / 100;
    const sortinoCagr = (cagrDec - rfAnn) / downMar;
    const sortinoMar = (cagrDec - rfAnn) / downMar;
    const sortinoArith = (exMean * 252) / downMar;
    const sortinoArithSqrt = (exMean / Math.sqrt(rets.reduce((s, r) => s + Math.min(r - rfDaily, 0) ** 2, 0) / n)) * Math.sqrt(252);
    const sortinoCagrDown0 = (cagrDec - rfAnn) / downPop;
    const sharpeCagr = (cagrDec - rfAnn) / volSamp;
    console.log(
      `rf=${(rfAnn * 100).toFixed(1)}% | Sharpe_ex=${sharpeEx.toFixed(3)} Sharpe_cagr=${sharpeCagr.toFixed(3)} | Sortino_arith=${sortinoArith.toFixed(3)} Sortino_arith√=${sortinoArithSqrt.toFixed(3)} Sortino_cagr_mar=${sortinoMar.toFixed(3)} Sortino_cagr_down0=${sortinoCagrDown0.toFixed(3)}`,
    );
  }

  // Ulcer variants
  const ulcerFromPrices = (prices: number[]) => {
    let peak = -Infinity;
    const depths: number[] = [];
    for (const p of prices) {
      if (p > peak) peak = p;
      depths.push(peak > 0 ? (1 - p / peak) * 100 : 0);
    }
    return {
      all: Math.sqrt(depths.reduce((a, d) => a + d * d, 0) / depths.length),
      skipFirst: Math.sqrt(depths.slice(1).reduce((a, d) => a + d * d, 0) / (depths.length - 1)),
      nonZeroOnly: (() => {
        const nz = depths.filter((d) => d > 0);
        return nz.length ? Math.sqrt(nz.reduce((a, d) => a + d * d, 0) / nz.length) : 0;
      })(),
    };
  };
  const closePrices = closeCurve.dates.map((d) => close[d]);
  const u = ulcerFromPrices(closePrices);
  console.log('\n=== Ulcer variants (close prices) ===');
  console.log(`all days: ${u.all.toFixed(4)} | skip first: ${u.skipFirst.toFixed(4)} | non-zero only: ${u.nonZeroOnly.toFixed(4)}`);
  console.log(`UPI if ulcer=2.174: ${(mClose.cagr / 2.174).toFixed(3)}`);

  // Monthly aggregation (PV portfolio backtest convention)
  const monthlyReturns: number[] = [];
  let monthStart = closePrices[0];
  let curMonth = closeCurve.dates[0].slice(0, 7);
  for (let i = 1; i < closePrices.length; i++) {
    const m = closeCurve.dates[i].slice(0, 7);
    if (m !== curMonth) {
      monthlyReturns.push(closePrices[i - 1] / monthStart - 1);
      monthStart = closePrices[i - 1];
      curMonth = m;
    }
  }
  monthlyReturns.push(closePrices[closePrices.length - 1] / monthStart - 1);
  const nm = monthlyReturns.length;
  const mMean = monthlyReturns.reduce((a, b) => a + b, 0) / nm;
  const mStd = Math.sqrt(monthlyReturns.reduce((s, r) => s + (r - mMean) ** 2, 0) / (nm - 1));
  const mVol = mStd * Math.sqrt(12);
  const mCagr = mClose.cagr / 100;
  const mRf = 0.03;
  const mRfMonthly = Math.pow(1 + mRf, 1 / 12) - 1;
  const mDownMar = Math.sqrt(
    monthlyReturns.reduce((s, r) => s + Math.min(r - mRfMonthly, 0) ** 2, 0) / nm,
  ) * Math.sqrt(12);
  const mDown0 = Math.sqrt(
    monthlyReturns.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / nm,
  ) * Math.sqrt(12);
  const sharpeMonthlyEx =
    (monthlyReturns.map((r) => r - mRfMonthly).reduce((a, b) => a + b, 0) / nm / mStd) * Math.sqrt(12);
  console.log('\n=== Monthly returns (PV-style) ===');
  console.log(`months: ${nm} | vol: ${(mVol * 100).toFixed(3)}%`);
  console.log(
    `Sharpe ex-post: ${sharpeMonthlyEx.toFixed(3)} | cagr/vol: ${((mCagr - mRf) / mVol).toFixed(3)}`,
  );
  console.log(
    `Sortino arith/mar: ${((mMean * 12 - mRf) / mDownMar).toFixed(3)} | cagr/mar: ${((mCagr - mRf) / mDownMar).toFixed(3)} | cagr/down0: ${((mCagr - mRf) / mDown0).toFixed(3)}`,
  );

  // Martin Ulcer: R_i = 100 * (price/max - 1)  (negative drawdown %)
  let maxP = -Infinity;
  const martinR: number[] = [];
  for (const p of closePrices) {
    if (p > maxP) maxP = p;
    martinR.push(100 * (p / maxP - 1));
  }
  const ulcerMartin = Math.sqrt(martinR.reduce((s, r) => s + r * r, 0) / martinR.length);
  console.log(`Ulcer Martin (signed %): ${ulcerMartin.toFixed(4)} | UPI cagr: ${(mClose.cagr / ulcerMartin).toFixed(3)}`);
}

main().catch(console.error);
