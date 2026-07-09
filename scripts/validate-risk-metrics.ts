/**
 * Validation des métriques de risque sur séries synthétiques.
 * Exécuter : npx tsx scripts/validate-risk-metrics.ts
 */
import { computeCurveMetricsForTest } from '../src/lib/risk-metrics';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function approx(a: number, b: number, tol = 0.05) {
  return Math.abs(a - b) <= tol;
}

function eachDay(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Série quasi-constante : volatilité ≈ 0.05 % × √252
{
  const n = 253;
  const dates = eachDay('2024-01-01', n);
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) {
    const noise = (i % 7 === 0 ? 0.0002 : 0) - (i % 11 === 0 ? 0.0001 : 0);
    cum.push(((1 + cum[i - 1] / 100) * (1.0005 + noise) - 1) * 100);
  }
  const m = computeCurveMetricsForTest(cum, dates);
  assert(m.volatility > 0.05 && m.volatility < 2, `vol low-noise: ${m.volatility}`);
  assert(m.sharpe > 1, `sharpe positive: ${m.sharpe}`);
  assert(m.beta == null, 'beta without benchmark should be null');
  console.log('✓ low-noise daily return');
}

// Beta = 1 quand portefeuille = benchmark
{
  const n = 100;
  const dates = eachDay('2024-06-01', n);
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) {
    const r = Math.sin(i / 7) * 0.01;
    cum.push(((1 + cum[i - 1] / 100) * (1 + r) - 1) * 100);
  }
  const benchRets: number[] = [];
  for (let i = 1; i < cum.length; i++) {
    benchRets.push((1 + cum[i] / 100) / (1 + cum[i - 1] / 100) - 1);
  }
  const m = computeCurveMetricsForTest(cum, dates, benchRets);
  assert(approx(m.beta ?? 0, 1, 0.02), `beta identical: ${m.beta}`);
  console.log('✓ beta = 1 for identical series');
}

// Sortino : dénominateur N (pas seulement jours négatifs)
{
  const n = 50;
  const dates = eachDay('2025-01-01', n);
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) {
    const r = i % 10 === 0 ? -0.02 : 0.003;
    cum.push(((1 + cum[i - 1] / 100) * (1 + r) - 1) * 100);
  }
  const m = computeCurveMetricsForTest(cum, dates);
  assert(m.sortino != null && m.sortino > 0, `sortino: ${m.sortino}`);
  assert(m.sortino! < m.sharpe * 2, 'sortino should be finite and reasonable');
  console.log('✓ sortino with mixed returns');
}

// CAGR ~ total return sur 1 an
{
  const dates = eachDay('2024-01-01', 366);
  const cum = dates.map((_, i) => (Math.pow(1.12, i / 365.25) - 1) * 100);
  const m = computeCurveMetricsForTest(cum, dates);
  assert(approx(m.cagr, 12, 0.5), `cagr 1y ~12%: ${m.cagr}`);
  assert(approx(m.totalReturn, 12, 0.5), `total 1y ~12%: ${m.totalReturn}`);
  console.log('✓ CAGR ≈ total return over ~1 year');
}

// Ulcer > 0 avec drawdown
{
  const dates = eachDay('2024-03-01', 30);
  const cum = [0, 5, 10, 3, 8, 2, 6];
  const d = dates.slice(0, cum.length);
  const m = computeCurveMetricsForTest(cum, d);
  assert(m.ulcerIndex > 0, `ulcer: ${m.ulcerIndex}`);
  assert(m.maxDrawdown < 0, `max dd: ${m.maxDrawdown}`);
  console.log('✓ ulcer index with drawdowns');
}

console.log('\nAll risk-metrics validation checks passed.');
