import {
  addDays,
  format,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
  subYears,
} from 'date-fns';
import type { DatePreset, DbStatement, TimelineGap, TimelineHealth } from './types';
import { groupStatementsByContinuity, mergeStatements } from './statements';

function fmt(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000,
  );
}

export function detectGaps(statements: DbStatement[]): TimelineGap[] {
  const merged = mergeStatements(statements);
  const gaps: TimelineGap[] = [];
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    const gapDays = daysBetween(prev.periodEnd, cur.periodStart);
    if (gapDays > 5) {
      gaps.push({
        from: addDays(new Date(prev.periodEnd + 'T12:00:00'), 1).toISOString().slice(0, 10),
        to: addDays(new Date(cur.periodStart + 'T12:00:00'), -1).toISOString().slice(0, 10),
        days: gapDays - 1,
      });
    }
  }
  return gaps;
}

export function getDataBounds(statements: DbStatement[]): { min: string; max: string } | null {
  const merged = mergeStatements(statements);
  if (!merged.length) return null;
  return { min: merged[0].periodStart, max: merged[merged.length - 1].periodEnd };
}

export type EffectiveBounds = {
  min: string;
  max: string;
  dataMin: string;
  locked: boolean;
};

/** Applique le verrou de début d'analyse (stratégie / couper l'historique). */
export function effectiveTimelineBounds(
  bounds: { min: string; max: string },
  startLock?: string | null,
): EffectiveBounds {
  const lock = startLock?.trim();
  if (!lock || lock <= bounds.min) {
    return { min: bounds.min, max: bounds.max, dataMin: bounds.min, locked: false };
  }
  if (lock > bounds.max) {
    // Verrou après la fin des données — ignoré (ex. compte conservé après purge)
    return { min: bounds.min, max: bounds.max, dataMin: bounds.min, locked: false };
  }
  return { min: lock, max: bounds.max, dataMin: bounds.min, locked: true };
}

export function clampDateRange(
  start: string,
  end: string,
  bounds: { min: string; max: string },
): { start: string; end: string } {
  let s = start < bounds.min ? bounds.min : start;
  let e = end > bounds.max ? bounds.max : end;
  if (s > e) s = bounds.min;
  if (e < s) e = bounds.max;
  return { start: s, end: e };
}

export function applyDatePreset(
  preset: DatePreset,
  bounds: { min: string; max: string },
  today = new Date(),
): { start: string; end: string } {
  const end = bounds.max;
  const endDate = new Date(end + 'T12:00:00');
  const todayStr = fmt(today);

  let startDate: Date;
  switch (preset) {
    case '1W':
      startDate = subWeeks(endDate, 1);
      break;
    case '1M':
      startDate = subMonths(endDate, 1);
      break;
    case 'MTD':
      startDate = startOfMonth(today);
      break;
    case '3M':
      startDate = subMonths(endDate, 3);
      break;
    case '6M':
      startDate = subMonths(endDate, 6);
      break;
    case '1Y':
      startDate = subYears(endDate, 1);
      break;
    case 'YTD':
      startDate = startOfYear(today);
      break;
    case 'MAX':
    default:
      return { start: bounds.min, end: bounds.max };
  }

  const start = fmt(startDate);
  return {
    start: start < bounds.min ? bounds.min : start,
    end: end > todayStr ? todayStr : end,
  };
}

export function analyzeTimeline(
  statements: DbStatement[],
  rangeStart: string,
  rangeEnd: string,
  boundsOverride?: { min: string; max: string } | null,
): TimelineHealth {
  const bounds = boundsOverride ?? getDataBounds(statements);
  const gaps = boundsOverride ? [] : detectGaps(statements);
  const today = fmt(new Date());

  let daysSinceLastData: number | null = null;
  let isStale = false;
  if (bounds) {
    daysSinceLastData = daysBetween(bounds.max, today);
    isStale = daysSinceLastData > 35;
  }

  if (!bounds) {
    return {
      dataStart: null,
      dataEnd: null,
      gaps: [],
      daysSinceLastData: null,
      isStale: false,
      rangeCoverage: {
        requestedStart: rangeStart,
        requestedEnd: rangeEnd,
        availableStart: null,
        availableEnd: null,
        missingBefore: true,
        missingAfter: true,
        hasAnyData: false,
        message: 'Aucune donnée importée pour ce compte.',
      },
    };
  }

  const availableStart = rangeStart > bounds.min ? rangeStart : bounds.min;
  const availableEnd = rangeEnd < bounds.max ? rangeEnd : bounds.max;
  const hasAnyData = availableStart <= availableEnd && availableEnd >= bounds.min && availableStart <= bounds.max;

  const missingBefore = rangeStart < bounds.min;
  const missingAfter = rangeEnd > bounds.max;

  const gapsInRange = gaps.filter(
    (g) => g.to >= rangeStart && g.from <= rangeEnd,
  );

  let message: string | null = null;
  if (!hasAnyData) {
    if (rangeEnd < bounds.min) {
      message = `Aucune donnée avant ${bounds.min}. Vos données commencent à cette date.`;
    } else if (rangeStart > bounds.max) {
      message = `Aucune donnée après ${bounds.max}. Importez un CSV plus récent.`;
    } else {
      message = 'Aucune donnée pour cette plage.';
    }
  } else {
    const parts: string[] = [];
    if (missingBefore) {
      parts.push(`données disponibles à partir du ${bounds.min}`);
    }
    if (missingAfter) {
      parts.push(`dernières données : ${bounds.max}`);
    }
    if (gapsInRange.length > 0) {
      const g = gapsInRange[0];
      parts.push(`trou de ${g.days} jours (${g.from} → ${g.to})`);
    }
    if (isStale && missingAfter) {
      parts.push(`données en retard de ${daysSinceLastData} jours`);
    }
    if (parts.length) message = parts.join(' · ');
  }

  return {
    dataStart: bounds.min,
    dataEnd: bounds.max,
    gaps,
    daysSinceLastData,
    isStale,
    rangeCoverage: {
      requestedStart: rangeStart,
      requestedEnd: rangeEnd,
      availableStart: hasAnyData ? availableStart : null,
      availableEnd: hasAnyData ? availableEnd : null,
      missingBefore,
      missingAfter,
      hasAnyData,
      message,
    },
  };
}

/** Segments of statements that intersect a date range */
export function statementsInRange(
  statements: DbStatement[],
  rangeStart: string,
  rangeEnd: string,
): DbStatement[] {
  return mergeStatements(statements).filter(
    (s) => s.periodStart <= rangeEnd && s.periodEnd >= rangeStart,
  );
}

export function getContinuityGroupsInRange(
  statements: DbStatement[],
  rangeStart: string,
  rangeEnd: string,
): DbStatement[][] {
  const inRange = statementsInRange(statements, rangeStart, rangeEnd);
  return groupStatementsByContinuity(inRange);
}
