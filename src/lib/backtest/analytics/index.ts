import type { ResultSummary } from '@/lib/engine/types';
import { buildResultSeries, prepareCharts, type PreparedCharts } from '../chart-data';
import { focusedAnalysis, type FocusedRow } from './focused';
import { monthlyHeatmap, variationSummary, type Heatmap, type VariationRow } from './overview';
import { periodTable, robustStats, type PeriodKind, type PeriodTable, type RobustRow } from './periods';
import { decodeBenchReturns, decodePortfolios, type PfSeries } from './series';

export * from './focused';
export * from './overview';
export * from './periods';
export * from './series';

/** Decoded result kept by the worker (or the main-thread fallback). */
export class ResultAnalytics {
  readonly pfs: PfSeries[];
  private bench = new Map<string, Map<number, number> | null>();
  private memo = new Map<string, unknown>();

  constructor(readonly summary: ResultSummary) {
    this.pfs = decodePortfolios(summary);
  }

  benchReturns(ticker: string): Map<number, number> | null {
    if (!this.bench.has(ticker)) this.bench.set(ticker, decodeBenchReturns(this.summary, ticker));
    return this.bench.get(ticker) ?? null;
  }

  /** Streamlit uses the first configured portfolio's benchmark for the robust tables. */
  firstBenchmark(): string {
    const first = this.summary.portfolios[0];
    return (first?.config?.benchmark_ticker as string | undefined) || '^GSPC';
  }

  private cached<T>(key: string, fn: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, fn());
    return this.memo.get(key) as T;
  }

  periods(kind: PeriodKind): PeriodsResult {
    return this.cached(`periods:${kind}`, () => {
      const table = periodTable(this.pfs, kind);
      return { table, robust: robustStats(table, this.pfs, this.benchReturns(this.firstBenchmark())) };
    });
  }

  overview(): OverviewResult {
    return this.cached('overview', () => ({ variation: variationSummary(this.pfs), heatmap: monthlyHeatmap(this.pfs) }));
  }

  focused(start: string, end: string): FocusedRow[] {
    return focusedAnalysis(this.pfs, (t) => this.benchReturns(t), start, end);
  }

  charts(mode: 'no_additions' | 'with_additions', benchmarks: string[], maxPoints?: number): ChartsResult {
    return this.cached(`charts:${mode}:${benchmarks.join(',')}:${maxPoints ?? ''}`, () => {
      const { dates, series } = buildResultSeries(this.summary, mode, benchmarks);
      return { dates, charts: prepareCharts(dates, series, maxPoints) };
    });
  }
}

export interface PeriodsResult {
  table: PeriodTable;
  robust: RobustRow[];
}

export interface OverviewResult {
  variation: VariationRow[];
  heatmap: Heatmap;
}

export interface ChartsResult {
  dates: string[];
  charts: PreparedCharts;
}
