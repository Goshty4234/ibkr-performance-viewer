import { readFileSync } from 'fs';
import { parseFlexNavCsv } from '../src/lib/ibkr-flex-nav';
import { parseIbkrCsv } from '../src/lib/ibkr';
import {
  buildTwrrCurveFromNav,
  twrrCapitalFlowsByDate,
} from '../src/lib/performance';
import type { DbStatement } from '../src/lib/types';

const nav = parseFlexNavCsv(readFileSync('Variation_jour_par_jour.csv', 'utf8'), 'v');
const stmt = parseIbkrCsv(readFileSync('U16150944_20241202_20251202.csv', 'utf8'), 's');
const dbStmt = { ...stmt, id: '1', user_id: '1', portfolioAccountId: '1', imported_at: '' } as DbStatement;

const cfMap = twrrCapitalFlowsByDate([dbStmt]);
const curve = buildTwrrCurveFromNav(
  nav.points,
  nav.points[0].date,
  nav.points.at(-1)!.date,
  cfMap,
);

console.log('Full period TWRR%:', curve.at(-1)?.portfolio.toFixed(2));
console.log('Known CF days in map:', cfMap.size);

const subEnd = '2025-12-02';
const sub = buildTwrrCurveFromNav(nav.points, nav.points[0].date, subEnd, cfMap);
console.log('Jul-Dec 2025 TWRR% (IBKR stmt: 19.58%):', sub.at(-1)?.portfolio.toFixed(2));
