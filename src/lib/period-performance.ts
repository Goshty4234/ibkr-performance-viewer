import type { ChartSeriesDef, MultiSeriesChartPoint } from './chart-series';

export interface PeriodMetrics {
  period: string;
  returnPct: number;
  cumulativePct: number;
  multiple: number;
}

export interface SeriesPeriodTable {
  seriesId: string;
  label: string;
  color: string;
  periods: Map<string, PeriodMetrics>;
}

function levelFromCumPct(pct: number): number {
  return 1 + pct / 100;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86_400_000,
  );
}

function valueAtOrBefore(
  data: MultiSeriesChartPoint[],
  seriesId: string,
  date: string,
): number | null {
  let last: number | null = null;
  for (const row of data) {
    if (row.date > date) break;
    const gap = row[`${seriesId}__gap`];
    if (gap) continue;
    const v = row[seriesId];
    if (typeof v === 'number') last = v;
  }
  return last;
}

function lastDateBefore(data: MultiSeriesChartPoint[], beforeDate: string): string | null {
  let last: string | null = null;
  for (const row of data) {
    if (row.date >= beforeDate) break;
    last = row.date;
  }
  return last;
}

function periodReturn(
  data: MultiSeriesChartPoint[],
  seriesId: string,
  periodStart: string,
  periodEnd: string,
): PeriodMetrics | null {
  const startVal = valueAtOrBefore(data, seriesId, periodStart);
  const endVal = valueAtOrBefore(data, seriesId, periodEnd);
  if (startVal == null || endVal == null) return null;

  const startLevel = levelFromCumPct(startVal);
  const endLevel = levelFromCumPct(endVal);
  const returnPct = startLevel > 0 ? (endLevel / startLevel - 1) * 100 : 0;

  const chartStartVal = valueAtOrBefore(data, seriesId, data[0]?.date ?? periodStart);
  const baseLevel = chartStartVal != null ? levelFromCumPct(chartStartVal) : 1;
  const cumulativePct = baseLevel > 0 ? (endLevel / baseLevel - 1) * 100 : 0;
  const multiple = baseLevel > 0 ? endLevel / baseLevel : 1;

  return {
    period: periodEnd.slice(0, 7),
    returnPct,
    cumulativePct,
    multiple,
  };
}

export function buildYearlyPeriodTables(
  data: MultiSeriesChartPoint[],
  series: ChartSeriesDef[],
): { years: string[]; tables: SeriesPeriodTable[] } {
  if (data.length < 2) return { years: [], tables: [] };

  const years = [...new Set(data.map((r) => r.date.slice(0, 4)))].sort();
  const tables: SeriesPeriodTable[] = series.map((s) => ({
    seriesId: s.id,
    label: s.label,
    color: s.color,
    periods: new Map(),
  }));

  for (const year of years) {
    const rowsInYear = data.filter((r) => r.date.startsWith(year));
    if (!rowsInYear.length) continue;
    const periodEnd = rowsInYear[rowsInYear.length - 1].date;
    const periodStart = lastDateBefore(data, `${year}-01-01`) ?? data[0]?.date ?? rowsInYear[0].date;

    series.forEach((s, i) => {
      const m = periodReturn(data, s.id, periodStart, periodEnd);
      if (m) tables[i].periods.set(year, { ...m, period: year });
    });
  }

  return { years, tables };
}

export function buildMonthlyPeriodTables(
  data: MultiSeriesChartPoint[],
  series: ChartSeriesDef[],
): { months: string[]; tables: SeriesPeriodTable[] } {
  if (data.length < 2) return { months: [], tables: [] };

  const months = [...new Set(data.map((r) => r.date.slice(0, 7)))].sort();
  const tables: SeriesPeriodTable[] = series.map((s) => ({
    seriesId: s.id,
    label: s.label,
    color: s.color,
    periods: new Map(),
  }));

  for (const month of months) {
    const rowsInMonth = data.filter((r) => r.date.startsWith(month));
    if (!rowsInMonth.length) continue;
    const periodEnd = rowsInMonth[rowsInMonth.length - 1].date;
    const periodStart = lastDateBefore(data, `${month}-01`) ?? data[0]?.date ?? rowsInMonth[0].date;

    series.forEach((s, i) => {
      const m = periodReturn(data, s.id, periodStart, periodEnd);
      if (m) tables[i].periods.set(month, { ...m, period: month });
    });
  }

  return { months, tables };
}

export function buildYearlyReturnsChartData(
  data: MultiSeriesChartPoint[],
  series: ChartSeriesDef[],
): { year: string; [key: string]: string | number }[] {
  const { years, tables } = buildYearlyPeriodTables(data, series);
  return years.map((year) => {
    const row: { year: string; [key: string]: string | number } = { year };
    for (const t of tables) {
      const m = t.periods.get(year);
      row[t.seriesId] = m?.returnPct ?? 0;
    }
    return row;
  });
}

export function heatColor(returnPct: number): string {
  if (returnPct >= 15) return 'rgba(45, 212, 168, 0.55)';
  if (returnPct >= 5) return 'rgba(45, 212, 168, 0.35)';
  if (returnPct > 0) return 'rgba(45, 212, 168, 0.18)';
  if (returnPct <= -15) return 'rgba(255, 107, 122, 0.55)';
  if (returnPct <= -5) return 'rgba(255, 107, 122, 0.35)';
  if (returnPct < 0) return 'rgba(255, 107, 122, 0.18)';
  return 'rgba(255, 255, 255, 0.04)';
}

export function fmtMultiple(m: number): string {
  return `×${m.toFixed(2)}`;
}
