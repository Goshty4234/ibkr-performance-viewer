import { cashFlowsToDateMap } from '@/lib/ibkr-flex-cash';
import { dbToNavSeries } from '@/lib/nav-mapper';
import { dbToStatement } from '@/lib/db-mapper';
import { dbToTwrSeries } from '@/lib/twr-mapper';
import {
  buildCurveFromIbkrTwrDaily,
  buildPerformanceCurve,
  buildTwrrCurveFromNav,
  mergeStatements,
  navPointsHaveComponents,
  resolveIbkrTwrDailyPoints,
  shouldPreferStatementCurve,
  twrrCapitalFlowsByDate,
} from '@/lib/performance';
import { analyzeTimeline } from '@/lib/timeline';
import { expandCurveGaps, type CurvePoint } from '@/lib/curve-gaps';
import type { DbNavSeries, DbStatement, DbTwrSeries } from '@/lib/types';

export interface AccountCurveBundle {
  statements: DbStatement[];
  navSeries: DbNavSeries | null;
  twrSeries: DbTwrSeries | null;
}

export async function fetchAccountCurveBundle(
  portfolioAccountId: string,
): Promise<AccountCurveBundle> {
  const [stmtRes, navRes, twrRes] = await Promise.all([
    fetch(`/api/statements?portfolioAccountId=${encodeURIComponent(portfolioAccountId)}`),
    fetch(`/api/nav-series?portfolioAccountId=${encodeURIComponent(portfolioAccountId)}`),
    fetch(`/api/twr-series?portfolioAccountId=${encodeURIComponent(portfolioAccountId)}`),
  ]);

  const statements = stmtRes.ok
    ? (await stmtRes.json()).map(dbToStatement)
    : [];
  const navJson = navRes.ok ? await navRes.json() : null;
  const twrJson = twrRes.ok ? await twrRes.json() : null;

  return {
    statements,
    navSeries: navJson ? dbToNavSeries(navJson) : null,
    twrSeries: twrJson ? dbToTwrSeries(twrJson) : null,
  };
}

/** Construit la courbe cumulative % (0 au début de plage) pour un compte. */
export function buildAccountPortfolioCurve(
  bundle: AccountCurveBundle,
  rangeStart: string,
  rangeEnd: string,
): CurvePoint[] {
  const { statements, navSeries, twrSeries } = bundle;
  const merged = mergeStatements(statements);
  const hasNav = (navSeries?.points.length ?? 0) >= 2;
  const hasStmts = statements.length > 0;
  const ibkrTwr = resolveIbkrTwrDailyPoints(twrSeries?.points, statements);
  if (!hasNav && !hasStmts && ibkrTwr.length < 2) return [];

  let raw: { date: string; portfolio: number }[];

  if (ibkrTwr.length >= 2) {
    raw = buildCurveFromIbkrTwrDaily(ibkrTwr, rangeStart, rangeEnd);
  } else if (shouldPreferStatementCurve(statements, rangeStart, rangeEnd)) {
    const health = analyzeTimeline(merged, rangeStart, rangeEnd);
    const stmtStart = health.rangeCoverage?.availableStart ?? rangeStart;
    const stmtEnd = health.rangeCoverage?.availableEnd ?? rangeEnd;
    raw = buildPerformanceCurve(statements, stmtStart, stmtEnd);
  } else if (hasNav && navSeries) {
    const hasComponents = navPointsHaveComponents(navSeries.points);
    const navFlows = !hasComponents && navSeries.cashFlows?.length
      ? cashFlowsToDateMap(navSeries.cashFlows)
      : null;
    const cfMap = twrrCapitalFlowsByDate(statements, navFlows);
    raw = buildTwrrCurveFromNav(navSeries.points, rangeStart, rangeEnd, cfMap);
  } else {
    const health = analyzeTimeline(merged, rangeStart, rangeEnd);
    if (!health.rangeCoverage?.hasAnyData) return [];
    const stmtStart = health.rangeCoverage.availableStart ?? rangeStart;
    const stmtEnd = health.rangeCoverage.availableEnd ?? rangeEnd;
    raw = buildPerformanceCurve(statements, stmtStart, stmtEnd);
  }

  return expandCurveGaps(raw);
}

/** Première date avec données réelles (hors trous import). */
export function accountCurveDataStart(curve: CurvePoint[]): string | null {
  const p = curve.find((c) => !c.isGap);
  return p?.date ?? curve[0]?.date ?? null;
}
