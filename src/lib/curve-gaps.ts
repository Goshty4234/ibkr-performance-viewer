export interface CurvePoint {
  date: string;
  value: number;
  isGap?: boolean;
}

const GAP_THRESHOLD_DAYS = 5;

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86_400_000,
  );
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Insère des points plats (isGap) entre deux imports séparés par un trou calendaire.
 * Pas de variation pendant le trou — la ligne continue en gris pointillé.
 */
export function expandCurveGaps(
  curve: { date: string; portfolio: number }[],
): CurvePoint[] {
  if (curve.length < 2) {
    return curve.map((p) => ({ date: p.date, value: p.portfolio, isGap: false }));
  }

  const out: CurvePoint[] = [];
  for (let i = 0; i < curve.length; i++) {
    out.push({ date: curve[i].date, value: curve[i].portfolio, isGap: false });
    if (i >= curve.length - 1) break;

    const gapDays = daysBetween(curve[i].date, curve[i + 1].date);
    if (gapDays <= GAP_THRESHOLD_DAYS) continue;

    const flat = curve[i].portfolio;
    let d = addDays(curve[i].date, 1);
    const end = curve[i + 1].date;
    while (d < end) {
      out.push({ date: d, value: flat, isGap: true });
      const step = gapDays > 60 ? 7 : 1;
      d = addDays(d, step);
    }
  }
  return out;
}

export function curveFirstDataDate(curve: CurvePoint[]): string | null {
  const real = curve.find((p) => !p.isGap);
  return real?.date ?? curve[0]?.date ?? null;
}

/** Début effectif = max(verrou, début le plus récent parmi toutes les courbes). */
export function resolveComparisonChartStart(
  effStart: string,
  curves: CurvePoint[][],
): string {
  const starts = curves
    .map((c) => curveFirstDataDate(c))
    .filter((d): d is string => !!d);
  return [effStart, ...starts].reduce((a, b) => (a > b ? a : b));
}

export function trimAndRebaseCurve(curve: CurvePoint[], chartStart: string): CurvePoint[] {
  const sorted = [...curve].sort((a, b) => a.date.localeCompare(b.date));
  const atOrBefore = sorted.filter((p) => p.date <= chartStart);
  const basePt =
    [...atOrBefore].reverse().find((p) => !p.isGap) ??
    sorted.find((p) => p.date >= chartStart && !p.isGap) ??
    sorted[0];
  if (!basePt) return [];

  const baseLevel = 1 + basePt.value / 100;
  return sorted
    .filter((p) => p.date >= chartStart)
    .map((p) => ({
      date: p.date,
      value: baseLevel > 0 ? ((1 + p.value / 100) / baseLevel - 1) * 100 : 0,
      isGap: p.isGap,
    }));
}

export function unionDates(curves: CurvePoint[][]): string[] {
  const set = new Set<string>();
  for (const c of curves) {
    for (const p of c) set.add(p.date);
  }
  return [...set].sort();
}
