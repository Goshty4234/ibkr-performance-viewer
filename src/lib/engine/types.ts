/** Types shared with the Python engine (engine/backtest_engine/results.py, format 2). */

export interface EngineHealth {
  status: 'ok';
  engine: 'momentum-backtest';
  version: string;
  /** Site/engine contract number (absent before the first portable release): see ENGINE_API. */
  api?: number;
  /** Hash of the engine code + static series: two runs from the same code and data are identical. */
  code?: string;
  /** Self-updating portable package (update below), as opposed to a dev or cloud engine. */
  portable?: boolean;
  update?: EngineUpdateStatus;
  mode: 'local' | 'cloud';
  auth_required: boolean;
  cpu_count: number | null;
  uptime_s: number;
  running: number;
  queued: number;
  max_jobs: number;
  workers?: number;
  workers_busy?: number;
  max_workers?: number;
  tasks_queued?: number;
}

export interface EngineUpdateStatus {
  state: 'idle' | 'disabled' | 'checking' | 'current' | 'downloading' | 'verifying' | 'ready' | 'error';
  current: string;
  latest?: string;
  latest_api?: number | null;
  /** code: a few MB; runtime: the whole package (Python or a library changed). */
  kind?: 'code' | 'runtime';
  progress?: number;
  error?: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type JobPhase = 'queued' | 'prepare' | 'portfolios' | 'assemble' | 'finished';

export interface JobSummary {
  format?: number;
  duration_s: number;
  portfolios: number;
  count?: number;
  failed: string[];
  warnings: string[];
  simulation: SimulationInfo;
  size_bytes: number;
  summary_bytes?: number;
  reused?: number;
}

export interface EngineJob {
  id: string;
  label: string;
  status: JobStatus;
  phase?: JobPhase;
  progress: number;
  message: string;
  error: string | null;
  summary: JobSummary | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  queue_position: number | null;
  portfolio_count: number;
  tasks_total?: number;
  tasks_done?: number;
  tasks_running?: number;
  /** Portfolios whose identical inputs were already computed: output reused, no backtest. */
  tasks_reused?: number;
  /** Where the prices came from (ticker store report), once the data step is done. */
  prices?: import('./client').StoreReport | null;
}

/** Series on the run-wide `dates` axis (offset) or with explicit dates. */
export interface SeriesRef {
  offset?: number;
  dates?: string[];
  values: (number | null)[];
}

export interface PortfolioSummaryOk {
  index: number;
  name: string;
  fusion: boolean;
  ok: true;
  config: PortfolioConfig;
  /** Identity of this result apart from its end date (engine history_key). */
  history_key?: string | null;
  series: {
    offset?: number;
    dates?: string[];
    with_additions: (number | null)[];
    /** null: identical to with_additions */
    no_additions: (number | null)[] | null;
  };
  stats: Record<string, number | null>;
  stats_display: Record<string, string>;
  today_weights: Record<string, number>;
  current_alloc: Record<string, number> | null;
  last_rebalance_date: string | null;
  /** "Rebalance as of Today" (Streamlit method: latest momentum metrics or config weights). */
  today?: TodayBlock | null;
  timer?: TimerInfo | null;
  analytics_errors?: string[];
  [key: string]: unknown;
}

export interface AllocationRow {
  ticker: string;
  alloc_pct: number;
  price: number | null;
  shares: number;
  value: number;
  pct: number;
}

export interface AllocationTable {
  rows: AllocationRow[];
  total: { alloc_pct: number; value: number; pct: number };
  cash_shown: boolean;
}

/** [label, percent] sorted by weight, positive only. */
export type PieSlices = [string, number][];

export interface TodayBlock {
  weights: Record<string, number>;
  pie: PieSlices;
  portfolio_value: number;
  table: AllocationTable | null;
  prices: Record<string, number | null>;
}

export type TimerFrequency = 'market_day' | 'calendar_day' | 'week' | '2weeks' | 'month' | '3months' | '6months' | 'year' | 'none';

export interface TimerInfo {
  last_rebalance: string;
  /** Legacy frequency code; any other string means no schedule. */
  frequency: TimerFrequency | string;
}

export interface MarketData {
  start?: string;
  end?: string;
  vix?: SeriesRef;
  vix_first?: string;
  rf_annual_pct?: SeriesRef;
  rf_symbol?: string;
  error?: string;
}

export interface RebalanceCompare {
  last_date: string;
  final_date: string;
  last_pie: PieSlices;
  current_pie: PieSlices;
  last_table: AllocationTable | null;
  current_table: AllocationTable | null;
}

export interface HoldingsTable {
  frequency: string;
  dates: string[];
  tickers: string[];
  shares: (number | null)[][];
  values: (number | null)[][];
}

export interface StreamlitGains {
  periods: string[];
  realized: (number | null)[][];
  unrealized: (number | null)[][];
  realized_total: (number | null)[];
  unrealized_total: (number | null)[];
  annual: { period: string; realized: number; unrealized: number; total: number; taxable_pct: number }[];
}

export type TradeKind = 'buy' | 'sell' | 'drip';

export interface AcbTransactions {
  dates: string[];
  tickers: string[];
  date_idx: number[];
  ticker_idx: number[];
  kind: TradeKind[];
  qty: number[];
  price: number[];
  amount: number[];
  gain: (number | null)[];
  shares_after: number[];
  acb_per_share: number[];
  total: number;
  truncated: boolean;
}

export interface AcbYear {
  year: number;
  proceeds: number;
  cost_base: number;
  realized: number;
  dividends: number;
  contributions: number;
  buys: number;
  sells: number;
  trades: number;
  market_value_end: number;
  acb_end: number;
  unrealized_end: number;
}

export interface AcbPosition {
  ticker: string;
  shares: number;
  acb: number;
  acb_per_share: number;
  price: number | null;
  market_value: number | null;
  unrealized: number | null;
}

export interface AcbTax {
  transactions: AcbTransactions | null;
  years: AcbYear[];
  by_ticker?: { years: number[]; tickers: string[]; realized: (number | null)[][]; dividends: (number | null)[][] };
  positions: AcbPosition[];
  dividends_reinvested?: boolean;
}

export interface PortfolioSummaryFailed {
  index: number;
  name: string;
  fusion?: boolean;
  ok: false;
  error: string;
  config?: PortfolioConfig;
}

export type PortfolioSummary = PortfolioSummaryOk | PortfolioSummaryFailed;

export interface ResultSummary {
  format: 2;
  engine_version: string;
  options: RunOptions;
  duration_s: number;
  simulation: SimulationInfo;
  dates: string[];
  invalid_tickers: string[];
  warnings: string[];
  portfolios: PortfolioSummary[];
  benchmarks: Record<string, SeriesRef>;
  market: MarketData;
  [key: string]: unknown;
}

export interface MetricsColumns {
  dates: string[];
  tickers: string[];
  fields: string[];
  date_idx: number[];
  ticker_idx: number[];
  values: Record<string, (number | string | null)[]>;
  truncated: boolean;
}

export interface PortfolioDetail {
  format: 2;
  index: number;
  name: string;
  error?: string | null;
  allocations?: { dates: string[]; weights: Record<string, (number | null)[]> };
  metrics?: MetricsColumns;
  rebalance_compare?: RebalanceCompare | null;
  tax_acb?: AcbTax | null;
  holdings?: HoldingsTable;
  gains?: StreamlitGains;
  analytics_errors?: Record<string, string>;
  [key: string]: unknown;
}

/** Single-file result (CLI, GitHub Actions, engine /result). */
export interface ResultBundle {
  format: 2;
  summary: ResultSummary;
  details: (PortfolioDetail | null)[];
}

export interface SimulationInfo {
  start: string | null;
  end: string | null;
  display_start: string | null;
}

export interface RunOptions {
  start_with: 'all' | 'oldest';
  first_rebalance_strategy: 'rebalancing_date' | 'momentum_window_complete';
  auto_adjust_momentum_start: boolean;
  start_date: string | null;
  end_date: string | null;
  /** Common start of an earlier run, so portfolios computed to complete it share its axis. */
  align_start?: string | null;
  /** Ticker store mode for this launch (engine default: topup). Never part of a result's identity. */
  price_update?: 'stored' | 'topup' | 'full';
}

/** POST /plan: what a launch would simulate. */
export interface RunPlan {
  simulation: { start: string | null; end: string | null; display_start: string | null };
  /** history_key: identity of the portfolio's result apart from its end date. */
  portfolios: { name: string; history_key: string | null }[];
}

export type StatKey =
  | 'Total Return'
  | 'Total Return (Contributed)'
  | 'CAGR'
  | 'MaxDrawdown'
  | 'Volatility'
  | 'Sharpe'
  | 'Sortino'
  | 'UlcerIndex'
  | 'UPI'
  | 'Beta'
  | 'MWRR';

/** Format 1 (single JSON, before chunking): still readable from history and files. */
export interface PortfolioResultOk {
  index: number;
  name: string;
  ok: true;
  config: PortfolioConfig;
  series: { dates: string[]; with_additions: (number | null)[]; no_additions: (number | null)[] };
  stats: Record<string, number | null>;
  stats_display: Record<string, string>;
  today_weights: Record<string, number>;
  current_alloc: Record<string, number> | null;
  allocations: { dates: string[]; weights: Record<string, (number | null)[]> };
  metrics_history: Record<string, Record<string, Record<string, unknown>>>;
  metrics_truncated: boolean;
  last_rebalance_date: string | null;
}

export interface PortfolioResultFailed {
  index: number;
  name: string;
  ok: false;
  error: string;
}

export type PortfolioResult = PortfolioResultOk | PortfolioResultFailed;

export interface LegacyPayload {
  engine_version: string;
  options: RunOptions;
  duration_s: number;
  simulation: SimulationInfo;
  invalid_tickers: string[];
  warnings: string[];
  portfolios: PortfolioResult[];
  benchmarks: Record<string, { dates: string[]; values: (number | null)[] }>;
}

/** One holding of the Allocations fundamentals table (engine/backtest_engine/allocations_api.py).
 *  Ratios are raw numbers, percents are already x100, `_b` fields in billions, `_m` in millions. */
export interface FundamentalsRow {
  ticker: string;
  name: string;
  quote_type?: string | null;
  sector?: string;
  industry?: string;
  price?: number | null;
  alloc_pct: number;
  shares: number;
  value: number;
  pct_of_portfolio: number;
  peg_source?: string;
  analyst_rating?: string;
  interest_coverage_unbounded?: boolean;
  [field: string]: string | number | boolean | null | undefined;
}

export interface FundamentalsReport {
  as_of: string;
  portfolio_value: number;
  rows: FundamentalsRow[];
  /** Streamlit weighted_average per field (weights = % of portfolio, with sanity filters). */
  weighted: Record<string, number | null>;
  sectors: [string, number][];
  industries: [string, number][];
}

export interface BenchmarkRow {
  ticker: string;
  pe: number | null;
  volatility: number | null;
  beta: number | null;
  '1W': number | null;
  '1M': number | null;
  '3M': number | null;
  '6M': number | null;
  '1Y': number | null;
}

/** Returns Summary row (2_Allocations.py): percents, beta raw; `portfolio` marks PORTFOLIO HISTORICAL. */
export interface ReturnsRow {
  ticker: string;
  weight: number;
  momentum: number | null;
  beta: number | null;
  volatility: number | null;
  '1W': number | null;
  '1M': number | null;
  '3M': number | null;
  '6M': number | null;
  '1Y': number | null;
  portfolio?: boolean;
}

export interface StockConfig {
  ticker: string;
  allocation: number;
  include_dividends: boolean;
  include_in_sma_filter?: boolean;
  /** Individual cap (%) used by momentum weighting; null/0 = none. */
  max_allocation_percent?: number | null;
  /** Ticker whose MA drives this stock's MA filter; empty = own MA. */
  ma_reference_ticker?: string;
}

export interface TargetedSetting {
  enabled: boolean;
  min_allocation: number;
  max_allocation: number;
}

export interface MomentumWindow {
  lookback: number;
  exclude: number;
  weight: number;
  discard_if_negative?: boolean;
  discard_unless_recent_positive?: boolean;
}

/** Streamlit Multi-Backtest portfolio (export JSON format). Unknown keys are preserved. */
export interface PortfolioConfig {
  name: string;
  stocks: StockConfig[];
  benchmark_ticker: string;
  initial_value: number;
  added_amount: number;
  added_frequency: string;
  rebalancing_frequency: string;
  use_momentum: boolean;
  momentum_strategy?: string;
  negative_momentum_strategy?: string;
  momentum_windows?: MomentumWindow[];
  use_window_capped_score?: boolean;
  calc_beta?: boolean;
  beta_window_days?: number;
  exclude_days_beta?: number;
  calc_volatility?: boolean;
  vol_window_days?: number;
  exclude_days_vol?: number;
  use_minimal_threshold?: boolean;
  minimal_threshold_percent?: number;
  use_max_allocation?: boolean;
  max_allocation_percent?: number;
  use_sma_filter?: boolean;
  sma_window?: number;
  ma_type?: string;
  ma_cross_rebalance?: boolean;
  ma_tolerance_percent?: number;
  ma_confirmation_days?: number;
  use_global_ma_reference?: boolean;
  global_ma_reference_ticker?: string;
  collect_dividends_as_cash?: boolean;
  idle_cash_earns_treasury_yield?: boolean;
  ma_multiplier?: number;
  use_targeted_rebalancing?: boolean;
  targeted_rebalancing_settings?: Record<string, TargetedSetting>;
  exclude_from_cashflow_sync?: boolean;
  exclude_from_rebalancing_sync?: boolean;
  fusion_portfolio?: { enabled: boolean; selected_portfolios: string[]; allocations: Record<string, number> };
  [key: string]: unknown;
}
