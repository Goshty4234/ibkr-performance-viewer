import type { BenchmarkSymbol, DailyEvent, DailyNavPoint, DbStatement, PerformancePoint, PerformanceSummary } from './types';
import { groupStatementsByContinuity, mergeStatements } from './statements';
import { getDataBounds } from './timeline';

function eachDay(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  const endD = new Date(`${end}T12:00:00Z`);
  while (d <= endD) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function sumByDate<T extends { date: string }>(
  items: T[],
  amount: (item: T) => number,
  filter?: (item: T) => boolean,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    if (filter && !filter(item)) continue;
    map.set(item.date, (map.get(item.date) ?? 0) + amount(item));
  }
  return map;
}

function calibrateToTwrr(
  points: { date: string; index: number }[],
  startIdx: number,
  twrr: number,
): void {
  if (points.length < 2 || !twrr) return;
  const target = startIdx * (1 + twrr);
  const actual = points[points.length - 1].index;
  if (actual <= 0 || actual <= startIdx * 0.01) return;
  if (Math.abs(actual - target) < 0.001 * Math.abs(target)) return;

  const scale = Math.log(target / startIdx) / Math.log(actual / startIdx);
  if (!Number.isFinite(scale) || scale <= 0) return;

  let cur = startIdx;
  points[0].index = startIdx;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].index;
    const r = prev > 0 ? points[i].index / prev - 1 : 0;
    cur *= 1 + r * scale;
    points[i].index = cur;
  }
}

function solveReturnScale(rawReturns: number[], targetReturn: number): number {
  if (!rawReturns.length) return 0;
  const compound = (scale: number) =>
    rawReturns.reduce((acc, r) => acc * (1 + r * scale), 1) - 1;

  if (Math.abs(targetReturn) < 1e-9) return 0;

  let lo = 0;
  let hi = 1;
  while (compound(hi) < targetReturn && hi < 64) hi *= 2;
  if (compound(hi) < targetReturn) return hi;

  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (compound(mid) < targetReturn) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function weekKey(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function aggregateWeeklyPnl(pnlByDate: Map<string, number>): { date: string; pnl: number }[] {
  const weeks = new Map<string, number>();
  for (const [date, pnl] of pnlByDate) {
    const key = weekKey(date);
    weeks.set(key, (weeks.get(key) ?? 0) + pnl);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, pnl]) => ({ date, pnl }));
}

function shapeSegment(
  stmt: DbStatement,
  start: string,
  end: string,
  startIdx: number,
  endIdx: number,
  pnlByDate: Map<string, number>,
): { date: string; index: number }[] {
  const targetReturn = endIdx / startIdx - 1;
  const capital = Math.max(stmt.endingNav, stmt.startingNav, 1000);
  const weeks = aggregateWeeklyPnl(pnlByDate).filter((w) => w.date >= start && w.date <= end);

  if (!weeks.length) {
    return [
      { date: start, index: startIdx },
      { date: end, index: endIdx },
    ];
  }

  const rawReturns = weeks.map((w) => {
    const r = w.pnl / capital;
    return Math.max(-0.1, Math.min(0.1, r));
  });
  const scale = solveReturnScale(rawReturns, targetReturn);

  let idx = startIdx;
  const points: { date: string; index: number }[] = [{ date: start, index: idx }];
  for (const week of weeks) {
    const r = Math.max(-0.1, Math.min(0.1, week.pnl / capital)) * scale;
    idx *= 1 + r;
    points.push({ date: week.date, index: idx });
  }

  if (points[points.length - 1].date !== end) {
    points.push({ date: end, index: endIdx });
  }
  points[points.length - 1].index = endIdx;
  return points;
}

/** TWRR daily chain from CSV events, calibrated to IBKR period TWRR */
function buildDailyTwrrPoints(
  stmt: DbStatement,
  startIdx: number,
): { date: string; index: number }[] {
  const events: DailyEvent[] = stmt.dailyEvents ?? [];
  if (!events.length) return [];

  const pnlByDate = sumByDate(events, (e) => e.amount);
  const endIdx = startIdx * (1 + stmt.twrr);
  const points = shapeSegment(
    stmt,
    stmt.periodStart,
    stmt.periodEnd,
    startIdx,
    endIdx,
    pnlByDate,
  );

  calibrateToTwrr(points, startIdx, stmt.twrr);
  return points;
}

function buildSubPoints(stmt: DbStatement, startIdx: number): { date: string; index: number }[] {
  const daily = buildDailyTwrrPoints(stmt, startIdx);
  if (daily.length >= 3) return daily;

  const flows = stmt.cashFlows
    .filter((c) => c.isExternal)
    .filter((c) => c.date >= stmt.periodStart && c.date <= stmt.periodEnd)
    .sort((a, b) => a.date.localeCompare(b.date));

  const bounds = [stmt.periodStart, ...flows.map((c) => c.date), stmt.periodEnd];
  const unique = bounds.filter((d, i, a) => i === 0 || d !== a[i - 1]);

  if (unique.length <= 2) {
    return [
      { date: stmt.periodStart, index: startIdx },
      { date: stmt.periodEnd, index: startIdx * (1 + stmt.twrr) },
    ];
  }

  const subR = Math.pow(1 + stmt.twrr, 1 / (unique.length - 1)) - 1;
  const pts: { date: string; index: number }[] = [];
  let cur = startIdx;
  for (let i = 0; i < unique.length; i++) {
    pts.push({ date: unique[i], index: cur });
    if (i < unique.length - 1) cur *= 1 + subR;
  }
  pts[pts.length - 1].index = startIdx * (1 + stmt.twrr);
  return pts;
}

function chainStatements(statements: DbStatement[]): { date: string; portfolio: number }[] {
  if (!statements.length) return [];

  const all: { date: string; portfolio: number }[] = [];
  let idx = 100;
  all.push({ date: statements[0].periodStart, portfolio: 100 });

  for (const s of statements) {
    const sub = buildSubPoints(s, idx);
    for (let i = 1; i < sub.length; i++) {
      all.push({ date: sub[i].date, portfolio: sub[i].index });
    }
    idx = sub[sub.length - 1].index;
  }

  const byDate = new Map<string, number>();
  for (const p of all) byDate.set(p.date, p.portfolio);

  const sorted = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  const daily = expandToDailyPoints(sorted);
  return daily.map(([date, portfolio]) => ({ date, portfolio: (portfolio / 100 - 1) * 100 }));
}

function expandToDailyPoints(points: [string, number][]): [string, number][] {
  if (points.length <= 1) return points;
  const out: [string, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [startDate, startVal] = points[i];
    const [endDate, endVal] = points[i + 1];
    const days = eachDay(startDate, endDate);
    for (let d = 0; d < days.length; d++) {
      const t = days.length <= 1 ? 1 : d / (days.length - 1);
      const v = startVal + (endVal - startVal) * t;
      if (!out.length || out[out.length - 1][0] !== days[d]) {
        out.push([days[d], v]);
      }
    }
  }
  const last = points[points.length - 1];
  if (!out.length || out[out.length - 1][0] !== last[0]) out.push(last);
  return out;
}

/** Build curve respecting gaps — each continuous segment resets to 0% at range start */
export function buildPerformanceCurve(
  statements: DbStatement[],
  rangeStart: string,
  rangeEnd: string,
): { date: string; portfolio: number; isGap?: boolean }[] {
  const groups = groupStatementsByContinuity(statements);
  if (!groups.length) return [];

  const segments: { date: string; portfolio: number }[][] = [];

  for (const group of groups) {
    const filtered = group.filter(
      (s) => s.periodStart <= rangeEnd && s.periodEnd >= rangeStart,
    );
    if (!filtered.length) continue;

    const curve = chainStatements(filtered);
    const inRange = curve.filter((p) => p.date >= rangeStart && p.date <= rangeEnd);
    if (inRange.length) segments.push(inRange);
  }

  if (!segments.length) return [];

  const primary = segments.reduce((best, seg) =>
    (seg.length > best.length ? seg : best), segments[0]);

  const base = primary[0].portfolio;
  return primary.map((p) => ({ date: p.date, portfolio: p.portfolio - base }));
}

export function alignBenchmark(
  portfolio: { date: string; portfolio: number }[],
  prices: Record<string, number>,
): PerformancePoint[] {
  const dates = Object.keys(prices).sort();
  let bi = 0;
  let startP: number | null = null;
  return portfolio.map((p) => {
    while (bi < dates.length && dates[bi] <= p.date) bi++;
    const bd = dates[bi - 1] ?? dates[0] ?? p.date;
    const price = prices[bd] ?? prices[p.date];
    if (price && startP === null) startP = price;
    return {
      date: p.date,
      portfolio: p.portfolio,
      benchmark: price && startP ? (price / startP - 1) * 100 : 0,
    };
  });
}

export function computeSummary(pts: PerformancePoint[], start: string, end: string): PerformanceSummary {
  if (pts.length < 2) {
    return { portfolioReturn: 0, benchmarkReturn: 0, alpha: 0, cagr: 0, benchmarkCagr: 0, days: 0 };
  }
  const last = pts[pts.length - 1];
  const days = Math.max(1, (new Date(end).getTime() - new Date(start).getTime()) / 864e5);
  const years = days / 365.25;
  const pf = 1 + last.portfolio / 100;
  const bf = 1 + last.benchmark / 100;
  return {
    portfolioReturn: last.portfolio,
    benchmarkReturn: last.benchmark,
    alpha: last.portfolio - last.benchmark,
    cagr: years > 0 ? (Math.pow(pf, 1 / years) - 1) * 100 : 0,
    benchmarkCagr: years > 0 ? (Math.pow(bf, 1 / years) - 1) * 100 : 0,
    days,
  };
}

export function getTimelineBounds(statements: DbStatement[]): { min: string; max: string } | null {
  return getDataBounds(statements);
}

/** Capital flows by date for TWRR (statements + optional Flex Cash Transactions) */
export function twrrCapitalFlowsByDate(
  statements: DbStatement[],
  extraFlows?: Map<string, number> | null,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of statements) {
    for (const cf of s.cashFlows) {
      if (!cf.isExternal) continue;
      map.set(cf.date, (map.get(cf.date) ?? 0) + cf.amount);
    }
  }
  if (extraFlows) {
    for (const [date, amount] of extraFlows) {
      map.set(date, (map.get(date) ?? 0) + amount);
    }
  }
  return map;
}

/** @deprecated Use twrrCapitalFlowsByDate */
export function externalCashFlowsByDate(statements: DbStatement[]): Map<string, number> {
  return twrrCapitalFlowsByDate(statements);
}

export function navPointsHaveComponents(points: DailyNavPoint[]): boolean {
  return points.some((p) => p.stock != null && p.cash != null);
}

/** Estimate capital flows only when no known flow exists for that day */
export function estimateExternalCashFlow(prev: DailyNavPoint, cur: DailyNavPoint): number {
  if (
    prev.stock == null ||
    cur.stock == null ||
    prev.cash == null ||
    cur.cash == null ||
    prev.total <= 0
  ) {
    return 0;
  }

  const dNav = cur.total - prev.total;
  const relNav = Math.abs(dNav) / prev.total;
  if (relNav < 0.02) return 0;

  const dInvest =
    (cur.stock + (cur.options ?? 0)) - (prev.stock + (prev.options ?? 0));
  const dCash = cur.cash - prev.cash;
  const investRatio = Math.abs(dNav) > 1 ? Math.abs(dInvest) / Math.abs(dNav) : 0;

  // Capital added/removed and immediately invested (deposit+trade or security transfer)
  if (relNav > 0.15 && investRatio > 0.85) return dNav;

  // Cash deposit/withdrawal — avoid false positives when trades move cash and stock together
  const residual = dNav - dInvest;
  const threshold = Math.max(500, prev.total * 0.01);
  if (
    Math.abs(dCash) > threshold &&
    Math.abs(residual) <= Math.abs(dNav) * 1.25 &&
    Math.abs(dCash) >= Math.abs(residual) * 0.6
  ) {
    return dCash;
  }

  return 0;
}

export type TwrrDataQuality = 'exact' | 'partial' | 'estimated' | 'raw_nav';

export function assessTwrrQuality(
  points: DailyNavPoint[],
  rangeStart: string,
  rangeEnd: string,
  cashFlowByDate: Map<string, number>,
): TwrrDataQuality {
  if (!navPointsHaveComponents(points)) return 'raw_nav';

  const filtered = points.filter((p) => p.date >= rangeStart && p.date <= rangeEnd);
  let known = 0;
  let estimated = 0;
  for (let i = 1; i < filtered.length; i++) {
    const prev = filtered[i - 1];
    const cur = filtered[i];
    if (cashFlowByDate.has(cur.date)) known++;
    else if (estimateExternalCashFlow(prev, cur) !== 0) estimated++;
  }

  if (known > 0 && estimated === 0) return 'exact';
  if (known > 0) return 'partial';
  if (estimated > 0) return 'estimated';
  return 'partial';
}

/** TWRR index from daily Flex NAV — deposits/withdrawals excluded when cash flows known */
export function buildTwrrCurveFromNav(
  points: DailyNavPoint[],
  rangeStart: string,
  rangeEnd: string,
  cashFlowByDate: Map<string, number>,
): { date: string; portfolio: number }[] {
  const filtered = points.filter((p) => p.date >= rangeStart && p.date <= rangeEnd);
  if (filtered.length < 2) return [];

  let index = 100;
  const out: { date: string; portfolio: number }[] = [];

  for (let i = 0; i < filtered.length; i++) {
    if (i === 0) {
      out.push({ date: filtered[i].date, portfolio: 0 });
      continue;
    }
    const prev = filtered[i - 1];
    const cur = filtered[i];
    const prevNav = prev.total;
    const nav = cur.total;
    const knownCf = cashFlowByDate.get(cur.date);
    const cf = knownCf ?? estimateExternalCashFlow(prev, cur);
    if (prevNav > 0) {
      const r = (nav - cf) / prevNav - 1;
      index *= 1 + r;
    }
    out.push({ date: cur.date, portfolio: index - 100 });
  }

  return out;
}

export function shouldPreferStatementCurve(
  statements: DbStatement[],
  rangeStart: string,
  rangeEnd: string,
): boolean {
  if (!statements.length) return false;
  const stmtBounds = getTimelineBounds(statements);
  if (!stmtBounds) return false;
  return rangeStart >= stmtBounds.min && rangeEnd <= stmtBounds.max;
}

export function twrrQualityLabel(quality: TwrrDataQuality): string {
  switch (quality) {
    case 'exact':
      return 'TWRR (flux de capitaux connus)';
    case 'partial':
      return 'TWRR (flux partiels + estimation)';
    case 'estimated':
      return 'TWRR estimé — ajoutez Cash Transactions Flex';
    case 'raw_nav':
      return 'NAV brute — réimportez le Flex NAV';
  }
}

export function twrrQualityNotice(quality: TwrrDataQuality): string | null {
  switch (quality) {
    case 'raw_nav':
      return 'Réimportez votre fichier Flex NAV (avec colonnes Stock/Cash) puis Ctrl+F5. Sans ces colonnes, les dépôts faussent le rendement (~+177 %).';
    case 'estimated':
      return 'Pour un TWRR exact sur toute la période, ajoutez une Flex Query « Cash Transactions » (CSV, 365 jours) et importez-la ici.';
    case 'partial':
      return 'Les flux après votre dernier Activity Statement sont estimés. Importez Cash Transactions Flex pour les mois manquants.';
    default:
      return null;
  }
}

export function getNavTimelineBounds(points: DailyNavPoint[]): { min: string; max: string } | null {
  if (!points.length) return null;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return { min: sorted[0].date, max: sorted[sorted.length - 1].date };
}

export function mergeTimelineBounds(
  a: { min: string; max: string } | null,
  b: { min: string; max: string } | null,
): { min: string; max: string } | null {
  if (!a) return b;
  if (!b) return a;
  return {
    min: a.min < b.min ? a.min : b.min,
    max: a.max > b.max ? a.max : b.max,
  };
}

export function getUniqueAccounts(
  statements: DbStatement[],
): { id: string; alias: string; currency: string }[] {
  const map = new Map<string, { id: string; alias: string; currency: string }>();
  for (const s of statements) {
    map.set(s.accountId, {
      id: s.accountId,
      alias: s.accountAlias || s.accountId,
      currency: s.baseCurrency,
    });
  }
  return [...map.values()];
}

export { mergeStatements } from './statements';

export async function fetchBenchmark(
  symbol: BenchmarkSymbol,
  start: string,
  end: string,
): Promise<Record<string, number>> {
  const res = await fetch(`/api/benchmark?symbol=${symbol}&start=${start}&end=${end}`);
  if (!res.ok) throw new Error('Benchmark indisponible');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.prices;
}

export function fmtPct(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}
