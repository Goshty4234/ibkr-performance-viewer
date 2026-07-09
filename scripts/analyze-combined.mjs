import { readFileSync } from 'fs';
import { isFlexCombinedCsv } from '../src/lib/flex-csv.ts';
import { parseFlexCombinedCsv } from '../src/lib/ibkr-flex-combined.ts';
import { buildTwrrCurveFromNav } from '../src/lib/performance.ts';

const text = readFileSync('Cash_Transations_+_NAV_in_Base.csv', 'utf8');
console.log('Combined:', isFlexCombinedCsv(text));

const { nav, cashFlows } = parseFlexCombinedCsv(text, 'combined.csv');
console.log('NAV:', nav.points.length, nav.points[0].date, '->', nav.points[nav.points.length - 1].date);
console.log('Cash flows TWRR:', cashFlows.length);
for (const cf of cashFlows.slice(0, 10)) {
  console.log(' ', cf.date, cf.amount.toFixed(2), cf.description.slice(0, 50));
}

import { cashFlowsToDateMap } from '../src/lib/ibkr-flex-cash.ts';
const curve = buildTwrrCurveFromNav(
  nav.points,
  nav.points[0].date,
  nav.points[nav.points.length - 1].date,
  cashFlowsToDateMap(cashFlows),
);
console.log('TWRR%:', curve.at(-1)?.portfolio.toFixed(2));
