import type { CashFlow, DailyNavPoint, DbNavSeries } from './types';

/** Accepts snake_case (Supabase row) or camelCase (already mapped API JSON). */
export function dbToNavSeries(row: Record<string, unknown>): DbNavSeries {
  const points = (row.points as DailyNavPoint[]) ?? [];
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
    filename: row.filename as string,
    points,
    cashFlows: (row.cash_flows ?? row.cashFlows ?? []) as CashFlow[],
    imported_at: (row.imported_at ?? row.importedAt) as string,
  };
}

export function mergeNavPoints(
  existing: DailyNavPoint[],
  incoming: DailyNavPoint[],
): DailyNavPoint[] {
  const map = new Map<string, DailyNavPoint>();
  for (const p of existing) map.set(p.date, p);
  for (const p of incoming) map.set(p.date, p);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
