import type { PortfolioConfig, RunOptions } from '@/lib/engine/types';

/**
 * Allocations only needs today's target, the current drift and the last year of returns.
 * Every rebalance recomputes the weights from the price windows alone, so once one rebalance
 * has happened with complete windows the simulated path is the same as with 30 years of history.
 * Start early enough for that to hold one year back, plus a safety margin.
 *
 * Checked against full runs (identical target, held weights, timer and daily returns over the
 * last year): momentum, SMA filter, EMA filter (5 windows of warm-up), MA-cross rebalancing,
 * weekly/biweekly/monthly/quarterly. Today's target was also identical for the configurations
 * below, but their held weights and recent returns depend on where the simulation started
 * (Never / Buy & Hold drift from day one, threshold rebalancing, fusion, SP500TOP20), so they
 * keep the full history — they are cheap to simulate anyway.
 */

const PERIOD_DAYS: Record<string, number> = { Weekly: 7, Biweekly: 14, Monthly: 31, Quarterly: 92, Semiannually: 183, Annually: 366 };
const DAY_MS = 86_400_000;
const RETURNS_DAYS = 365;
const MARGIN_DAYS = 31;
/** An EMA keeps (1 - 2/(n+1))^k of its seed after k days: 5 windows leave < 0.01 %. */
const EMA_WARMUP_WINDOWS = 5;
// Mirrors the engine's is_special_dynamic_ticker list (ZROX is listed there but has no data).
const DYNAMIC_TICKERS = new Set(['SP500TOP20', 'ZROX']);

export interface AllocationWindow {
  /** First simulated day, or null for the full history. */
  start: string | null;
  days: number | null;
  /** Why the full history is needed (null with a short window). */
  reason: string | null;
}

const isFusion = (p: PortfolioConfig) => Boolean(p.fusion_portfolio?.enabled);

/** Days after which the portfolio's path no longer depends on where the simulation started. */
function settleDays(p: PortfolioConfig): number | string {
  if (isFusion(p)) return 'Fusion : sa courbe sans ajouts dépend de tout l’historique';
  const period = PERIOD_DAYS[p.rebalancing_frequency];
  if (!period) return `rebalancement « ${p.rebalancing_frequency} » (l’état dérive depuis le début)`;
  if (p.use_targeted_rebalancing) return 'rebalancement ciblé par seuils : les poids détenus dépendent de tout le parcours';
  if (p.stocks.some((s) => DYNAMIC_TICKERS.has(s.ticker.toUpperCase()))) return 'SP500TOP20 : sa composition interne dépend de tout le parcours';
  let window = 0;
  if (p.use_momentum) for (const w of p.momentum_windows ?? []) window = Math.max(window, Number(w.lookback) || 0);
  if (p.calc_beta) window = Math.max(window, p.beta_window_days ?? 365);
  if (p.calc_volatility) window = Math.max(window, p.vol_window_days ?? 365);
  if (p.use_sma_filter || p.ma_cross_rebalance) {
    const ma = Math.ceil((p.sma_window ?? 200) * (p.ma_multiplier ?? 1.48));
    window = Math.max(window, (p.ma_type ?? 'SMA') === 'EMA' ? ma * EMA_WARMUP_WINDOWS : ma);
  }
  return window + period;
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function allocationWindow(configs: PortfolioConfig[], today = new Date()): AllocationWindow {
  let settle = 0;
  for (const p of configs) {
    const s = settleDays(p);
    if (typeof s === 'string') return { start: null, days: null, reason: configs.length > 1 ? `${p.name} — ${s}` : s };
    settle = Math.max(settle, s);
  }
  const days = RETURNS_DAYS + settle + MARGIN_DAYS;
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  return { start: isoDay(start), days, reason: null };
}

/**
 * Biweekly dates run every 14 days from the first Monday of the simulation (calendar axis, so
 * holidays do not matter): a short window must start on a Monday of that same cycle.
 */
export function needsCycleAnchor(configs: PortfolioConfig[]): boolean {
  return configs.some((p) => p.rebalancing_frequency === 'Biweekly' || p.added_frequency === 'Biweekly');
}

/** Latest Monday of the full run's 2-week cycle on or before `start`; null if there is none. */
export function alignToCycle(start: string, fullStart: string): string | null {
  const s0 = Date.parse(`${fullStart.slice(0, 10)}T00:00:00Z`);
  const firstMonday = s0 + ((8 - new Date(s0).getUTCDay()) % 7) * DAY_MS;
  const steps = Math.floor((Date.parse(`${start.slice(0, 10)}T00:00:00Z`) - firstMonday) / (14 * DAY_MS));
  return steps > 0 ? new Date(firstMonday + steps * 14 * DAY_MS).toISOString().slice(0, 10) : null;
}

/** Allocations settings (Streamlit's page defaults), independent of the builder's options. */
export function allocationOptions(window: AllocationWindow): RunOptions {
  return {
    start_with: 'oldest',
    first_rebalance_strategy: 'momentum_window_complete',
    auto_adjust_momentum_start: false,
    start_date: window.start,
    end_date: null,
  };
}
