import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';

export interface ChartBrushSelection {
  startIdx: number;
  endIdx: number;
  startDate: string;
  endDate: string;
}

export function normalizeBrushIndices(a: number, b: number, max: number): ChartBrushSelection | null {
  const startIdx = Math.max(0, Math.min(a, b));
  const endIdx = Math.min(max, Math.max(a, b));
  if (endIdx - startIdx < 1) return null;
  return { startIdx, endIdx, startDate: '', endDate: '' };
}

export function sliceAndRebaseChartData(
  data: MultiSeriesChartPoint[],
  seriesIds: string[],
  startIdx: number,
  endIdx: number,
): MultiSeriesChartPoint[] {
  const slice = data.slice(startIdx, endIdx + 1);
  if (slice.length < 2) return slice;

  // A series may start later or end earlier than the others: base on its first real value.
  const bases = new Map<string, number>();
  for (const id of seriesIds) {
    const first = slice.find((p) => typeof p[id] === 'number');
    bases.set(id, 1 + ((first?.[id] as number | undefined) ?? 0) / 100);
  }

  return slice.map((p) => {
    const row: MultiSeriesChartPoint = { date: p.date };
    for (const id of seriesIds) {
      if (typeof p[id] !== 'number') continue; // outside this series' dates: stays empty
      const level = 1 + (p[id] as number) / 100;
      const base = bases.get(id) ?? 1;
      row[id] = base > 0 ? (level / base - 1) * 100 : 0;
    }
    return row;
  });
}

/** Rendement total % entre deux points d'une courbe cumulative % (non rebasée). */
export function rangeTotalReturn(cumStart: number, cumEnd: number): number {
  const startLevel = 1 + cumStart / 100;
  const endLevel = 1 + cumEnd / 100;
  if (startLevel <= 0) return 0;
  return (endLevel / startLevel - 1) * 100;
}

export interface RangeReturnRow {
  seriesId: string;
  label: string;
  color: string;
  totalReturn: number;
}

export function computeBrushRangeReturns(
  data: MultiSeriesChartPoint[],
  series: ChartSeriesDef[],
  startIdx: number,
  endIdx: number,
): RangeReturnRow[] {
  if (!data[startIdx] || !data[endIdx]) return [];

  // First and last real value inside the selection (a series can start late or end early).
  return series.map((s) => {
    let a = startIdx;
    while (a <= endIdx && typeof data[a][s.id] !== 'number') a++;
    let b = endIdx;
    while (b >= startIdx && typeof data[b][s.id] !== 'number') b--;
    const hasRange = a <= b;
    return {
      seriesId: s.id,
      label: s.label,
      color: s.color,
      totalReturn: hasRange
        ? rangeTotalReturn(data[a][s.id] as number, data[b][s.id] as number)
        : 0,
    };
  });
}

export const CHART_SYNC_ID = 'ibkr-portfolio-charts';
/** Largeur réservée à l'axe Y — identique sur performance et drawdown pour aligner les abscisses. */
export const CHART_YAXIS_WIDTH = 48;
export const CHART_PLOT_MARGIN = { top: 8, right: 12, left: 0, bottom: 0 };
export const CHART_PLOT_MARGIN_BOTTOM = { top: 8, right: 12, left: 0, bottom: 4 };

export function clientXToDataIndex(
  clientX: number,
  rect: DOMRect,
  dataLength: number,
): number {
  if (dataLength < 2) return 0;
  const plotWidth = rect.width - CHART_YAXIS_WIDTH - CHART_PLOT_MARGIN.right;
  const x = clientX - rect.left - CHART_YAXIS_WIDTH;
  const ratio = Math.max(0, Math.min(1, x / Math.max(plotWidth, 1)));
  return Math.round(ratio * (dataLength - 1));
}

/** Position horizontale (px depuis la gauche du conteneur) pour un index de données. */
export function dataIndexToPlotX(
  index: number,
  rect: DOMRect,
  dataLength: number,
): number {
  if (dataLength < 2) return CHART_YAXIS_WIDTH;
  const plotWidth = rect.width - CHART_YAXIS_WIDTH - CHART_PLOT_MARGIN.right;
  const ratio = index / (dataLength - 1);
  return CHART_YAXIS_WIDTH + ratio * plotWidth;
}

/** Points drawn on screen. The cursor still walks every simulated day. */
export const PAINT_POINTS = 720;

/**
 * Evenly spaced rows for the painted line, with each series value replaced by the
 * biggest move inside its slice so a crash between two pixels stays visible.
 */
export function sampleEvenExtremes<T extends Record<string, number | string | boolean | null | undefined>>(
  rows: T[],
  keys: string[],
  maxPoints = PAINT_POINTS,
): T[] {
  const n = rows.length;
  if (n <= maxPoints) return rows;
  const last = n - 1;
  const denom = maxPoints - 1;
  const indexes: number[] = [];
  let prev = -1;
  for (let k = 0; k < maxPoints; k++) {
    const i = Math.round((k * last) / denom);
    if (i !== prev) {
      indexes.push(i);
      prev = i;
    }
  }
  return indexes.map((i, k) => {
    const end = indexes[k + 1] ?? i;
    const row: Record<string, number | string | boolean | null | undefined> = { ...rows[i] };
    for (const key of keys) {
      const start = rows[i][key];
      if (typeof start !== 'number') continue;
      let best = start;
      let bestDist = 0;
      for (let j = i + 1; j <= end; j++) {
        const v = rows[j][key];
        if (typeof v !== 'number') continue;
        const dist = Math.abs(v - start);
        if (dist > bestDist) {
          best = v;
          bestDist = dist;
        }
      }
      row[key] = best;
    }
    return row as T;
  });
}
