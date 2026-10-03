import type { BenchmarkSymbol, DailyEvent, DailyNavPoint, DailyTwrPoint, DbStatement, DrawdownPoint, PerformancePoint, PerformanceSummary } from './types';
import { groupStatementsByContinuity, mergeStatements } from './statements';
import { getTwrTimelineBounds } from './twr-mapper';
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
    return {
      portfolioReturn: 0,
      benchmarkReturn: 0,
      alpha: 0,
      cagr: 0,
      benchmarkCagr: 0,
      maxDrawdown: 0,
      days: 0,
    };
  }
  const last = pts[pts.length - 1];
  const days = Math.max(1, (new Date(end).getTime() - new Date(start).getTime()) / 864e5);
  const years = days / 365.25;
  const pf = 1 + last.portfolio / 100;
  const bf = 1 + last.benchmark / 100;
  const dd = computeDrawdownSeries(pts);
  return {
    portfolioReturn: last.portfolio,
    benchmarkReturn: last.benchmark,
    alpha: last.portfolio - last.benchmark,
    cagr: years > 0 ? (Math.pow(pf, 1 / years) - 1) * 100 : 0,
    benchmarkCagr: years > 0 ? (Math.pow(bf, 1 / years) - 1) * 100 : 0,
    maxDrawdown: getMaxDrawdown(dd),
    days,
  };
}

/** Drawdown % depuis le pic (valeurs ≤ 0). */
export function computeDrawdownSeries(
  points: { date: string; portfolio: number }[],
): DrawdownPoint[] {
  let peak = -Infinity;
  return points.map((p) => {
    const level = 100 + p.portfolio;
    if (level > peak) peak = level;
    const drawdown = peak > 0 ? (level / peak - 1) * 100 : 0;
    return { date: p.date, drawdown };
  });
}

export function getMaxDrawdown(series: DrawdownPoint[]): number {
  if (!series.length) return 0;
  return Math.min(...series.map((p) => p.drawdown));
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

// ---------------------------------------------------------------------------------------------
// Capital flows behind a NAV-only TWRR.
//
// Daily NAV (total, cash, stock) cannot tell a deposit from a trade: buying shares moves cash into
// stock, a deposit raises cash, and shares transferred in raise stock alone. Rules that read the cash
// leg alone turn every trade into a "deposit" (measured on a real account over 199 days: +76 % instead
// of the +18 % IBKR reports). So the flow of a day is decided by which explanation leaves the
// smallest market move, with thresholds learned from the account's own volatility:
//   1. A flow declared by a source (Statement, Flex Cash Transactions / Transfers) is authoritative.
//      It is aligned to the NAV day it really shows up on (report / settle / trade dates differ).
//   2. Without any declared flow, a cash move is a deposit/withdrawal when treating it as one leaves a
//      smaller market move than treating the day as a plain trade (change of total ~ market only).
//   3. A jump of the total beyond what the account's own volatility explains, with no cash to
//      account for it, is treated as shares transferred in/out (never visible in NAV alone).
// Every flow inferred this way is reported so the page can show it; the official IBKR TWR (Performance
// report) remains the exact source and always wins when imported.
// ---------------------------------------------------------------------------------------------

const NAV_FLOW_SIGMAS = 4; // a daily move beyond 4 robust sigmas of the account is not just the market
const NAV_FLOW_MIN_SHARE = 0.01; // cash moves below 1 % of the NAV are not worth a flow
const NAV_FLOW_CASH_RATIO = 0.75; // cash explains the day if it leaves < 75 % of the raw NAV move
const NAV_FLOW_ALIGN_DAYS = 3; // a declared flow may sit up to 3 NAV days from its record date

export interface InferredNavFlow {
  date: string;
  amount: number;
  kind: 'cash' | 'jump';
}

export interface NavFlowEstimate {
  /** Capital flow by NAV date (positive: money or shares in). */
  flows: Map<string, number>;
  /** Flows no record declared: found from the NAV itself. */
  inferred: InferredNavFlow[];
  /** At least one flow came from a declared source. */
  hasDeclared: boolean;
}

function robustDailySigma(points: DailyNavPoint[]): number {
  const moves: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].total;
    if (prev > 0) moves.push(Math.abs(points[i].total - prev) / prev);
  }
  if (!moves.length) return 0.002;
  moves.sort((a, b) => a - b);
  const mid = Math.floor(moves.length / 2);
  const median = moves.length % 2 ? moves[mid] : (moves[mid - 1] + moves[mid]) / 2;
  return Math.max(1.4826 * median, 0.002);
}

export function estimateNavFlows(
  points: DailyNavPoint[],
  declared: Map<string, number>,
): NavFlowEstimate {
  const pts = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const flows = new Map<string, number>();
  const inferred: InferredNavFlow[] = [];
  const hasDeclared = declared.size > 0;
  const n = pts.length;
  if (n < 2) return { flows, inferred, hasDeclared };

  const move = (i: number) => pts[i].total - pts[i - 1].total;

  // 1. Declared flows, each placed on the NAV day that actually carries it.
  const declaredByIndex = new Map<number, number>();
  for (const [date, amount] of declared) {
    let i0 = pts.findIndex((p) => p.date >= date);
    if (i0 < 0 || (i0 === 0 && pts[0].date !== date && date < pts[0].date)) continue;
    if (i0 === 0) continue; // no previous NAV to measure the day against
    // A flow shows in the total, and a cash flow also in the cash leg: take the closest match of both.
    const fit = (j: number) => {
      const viaTotal = Math.abs(move(j) - amount);
      const a = pts[j].cash;
      const b = pts[j - 1].cash;
      return a != null && b != null ? Math.min(viaTotal, Math.abs(a - b - amount)) : viaTotal;
    };
    let best = i0;
    let bestErr = fit(i0);
    for (let j = Math.max(1, i0 - NAV_FLOW_ALIGN_DAYS); j <= Math.min(n - 1, i0 + NAV_FLOW_ALIGN_DAYS); j++) {
      const err = fit(j);
      if (err < bestErr) { best = j; bestErr = err; }
    }
    // Move it only when another day matches clearly better than the recorded date.
    if (best !== i0 && bestErr >= 0.5 * fit(i0)) best = i0;
    declaredByIndex.set(best, (declaredByIndex.get(best) ?? 0) + amount);
  }

  const hasComponents = navPointsHaveComponents(pts);
  const sigma = robustDailySigma(pts);

  for (let i = 1; i < n; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];

    const known = declaredByIndex.get(i);
    if (known !== undefined) {
      flows.set(cur.date, known);
      continue;
    }
    if (!hasComponents || prev.total <= 0) continue;
    if (prev.cash == null || cur.cash == null || prev.stock == null || cur.stock == null) continue;

    const dTotal = cur.total - prev.total;
    const dCash = cur.cash - prev.cash;
    const dStock = cur.stock - prev.stock;
    const marketBand = NAV_FLOW_SIGMAS * sigma * prev.total;
    const stockBand = NAV_FLOW_SIGMAS * sigma * Math.max(prev.stock, 1);

    let flow = 0;
    let kind: InferredNavFlow['kind'] | null = null;
    if (
      !hasDeclared &&
      Math.abs(dCash) >= NAV_FLOW_MIN_SHARE * prev.total &&
      Math.abs(dTotal - dCash) < NAV_FLOW_CASH_RATIO * Math.abs(dTotal)
    ) {
      // Cash entered/left. If the stock leg moved like the market the cash is the flow; if it moved
      // more, trades share the day and the cash is polluted: the total is the better measure.
      flow = Math.abs(dStock) <= stockBand ? dCash : dTotal;
      kind = 'cash';
    } else if (Math.abs(dTotal) > marketBand) {
      flow = dTotal;
      kind = 'jump';
    }

    if (flow !== 0 && kind) {
      flows.set(cur.date, flow);
      inferred.push({ date: cur.date, amount: flow, kind });
    }
  }

  return { flows, inferred, hasDeclared };
}

export type TwrrDataQuality = 'exact' | 'partial' | 'estimated' | 'raw_nav';

export function assessTwrrQuality(
  points: DailyNavPoint[],
  rangeStart: string,
  rangeEnd: string,
  cashFlowByDate: Map<string, number>,
): TwrrDataQuality {
  if (!navPointsHaveComponents(points)) {
    return cashFlowByDate.size > 0 ? 'estimated' : 'raw_nav';
  }
  const est = estimateNavFlows(points, cashFlowByDate);
  const inRange = est.inferred.filter((f) => f.date >= rangeStart && f.date <= rangeEnd);
  return est.hasDeclared && inRange.length === 0 ? 'exact' : 'partial';
}

/** Flows found from the NAV alone inside the range (shown to the person so nothing is silent). */
export function inferredNavFlows(
  points: DailyNavPoint[],
  rangeStart: string,
  rangeEnd: string,
  cashFlowByDate: Map<string, number>,
): InferredNavFlow[] {
  if (!navPointsHaveComponents(points)) return [];
  return estimateNavFlows(points, cashFlowByDate).inferred.filter(
    (f) => f.date >= rangeStart && f.date <= rangeEnd,
  );
}

/** TWRR index from daily Flex NAV — external flows excluded (index-like) */
export function buildTwrrCurveFromNav(
  points: DailyNavPoint[],
  rangeStart: string,
  rangeEnd: string,
  cashFlowByDate: Map<string, number>,
): { date: string; portfolio: number }[] {
  const filtered = points.filter((p) => p.date >= rangeStart && p.date <= rangeEnd);
  if (filtered.length < 2) return [];

  const { flows } = estimateNavFlows(points, cashFlowByDate);
  let index = 100;
  const out: { date: string; portfolio: number }[] = [];

  for (let i = 0; i < filtered.length; i++) {
    if (i === 0) {
      out.push({ date: filtered[i].date, portfolio: 0 });
      continue;
    }
    const prevNav = filtered[i - 1].total;
    const nav = filtered[i].total;
    const cf = flows.get(filtered[i].date) ?? 0;
    if (prevNav > 0) {
      index *= 1 + (nav - cf) / prevNav - 1;
    }
    out.push({ date: filtered[i].date, portfolio: index - 100 });
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
      return 'TWRR — dépôts/retraits exclus (NAV Stock/Cash)';
    case 'partial':
      return 'TWRR estimé — mouvements de capitaux déduits de la NAV';
    case 'estimated':
      return 'TWRR estimé — réimportez Flex NAV avec Stock/Cash';
    case 'raw_nav':
      return 'NAV brute — réimportez le Flex NAV';
  }
}

export function twrrQualityNotice(quality: TwrrDataQuality): string | null {
  switch (quality) {
    case 'raw_nav':
      return 'Réimportez votre fichier Flex NAV (avec colonnes Stock/Cash) puis Ctrl+F5. Sans ces colonnes, les dépôts faussent le rendement (~+177 %).';
    case 'estimated':
      return 'Réimportez un Flex NAV avec colonnes Stock et Cash, ou un CSV combiné NAV + Cash Transactions.';
    case 'partial':
      return 'Rendement estimé à partir de la valeur du compte : les dépôts/retraits non déclarés sont déduits automatiquement. Pour le TWR exact, importe le Rapport Performance IBKR (PortfolioAnalyst).';
    default:
      return null;
  }
}

export function getIbkrTwrDailyPoints(statements: DbStatement[]): DailyTwrPoint[] {
  const map = new Map<string, DailyTwrPoint>();
  for (const s of [...statements].sort((a, b) => a.periodStart.localeCompare(b.periodStart))) {
    for (const p of s.twrDaily ?? []) {
      map.set(p.date, p);
    }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function hasIbkrTwrDaily(statements: DbStatement[]): boolean {
  return getIbkrTwrDailyPoints(statements).length >= 2;
}

/** Chain official IBKR daily TWR — deposits/withdrawals already excluded by IBKR */
export function buildCurveFromIbkrTwrDaily(
  points: DailyTwrPoint[],
  rangeStart: string,
  rangeEnd: string,
): { date: string; portfolio: number }[] {
  const filtered = points.filter((p) => p.date >= rangeStart && p.date <= rangeEnd);
  if (!filtered.length) return [];

  let idx = 100;
  return filtered.map((p) => {
    idx *= 1 + p.returnPct / 100;
    return { date: p.date, portfolio: idx - 100 };
  });
}

/** Merge TWR journalier : twr_series (prioritaire) + statements.twr_daily */
export function resolveIbkrTwrDailyPoints(
  twrSeriesPoints: DailyTwrPoint[] | null | undefined,
  statements: DbStatement[],
): DailyTwrPoint[] {
  if (twrSeriesPoints && twrSeriesPoints.length >= 2) {
    return [...twrSeriesPoints].sort((a, b) => a.date.localeCompare(b.date));
  }
  return getIbkrTwrDailyPoints(statements);
}

export function hasResolvedIbkrTwrDaily(
  twrSeriesPoints: DailyTwrPoint[] | null | undefined,
  statements: DbStatement[],
): boolean {
  return resolveIbkrTwrDailyPoints(twrSeriesPoints, statements).length >= 2;
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

/** Bornes min/max en fusionnant statements, NAV et TWR journalier. */
export function getAccountTimelineBounds(
  statements: DbStatement[],
  navPoints?: DailyNavPoint[] | null,
  twrPoints?: DailyTwrPoint[] | null,
): { min: string; max: string } | null {
  return mergeTimelineBounds(
    mergeTimelineBounds(
      getTimelineBounds(statements),
      navPoints?.length ? getNavTimelineBounds(navPoints) : null,
    ),
    twrPoints?.length ? getTwrTimelineBounds(twrPoints) : null,
  );
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

/** Valeur absolue en % (volatilité, ulcer index…) — sans signe +. */
export function fmtAbsPct(v: number, digits = 2): string {
  return `${v.toFixed(digits)}%`;
}
