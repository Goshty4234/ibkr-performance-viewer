import type { CashFlow, DailyEvent, DailyTwrPoint, DbStatement } from './types';

export function dbToStatement(row: Record<string, unknown>): DbStatement {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    portfolioAccountId: (row.portfolio_account_id as string | null) ?? null,
    accountId: row.account_id as string,
    accountAlias: (row.account_alias as string) ?? '',
    baseCurrency: row.base_currency as string,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    startingNav: Number(row.starting_nav),
    endingNav: Number(row.ending_nav),
    twrr: Number(row.twrr),
    filename: row.filename as string,
    cashFlows: (row.cash_flows as CashFlow[]) ?? [],
    dailyEvents: (row.daily_events as DailyEvent[]) ?? [],
    twrDaily: (row.twr_daily as DailyTwrPoint[]) ?? [],
    imported_at: row.imported_at as string,
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
