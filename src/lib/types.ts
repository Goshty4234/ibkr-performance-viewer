export interface CashFlow {
  date: string;
  amount: number;
  description: string;
  isExternal: boolean;
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
}

export interface DbStatement extends ParsedStatement {
  id: string;
  user_id: string;
  imported_at: string;
}

export interface PerformancePoint {
  date: string;
  portfolio: number;
  benchmark: number;
}

export interface PerformanceSummary {
  portfolioReturn: number;
  benchmarkReturn: number;
  alpha: number;
  cagr: number;
  benchmarkCagr: number;
  days: number;
}

export type BenchmarkSymbol = 'SPY' | 'QQQ' | 'XIU';

export const BENCHMARK_LABELS: Record<BenchmarkSymbol, string> = {
  SPY: 'S&P 500 (SPY)',
  QQQ: 'Nasdaq 100 (QQQ)',
  XIU: 'S&P/TSX 60 (XIU)',
};
