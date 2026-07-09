/**
 * Valide que le rendement mensuel est cohérent avec le cumul (pas de saut ignoré entre mois).
 * npx tsx scripts/validate-period-performance.ts
 */
import type { ChartSeriesDef, MultiSeriesChartPoint } from '../src/lib/chart-series';
import { buildMonthlyPeriodTables } from '../src/lib/period-performance';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Reproduit le bug : gros gain en janv., petit gain intra-fév. mais baisse fin janv. → début fév.
const data: MultiSeriesChartPoint[] = [
  { date: '2025-01-02', portfolio: 0 },
  { date: '2025-01-31', portfolio: 4.73 },
  { date: '2025-02-03', portfolio: 2.1 }, // gap week-end / début mois : -2.5 % vs fin janv.
  { date: '2025-02-28', portfolio: 2.37 }, // +0.26 % depuis début fév.
];

const series: ChartSeriesDef[] = [
  { id: 'portfolio', label: 'Test', color: '#fff', kind: 'account' },
];

const { months, tables } = buildMonthlyPeriodTables(data, series);
const m = tables[0].periods;

const jan = m.get('2025-01')!;
const feb = m.get('2025-02')!;

console.log('Jan:', jan.returnPct.toFixed(2), '% période, cumul', jan.cumulativePct.toFixed(2), '%');
console.log('Feb:', feb.returnPct.toFixed(2), '% période, cumul', feb.cumulativePct.toFixed(2), '%');

assert(Math.abs(jan.returnPct - 4.73) < 0.05, `jan return: ${jan.returnPct}`);
assert(Math.abs(jan.cumulativePct - 4.73) < 0.05, `jan cumul: ${jan.cumulativePct}`);

// Février doit être négatif (fin janv. → fin fév.), pas +0.16 %
assert(feb.returnPct < 0, `feb return should be negative, got ${feb.returnPct}`);
assert(feb.cumulativePct < jan.cumulativePct, 'cumul fév. < cumul janv.');

// Cohérence : cumul_fév = (1 + cumul_jan/100) * (1 + ret_fév/100) - 1
const impliedCum = (1 + jan.cumulativePct / 100) * (1 + feb.returnPct / 100) - 1;
assert(
  Math.abs(impliedCum * 100 - feb.cumulativePct) < 0.05,
  `chain: ${impliedCum * 100} vs ${feb.cumulativePct}`,
);

console.log('\n✓ Monthly return anchored to end of previous month — cumul cohérent.');
