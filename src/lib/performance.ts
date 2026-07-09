import type { BenchmarkSymbol, DbStatement, PerformancePoint, PerformanceSummary } from './types';

function periodMs(s: DbStatement): number {
  return new Date(s.periodEnd).getTime() - new Date(s.periodStart).getTime();
}

function overlaps(a: DbStatement, b: DbStatement): boolean {
  return new Date(a.periodStart) <= new Date(b.periodEnd) && new Date(b.periodStart) <= new Date(a.periodEnd);
}

export function mergeStatements(statements: DbStatement[]): DbStatement[] {
  const byAccount = new Map<string, DbStatement[]>();
  for (const s of statements) {
    const list = byAccount.get(s.accountId) ?? [];
    list.push(s);
    byAccount.set(s.accountId, list);
  }

  const merged: DbStatement[] = [];
  for (const list of byAccount.values()) {
    const sorted = [...list].sort((a, b) => {
      const sd = new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime();
      if (sd !== 0) return sd;
      return periodMs(a) - periodMs(b);
    });
    const selected: DbStatement[] = [];
    for (const c of sorted) {
      const idx = selected.findIndex((s) => overlaps(s, c));
      if (idx === -1) { selected.push(c); continue; }
      const ex = selected[idx];
      if (periodMs(c) < periodMs(ex) || (periodMs(c) === periodMs(ex) && c.imported_at > ex.imported_at)) {
        selected[idx] = c;
      }
    }
    merged.push(...selected.sort((a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime()));
  }
  return merged;
}

function buildSubPoints(stmt: DbStatement, startIdx: number): { date: string; index: number }[] {
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

export function buildPerformanceCurve(
  statements: DbStatement[],
  rangeStart: string,
  rangeEnd: string,
): { date: string; portfolio: number }[] {
  const merged = mergeStatements(statements);
  if (!merged.length) return [];

  const all: { date: string; portfolio: number }[] = [];
  let idx = 100;
  all.push({ date: merged[0].periodStart, portfolio: 100 });

  for (const s of merged) {
    const sub = buildSubPoints(s, idx);
    for (let i = 1; i < sub.length; i++) all.push({ date: sub[i].date, portfolio: sub[i].index });
    idx = sub[sub.length - 1].index;
  }

  const pct = all.map((p) => ({ date: p.date, portfolio: (p.portfolio / 100 - 1) * 100 }));
  const filtered = pct.filter((p) => p.date >= rangeStart && p.date <= rangeEnd);
  if (!filtered.length) return [];
  const base = filtered[0].portfolio;
  return filtered.map((p) => ({ date: p.date, portfolio: p.portfolio - base }));
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
  if (pts.length < 2) return { portfolioReturn: 0, benchmarkReturn: 0, alpha: 0, cagr: 0, benchmarkCagr: 0, days: 0 };
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
  const merged = mergeStatements(statements);
  if (!merged.length) return null;
  return { min: merged[0].periodStart, max: merged[merged.length - 1].periodEnd };
}

export function getUniqueAccounts(statements: DbStatement[]): { id: string; alias: string; currency: string }[] {
  const map = new Map<string, { id: string; alias: string; currency: string }>();
  for (const s of statements) {
    map.set(s.accountId, { id: s.accountId, alias: s.accountAlias || s.accountId, currency: s.baseCurrency });
  }
  return [...map.values()];
}

export async function fetchBenchmark(symbol: BenchmarkSymbol, start: string, end: string): Promise<Record<string, number>> {
  const res = await fetch(`/api/benchmark?symbol=${symbol}&start=${start}&end=${end}`);
  if (!res.ok) throw new Error('Benchmark indisponible');
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.prices;
}

export function fmtPct(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}
