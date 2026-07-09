import type { DailyTwrPoint, DbTwrSeries } from './types';

export function dbToTwrSeries(row: Record<string, unknown>): DbTwrSeries {
  const points = (row.points as DailyTwrPoint[]) ?? [];
  const periodStart = (row.period_start ?? row.periodStart ?? points[0]?.date ?? '') as string;
  const periodEnd = (
    row.period_end ?? row.periodEnd ?? points[points.length - 1]?.date ?? ''
  ) as string;

  return {
    id: row.id as string,
    user_id: (row.user_id ?? row.userId) as string,
    portfolioAccountId: (row.portfolio_account_id ?? row.portfolioAccountId) as string,
    accountId: (row.account_id ?? row.accountId) as string,
    accountAlias: ((row.account_alias ?? row.accountAlias) as string) ?? '',
    baseCurrency: ((row.base_currency ?? row.baseCurrency) as string) ?? 'CAD',
    periodStart,
    periodEnd,
    twrr: Number(row.twrr ?? 0),
    filename: row.filename as string,
    points,
    imported_at: (row.imported_at ?? row.importedAt) as string,
  };
}

export function mergeTwrPoints(
  existing: DailyTwrPoint[],
  incoming: DailyTwrPoint[],
): DailyTwrPoint[] {
  const map = new Map<string, DailyTwrPoint>();
  for (const p of existing) map.set(p.date, p);
  for (const p of incoming) map.set(p.date, p);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function getTwrTimelineBounds(points: DailyTwrPoint[]): { min: string; max: string } | null {
  if (!points.length) return null;
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  return { min: sorted[0].date, max: sorted[sorted.length - 1].date };
}
