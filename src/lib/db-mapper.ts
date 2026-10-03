import type { CashFlow, DailyEvent, DailyTwrPoint, DbStatement } from './types';

/**
 * Accepts a database row (snake_case) or a statement already shaped for the client (camelCase, as the
 * /api/statements route returns it): mapping the latter twice used to leave every field undefined.
 */
export function dbToStatement(row: Record<string, unknown>): DbStatement {
  return {
    id: row.id as string,
    user_id: (row.user_id ?? row.userId) as string,
    portfolioAccountId: ((row.portfolio_account_id ?? row.portfolioAccountId) as string | null) ?? null,
    accountId: ((row.account_id ?? row.accountId) as string) ?? '',
    accountAlias: ((row.account_alias ?? row.accountAlias) as string) ?? '',
    baseCurrency: ((row.base_currency ?? row.baseCurrency) as string) ?? 'CAD',
    periodStart: (row.period_start ?? row.periodStart) as string,
    periodEnd: (row.period_end ?? row.periodEnd) as string,
    startingNav: Number(row.starting_nav ?? row.startingNav ?? 0),
    endingNav: Number(row.ending_nav ?? row.endingNav ?? 0),
    twrr: Number(row.twrr ?? 0),
    filename: row.filename as string,
    cashFlows: ((row.cash_flows ?? row.cashFlows) as CashFlow[]) ?? [],
    dailyEvents: ((row.daily_events ?? row.dailyEvents) as DailyEvent[]) ?? [],
    twrDaily: ((row.twr_daily ?? row.twrDaily) as DailyTwrPoint[]) ?? [],
    imported_at: (row.imported_at ?? row.importedAt) as string,
  };
}

export function statementToDb(stmt: Omit<DbStatement, 'id' | 'user_id' | 'imported_at'>, userId: string) {
  return {
    user_id: userId,
    account_id: stmt.accountId,
    account_alias: stmt.accountAlias,
    base_currency: stmt.baseCurrency,
    period_start: stmt.periodStart,
    period_end: stmt.periodEnd,
    starting_nav: stmt.startingNav,
    ending_nav: stmt.endingNav,
    twrr: stmt.twrr,
    filename: stmt.filename,
    cash_flows: stmt.cashFlows,
    daily_events: stmt.dailyEvents ?? [],
    twr_daily: stmt.twrDaily ?? [],
  };
}
