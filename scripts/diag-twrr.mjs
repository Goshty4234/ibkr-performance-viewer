import { readFileSync } from 'fs';
import { parseFlexCombinedCsv } from '../src/lib/ibkr-flex-combined.ts';
import { parseIbkrCsv } from '../src/lib/ibkr.ts';
import { cashFlowsToDateMap } from '../src/lib/ibkr-flex-cash.ts';
import {
  buildTwrrCurveFromNav,
  deriveCapitalFlowFromNav,
  capitalFlowForTwrrDay,
  twrrCapitalFlowsByDate,
  navPointsHaveComponents,
} from '../src/lib/performance.ts';
import { dbToStatement } from '../src/lib/db-mapper.ts';

const combined = parseFlexCombinedCsv(readFileSync('Cash_Transations_+_NAV_in_Base.csv', 'utf8'), 'c');
const stmt = parseIbkrCsv(readFileSync('U16150944_20241202_20251202.csv', 'utf8'), 'stmt');
const pts = combined.nav.points;
const flexKnown = cashFlowsToDateMap(combined.cashFlows);
const stmtFlows = twrrCapitalFlowsByDate([{ ...stmt, cashFlows: stmt.cashFlows }]);
const merged = twrrCapitalFlowsByDate([], flexKnown);

console.log('=== Cash flows ===');
console.log('Flex:', combined.cashFlows.length);
for (const cf of combined.cashFlows) console.log(' ', cf.date, cf.amount.toFixed(2), cf.description.slice(0, 60));
console.log('Statement CF:', stmt.cashFlows.length);
for (const cf of stmt.cashFlows.slice(0, 15)) console.log(' ', cf.date, cf.amount.toFixed(2), cf.description.slice(0, 60));
if (stmt.cashFlows.length > 15) console.log(' ...', stmt.cashFlows.length - 15, 'more');

const raw = (pts.at(-1).total / pts[0].total - 1) * 100;

function twrr(cfMap, useNew) {
  const has = navPointsHaveComponents(pts);
  let idx = 100;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const known = cfMap.get(cur.date);
    const cf = useNew
      ? capitalFlowForTwrrDay(prev, cur, known, has)
      : (known ?? deriveCapitalFlowFromNav(prev, cur));
    if (prev.total > 0) idx *= 1 + (cur.total - cf) / prev.total - 1;
  }
  return idx - 100;
}

function investedTwrr() {
  let idx = 100;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const pi = (prev.stock ?? 0) + (prev.options ?? 0);
    const ci = (cur.stock ?? 0) + (cur.options ?? 0);
    if (pi > 0) idx *= ci / pi;
  }
  return idx - 100;
}

console.log('\n=== Full period Jul25-Jul26 ===');
console.log('Statement TWRR (IBKR):', (stmt.twrr * 100).toFixed(2) + '%');
console.log('Raw NAV:', raw.toFixed(2) + '%');
console.log('Flex CF only (old):', twrr(flexKnown, false).toFixed(2) + '%');
console.log('NEW stmt flows + NAV derive:', twrr(stmtFlows, true).toFixed(2) + '%');
console.log('buildTwrrCurve:', buildTwrrCurveFromNav(pts, pts[0].date, pts.at(-1).date, stmtFlows).at(-1)?.portfolio.toFixed(2) + '%');

const estDays = [];
for (let i = 1; i < pts.length; i++) {
  const prev = pts[i - 1];
  const cur = pts[i];
  if (flexKnown.has(cur.date)) continue;
  const cf = deriveCapitalFlowFromNav(prev, cur);
  if (cf !== 0) {
    const rel = ((cur.total - prev.total) / prev.total * 100).toFixed(1);
    estDays.push({ date: cur.date, cf: cf.toFixed(0), rel: rel + '%' });
  }
}
console.log('\nEstimate fires on', estDays.length, 'days (no known CF):');
for (const d of estDays) console.log(' ', d);

// Big NAV days without known CF
console.log('\nBig NAV jumps (>8%) without known CF:');
for (let i = 1; i < pts.length; i++) {
  const prev = pts[i - 1];
  const cur = pts[i];
  const rel = (cur.total - prev.total) / prev.total;
  if (Math.abs(rel) < 0.08) continue;
  if (flexKnown.has(cur.date)) continue;
  const dInv = (cur.stock + (cur.options ?? 0)) - (prev.stock + (prev.options ?? 0));
  const est = deriveCapitalFlowFromNav(prev, cur);
  console.log(' ', cur.date, 'dNav%', (rel * 100).toFixed(1), 'dInv', dInv.toFixed(0), 'estCF', est.toFixed(0));
}

const watch = ['2025-10-14','2025-10-15','2025-10-16','2025-11-04','2025-11-05','2026-04-01','2026-04-03','2026-04-06','2026-02-23'];
const map = new Map(pts.map((p) => [p.date, p]));
console.log('\nNAV around key dates:');
for (const d of watch) {
  const p = map.get(d);
  if (!p) { console.log(d, '—'); continue; }
  console.log(d, 'NAV', p.total.toFixed(0), 'S', p.stock?.toFixed(0), 'C', p.cash?.toFixed(0));
}
