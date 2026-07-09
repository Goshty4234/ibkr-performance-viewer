export interface PortfolioAccount {
  id: string;
  user_id: string;
  ibkrAccountId: string;
  displayName: string;
  notes: string;
  /** Date plancher pour l'analyse — l'historique avant est ignoré */
  analysisStartLock?: string | null;
  created_at: string;
  updated_at: string;
  statementCount?: number;
}

export interface CashFlow {
  date: string;
  amount: number;
  description: string;
  isExternal: boolean;
}

export interface DailyEvent {
  date: string;
  amount: number;
  category: 'trade' | 'dividend' | 'interest' | 'fee' | 'tax' | 'corporate' | 'other';
}

export interface DailyTwrPoint {
  date: string;
  returnPct: number;
}

export interface ParsedStatement {
  accountId: string;
  accountAlias: string;
  baseCurrency: string;
  periodStart: string;
  periodEnd: string;
  startingNav: number;
  endingNav: number;
  twrr: number;
  filename: string;
  cashFlows: CashFlow[];
  dailyEvents: DailyEvent[];
  /** IBKR performance report — official daily TWR % */
  twrDaily?: DailyTwrPoint[];
}

export interface DbStatement extends ParsedStatement {
  id: string;
  user_id: string;
  portfolioAccountId: string | null;
  imported_at: string;
}

export interface PerformancePoint {
  date: string;
  portfolio: number;
  benchmark: number;
  isGap?: boolean;
}

export interface PerformanceSummary {
  portfolioReturn: number;
  benchmarkReturn: number;
  alpha: number;
  cagr: number;
  benchmarkCagr: number;
  maxDrawdown: number;
  days: number;
}

export interface DrawdownPoint {
  date: string;
  drawdown: number;
}

export type BenchmarkSymbol = 'SPY' | 'QQQ' | 'XIU';

export const BENCHMARK_LABELS: Record<BenchmarkSymbol, string> = {
  SPY: 'S&P 500 (SPY)',
  QQQ: 'Nasdaq 100 (QQQ)',
  XIU: 'S&P/TSX 60 (XIU)',
};

export type DatePreset = '1W' | '1M' | 'MTD' | '3M' | '6M' | '1Y' | 'YTD' | 'MAX';

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  '1W': '1 sem.',
  '1M': '1 mois',
  MTD: 'MTD',
  '3M': '3 mois',
  '6M': '6 mois',
  '1Y': '1 an',
  YTD: 'YTD',
  MAX: 'Depuis le début',
};

export interface TimelineGap {
  from: string;
  to: string;
  days: number;
}

export interface TimelineHealth {
  dataStart: string | null;
  dataEnd: string | null;
  gaps: TimelineGap[];
  daysSinceLastData: number | null;
  isStale: boolean;
  rangeCoverage: {
    requestedStart: string;
    requestedEnd: string;
    availableStart: string | null;
    availableEnd: string | null;
    missingBefore: boolean;
    missingAfter: boolean;
    hasAnyData: boolean;
    message: string | null;
  } | null;
}

export interface ImportResult {
  imported: boolean;
  replaced: number;
  action: 'created' | 'updated' | 'replaced_overlap';
}

export interface DailyNavPoint {
  date: string;
  total: number;
  cash?: number;
  stock?: number;
  options?: number;
}

export interface ParsedNavSeries {
  accountId: string;
  accountAlias: string;
  baseCurrency: string;
  periodStart: string;
  periodEnd: string;
  filename: string;
  points: DailyNavPoint[];
}

export interface DbNavSeries extends ParsedNavSeries {
  id: string;
  user_id: string;
  portfolioAccountId: string;
  imported_at: string;
  cashFlows?: CashFlow[];
}

export interface DbTwrSeries {
  id: string;
  user_id: string;
  portfolioAccountId: string;
  accountId: string;
  accountAlias: string;
  baseCurrency: string;
  periodStart: string;
  periodEnd: string;
  twrr: number;
  filename: string;
  points: DailyTwrPoint[];
  imported_at: string;
}
