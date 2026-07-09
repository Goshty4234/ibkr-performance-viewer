import type { DbStatement } from './types';

const MS_DAY = 86_400_000;
/** Max gap between statement periods before treating as a break in the chain */
const ADJACENCY_DAYS = 5;

export function periodsOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  // Strict interior overlap — touching at one boundary day is NOT overlap
  return aStart < bEnd && bStart < aEnd;
}

export function periodsAreSame(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart === bStart && aEnd === bEnd;
}

export function periodMs(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}

export function periodMsStmt(s: DbStatement): number {
  return periodMs(s.periodStart, s.periodEnd);
}

export function overlaps(a: DbStatement, b: DbStatement): boolean {
  return periodsOverlap(a.periodStart, a.periodEnd, b.periodStart, b.periodEnd);
}

export function isFullyContained(
  innerStart: string,
  innerEnd: string,
  outerStart: string,
  outerEnd: string,
): boolean {
  return innerStart >= outerStart && innerEnd <= outerEnd;
}

/** Pick best statement per overlap cluster for display (shorter = finer granularity) */
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
      return periodMsStmt(a) - periodMsStmt(b);
    });
    const selected: DbStatement[] = [];
    for (const c of sorted) {
      const idx = selected.findIndex((s) => overlaps(s, c));
      if (idx === -1) {
        selected.push(c);
        continue;
      }
      const ex = selected[idx];
      if (
        periodMsStmt(c) < periodMsStmt(ex) ||
        (periodMsStmt(c) === periodMsStmt(ex) && c.imported_at > ex.imported_at)
      ) {
        selected[idx] = c;
      }
    }
    merged.push(
      ...selected.sort(
        (a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime(),
      ),
    );
  }
  return merged;
}

/** Statements that should be removed from DB when importing a new overlapping period */
export function findStatementsToReplaceOnImport(
  existing: DbStatement[],
  portfolioAccountId: string,
  newStart: string,
  newEnd: string,
): DbStatement[] {
  return existing.filter((s) => {
    if (s.portfolioAccountId !== portfolioAccountId) return false;

    // Same period → refresh / replace
    if (periodsAreSame(s.periodStart, s.periodEnd, newStart, newEnd)) return true;

    if (!periodsOverlap(s.periodStart, s.periodEnd, newStart, newEnd)) return false;

    // New period fully contains old → old is redundant
    if (isFullyContained(s.periodStart, s.periodEnd, newStart, newEnd)) return true;

    // Old fully contains new → replace old with new (user refreshed a sub-range)
    if (isFullyContained(newStart, newEnd, s.periodStart, s.periodEnd)) return true;

    // Real partial overlap (shared days, not just boundary touch)
    return true;
  });
}

export function arePeriodsAdjacent(prevEnd: string, nextStart: string): boolean {
  const gap = new Date(nextStart).getTime() - new Date(prevEnd).getTime();
  return gap >= 0 && gap <= ADJACENCY_DAYS * MS_DAY;
}

export function groupStatementsByContinuity(statements: DbStatement[]): DbStatement[][] {
  const merged = mergeStatements(statements);
  if (!merged.length) return [];

  const groups: DbStatement[][] = [[merged[0]]];
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    if (arePeriodsAdjacent(prev.periodEnd, cur.periodStart)) {
      groups[groups.length - 1].push(cur);
    } else {
      groups.push([cur]);
    }
  }
  return groups;
}
