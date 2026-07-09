/**
 * Valide que le rapport Performance IBKR produit une courbe non-linéaire.
 * Usage: npx tsx scripts/validate-performance-chart.ts [fichier.csv]
 */
import { readFileSync } from 'fs';
import {
  parseIbkrPerformanceReportCsv,
  isIbkrPerformanceReportCsv,
} from '../src/lib/ibkr-performance-report';
import {
  buildCurveFromIbkrTwrDaily,
  resolveIbkrTwrDailyPoints,
} from '../src/lib/performance';
import type { DbStatement } from '../src/lib/types';

const file = process.argv[2] ?? 'Nicolas_Cool_U16150944_December_02_2024_July_08_2026.csv';
const text = readFileSync(file, 'utf8');

if (!isIbkrPerformanceReportCsv(text)) {
  console.error('FAIL: not a performance report CSV');
  process.exit(1);
}

const parsed = parseIbkrPerformanceReportCsv(text, file);
console.log('Parsed:', {
  accountId: parsed.accountId,
  period: `${parsed.periodStart} -> ${parsed.periodEnd}`,
  twrDays: parsed.twrDaily?.length ?? 0,
  twrrPct: (parsed.twrr * 100).toFixed(2),
});

const stmt: DbStatement = {
  ...parsed,
  id: 'test',
  user_id: 'test',
  portfolioAccountId: 'test',
  imported_at: new Date().toISOString(),
};

const daily = resolveIbkrTwrDailyPoints(stmt.twrDaily, [stmt]);
const curve = buildCurveFromIbkrTwrDaily(
  daily,
  parsed.periodStart,
  parsed.periodEnd,
);

console.log('Curve points:', curve.length);
console.log('End return %:', curve.at(-1)?.portfolio.toFixed(2));

const values = curve.map((p) => p.portfolio);
const min = Math.min(...values);
const max = Math.max(...values);
const range = max - min;
const diffs = values.slice(1).map((v, i) => Math.abs(v - values[i]));
const maxDailyMove = Math.max(...diffs);
const uniqueRounded = new Set(values.map((v) => Math.round(v * 100) / 100)).size;

// Linear fit R² — straight line => R² ≈ 1
const n = values.length;
const xs = values.map((_, i) => i);
const meanX = xs.reduce((a, b) => a + b, 0) / n;
const meanY = values.reduce((a, b) => a + b, 0) / n;
let ssTot = 0;
let ssRes = 0;
const slope =
  xs.reduce((s, x, i) => s + (x - meanX) * (values[i] - meanY), 0) /
  xs.reduce((s, x) => s + (x - meanX) ** 2, 0);
const intercept = meanY - slope * meanX;
for (let i = 0; i < n; i++) {
  const pred = intercept + slope * xs[i];
  ssRes += (values[i] - pred) ** 2;
  ssTot += (values[i] - meanY) ** 2;
}
const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

console.log('Oscillation:', {
  min: min.toFixed(2),
  max: max.toFixed(2),
  range: range.toFixed(2),
  maxDailyMove: maxDailyMove.toFixed(2),
  uniqueValues: uniqueRounded,
  linearR2: r2.toFixed(4),
});

const jul25 = '2025-07-01';
const end = parsed.periodEnd;
const sub = buildCurveFromIbkrTwrDaily(daily, jul25, end);
console.log(`Jul 2025 -> end: ${sub.at(-1)?.portfolio.toFixed(2)}% (${sub.length} pts)`);

const ok =
  curve.length >= 100 &&
  uniqueRounded >= 50 &&
  maxDailyMove > 0.5 &&
  r2 < 0.999;

if (!ok) {
  console.error('\nFAIL: curve looks too linear or too few points');
  process.exit(1);
}

console.log('\nOK: portfolio curve oscillates (not a straight line)');
