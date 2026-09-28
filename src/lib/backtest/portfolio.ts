import type { MomentumWindow, PortfolioConfig, RunOptions, StockConfig } from '@/lib/engine/types';

export const FREQUENCIES = [
  'Never',
  'Buy & Hold',
  'Buy & Hold (Target)',
  'Weekly',
  'Biweekly',
  'Monthly',
  'Quarterly',
  'Semiannually',
  'Annually',
] as const;

export const FREQUENCY_LABELS: Record<string, string> = {
  Never: 'Jamais',
  'Buy & Hold': 'Buy & Hold',
  'Buy & Hold (Target)': 'Buy & Hold (cible)',
  Weekly: 'Hebdomadaire',
  Biweekly: 'Aux 2 semaines',
  Monthly: 'Mensuel',
  Quarterly: 'Trimestriel',
  Semiannually: 'Semestriel',
  Annually: 'Annuel',
};

const FREQ_MAP: Record<string, string> = {
  none: 'Never', week: 'Weekly', '2weeks': 'Biweekly', month: 'Monthly',
  '3months': 'Quarterly', '6months': 'Semiannually', year: 'Annually',
};

export const MOMENTUM_STRATEGIES = ['Classic', 'Relative Momentum', 'Near-Zero Symmetry'] as const;
export const NEGATIVE_STRATEGIES = ['Cash', 'Equal weight', 'Relative momentum', 'Near-Zero Symmetry'] as const;

export const DEFAULT_OPTIONS: RunOptions = {
  start_with: 'all',
  first_rebalance_strategy: 'momentum_window_complete',
  auto_adjust_momentum_start: false,
  start_date: null,
  end_date: null,
};

export type EditablePortfolio = PortfolioConfig & { _id: string };

let seq = 0;
export function newId(): string {
  seq += 1;
  return `p${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function mapFrequency(f: unknown): string {
  if (f == null) return 'Never';
  const s = String(f);
  if ((FREQUENCIES as readonly string[]).includes(s)) return s;
  return FREQ_MAP[s] ?? 'Monthly';
}

export function defaultPortfolio(name = 'Nouveau portfolio'): EditablePortfolio {
  return {
    _id: newId(),
    name,
    stocks: [
      { ticker: 'SPY', allocation: 0.6, include_dividends: true, include_in_sma_filter: true },
      { ticker: 'TLT', allocation: 0.4, include_dividends: true, include_in_sma_filter: true },
    ],
    benchmark_ticker: '^GSPC',
    initial_value: 10000,
    added_amount: 1000,
    added_frequency: 'Monthly',
    rebalancing_frequency: 'Quarterly',
    use_momentum: false,
    momentum_strategy: 'Classic',
    negative_momentum_strategy: 'Cash',
    momentum_windows: [
      { lookback: 365, exclude: 30, weight: 0.5 },
      { lookback: 180, exclude: 30, weight: 0.3 },
      { lookback: 120, exclude: 30, weight: 0.2 },
    ],
    calc_beta: false,
    beta_window_days: 365,
    exclude_days_beta: 30,
    calc_volatility: false,
    vol_window_days: 365,
    exclude_days_vol: 30,
    use_minimal_threshold: false,
    minimal_threshold_percent: 4,
    use_max_allocation: false,
    max_allocation_percent: 20,
    use_sma_filter: false,
    sma_window: 200,
    ma_type: 'SMA',
    ma_multiplier: 1.48,
    ma_cross_rebalance: false,
    ma_tolerance_percent: 2,
    ma_confirmation_days: 3,
    use_global_ma_reference: false,
    global_ma_reference_ticker: '',
    collect_dividends_as_cash: false,
    idle_cash_earns_treasury_yield: false,
    fusion_portfolio: { enabled: false, selected_portfolios: [], allocations: {} },
  };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Light client-side version of engine/backtest_engine/config.py so the editor shows the same values. */
export function normalizeImported(raw: Record<string, unknown>): EditablePortfolio {
  const base = defaultPortfolio(String(raw.name ?? 'Portfolio'));
  let stocks: StockConfig[] = [];
  if (Array.isArray(raw.stocks)) {
    stocks = (raw.stocks as Record<string, unknown>[])
      .filter((s) => s && String(s.ticker ?? '').trim())
      .map((s) => {
        const ticker = String(s.ticker).trim();
        const divs = s.include_dividends ?? s.include_divs;
        return {
          ...s,
          ticker,
          allocation: num(s.allocation, 0),
          include_dividends: divs === undefined || divs === null ? !ticker.includes('?L=-') : Boolean(divs),
          include_in_sma_filter: s.include_in_sma_filter === undefined ? true : Boolean(s.include_in_sma_filter),
        };
      });
  } else if (Array.isArray(raw.tickers)) {
    const allocs = (raw.allocs as unknown[]) ?? [];
    const divs = (raw.divs as unknown[]) ?? [];
    stocks = (raw.tickers as unknown[])
      .map((t, i) => {
        const a = num(allocs[i], 0);
        return {
          ticker: String(t ?? '').trim(),
          allocation: a > 1 ? a / 100 : a,
          include_dividends: divs[i] === undefined || divs[i] === null ? true : Boolean(divs[i]),
          include_in_sma_filter: true,
        };
      })
      .filter((s) => s.ticker);
  }
  const windows: MomentumWindow[] = Array.isArray(raw.momentum_windows)
    ? (raw.momentum_windows as Record<string, unknown>[]).map((w) => {
        let weight = num(w.weight, 0.1);
        weight = weight > 1 ? Math.min(weight, 100) / 100 : Math.max(0, Math.min(weight, 1));
        return { ...w, lookback: num(w.lookback, 365), exclude: num(w.exclude, 30), weight } as MomentumWindow;
      })
    : [];
  const fusion = raw.fusion_portfolio as PortfolioConfig['fusion_portfolio'] | undefined;
  return {
    ...base,
    ...(raw as Partial<PortfolioConfig>),
    _id: newId(),
    name: String(raw.name ?? 'Portfolio'),
    stocks,
    momentum_windows: windows,
    added_frequency: mapFrequency(raw.added_frequency ?? 'Monthly'),
    rebalancing_frequency: mapFrequency(raw.rebalancing_frequency ?? 'Monthly'),
    use_momentum: raw.use_momentum === undefined ? true : Boolean(raw.use_momentum),
    // Streamlit's JSON import defaults a missing calc_volatility to true (engine config.py too).
    calc_volatility: raw.calc_volatility === undefined ? true : Boolean(raw.calc_volatility),
    fusion_portfolio: fusion && typeof fusion === 'object'
      ? { enabled: Boolean(fusion.enabled), selected_portfolios: fusion.selected_portfolios ?? [], allocations: fusion.allocations ?? {} }
      : base.fusion_portfolio,
  };
}

export interface ImportResult {
  portfolios: EditablePortfolio[];
  options: Partial<RunOptions>;
}

export function parseImport(text: string): ImportResult {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/\bNaN\b/g, 'null').replace(/\bInfinity\b/g, 'null').replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  const parsed = JSON.parse(cleaned) as unknown;
  let list: unknown = parsed;
  let options: Partial<RunOptions> = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'portfolios' in parsed) {
    list = (parsed as { portfolios: unknown }).portfolios;
    options = ((parsed as { options?: Partial<RunOptions> }).options ?? {}) as Partial<RunOptions>;
  }
  if (list && typeof list === 'object' && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list) || !list.length) throw new Error('Le JSON doit contenir une liste de portfolios.');
  const first = list[0] as Record<string, unknown>;
  if (first.start_with !== undefined && options.start_with === undefined) {
    options.start_with = first.start_with === 'first' || first.start_with === 'oldest' ? 'oldest' : 'all';
  }
  if (first.first_rebalance_strategy !== undefined && options.first_rebalance_strategy === undefined) {
    const f = first.first_rebalance_strategy;
    options.first_rebalance_strategy = f === 'rebalancing_date' ? 'rebalancing_date' : 'momentum_window_complete';
  }
  if (first.auto_adjust_momentum_start !== undefined && options.auto_adjust_momentum_start === undefined) {
    options.auto_adjust_momentum_start = Boolean(first.auto_adjust_momentum_start);
  }
  const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  if (options.start_date === undefined && options.end_date === undefined) {
    const s = isoDate(first.start_date_user);
    const e = isoDate(first.end_date_user);
    if (s || e) {
      options.start_date = s;
      options.end_date = e;
    }
  }
  const portfolios = (list as Record<string, unknown>[]).map((p) => {
    if (!p || typeof p !== 'object' || !('name' in p)) throw new Error('Portfolio invalide (nom manquant).');
    return normalizeImported(p);
  });
  return { portfolios, options };
}

/** Portfolio as sent to the engine / exported (internal keys removed). */
export function toEngineConfig(p: EditablePortfolio): PortfolioConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!k.startsWith('_')) out[k] = v;
  // Streamlit only keeps targeted rebalancing when both momentum and the MA filter are off.
  if (out.use_targeted_rebalancing && (p.use_momentum || p.use_sma_filter)) out.use_targeted_rebalancing = false;
  return out as PortfolioConfig;
}

/** Streamlit pre-run checks (blocking): fusions, momentum weights, allocations; plus empty portfolios. */
export function validatePortfolios(portfolios: PortfolioConfig[]): string[] {
  const errors: string[] = [];
  const names = new Set(portfolios.map((p) => p.name));
  const seen = new Set<string>();
  for (const p of portfolios) {
    if (seen.has(p.name)) errors.push(`Deux portfolios s’appellent « ${p.name} » : les noms doivent être uniques.`);
    seen.add(p.name);
    if (isFusion(p)) {
      const f = p.fusion_portfolio!;
      if (!f.selected_portfolios.length) {
        errors.push(`Fusion « ${p.name} » : aucun portfolio sélectionné.`);
        continue;
      }
      for (const n of f.selected_portfolios) {
        if (!names.has(n)) errors.push(`Fusion « ${p.name} » : le portfolio « ${n} » n’existe pas.`);
      }
      const total = Object.values(f.allocations).reduce((s, v) => s + (Number(v) || 0), 0);
      if (Math.abs(total - 1) > 0.01) errors.push(`Fusion « ${p.name} » : total ${(total * 100).toFixed(2)} % (doit faire 100 %).`);
      continue;
    }
    const tickers = p.stocks.filter((s) => s.ticker.trim());
    if (!tickers.length) errors.push(`« ${p.name} » n’a aucun ticker.`);
    if (p.use_momentum) {
      const w = (p.momentum_windows ?? []).reduce((s, x) => s + (Number(x.weight) || 0), 0);
      if (Math.abs(w - 1) > 0.01) {
        errors.push(`« ${p.name} » : momentum actif mais le poids total des fenêtres est ${(w * 100).toFixed(2)} % (doit faire 100 %).`);
      }
    } else if (tickers.length) {
      const total = tickers.reduce((s, x) => s + (Number(x.allocation) || 0), 0);
      if (Math.abs(total - 1) > 0.01) {
        errors.push(`« ${p.name} » : sans momentum, le total des allocations est ${(total * 100).toFixed(2)} % (doit faire 100 %).`);
      }
    }
  }
  return errors;
}

const FOUR_ASSETS = ['SPY', 'QQQ', 'GLD', 'TLT'].map((ticker) => ({ ticker, allocation: 0.25, include_dividends: true }));
const PRESET_COMMON = {
  benchmark_ticker: '^GSPC',
  initial_value: 10000,
  added_amount: 10000,
  added_frequency: 'Annually',
  rebalancing_frequency: 'Annually',
  calc_beta: false,
  calc_volatility: false,
  beta_window_days: 365,
  exclude_days_beta: 30,
  vol_window_days: 365,
  exclude_days_vol: 30,
};

/** Streamlit default_configs (start_with / dates left to the global options). */
export const PRESETS: { id: string; label: string; config: Record<string, unknown> }[] = [
  {
    id: 'spy',
    label: 'Benchmark seul (SPY)',
    config: { ...PRESET_COMMON, name: 'Benchmark Only (SPY)', stocks: [{ ticker: 'SPY', allocation: 1, include_dividends: true }], use_momentum: false, momentum_windows: [] },
  },
  {
    id: 'momentum',
    label: 'Momentum SPY / QQQ / GLD / TLT',
    config: {
      ...PRESET_COMMON,
      name: 'Momentum-Based Portfolio',
      stocks: FOUR_ASSETS,
      use_momentum: true,
      momentum_strategy: 'Classic',
      negative_momentum_strategy: 'Cash',
      momentum_windows: [
        { lookback: 365, exclude: 30, weight: 0.5 },
        { lookback: 180, exclude: 30, weight: 0.3 },
        { lookback: 120, exclude: 30, weight: 0.2 },
      ],
    },
  },
  {
    id: 'equal',
    label: 'Poids égaux SPY / QQQ / GLD / TLT',
    config: { ...PRESET_COMMON, name: 'Equal Weight Portfolio (No Momentum)', stocks: FOUR_ASSETS, use_momentum: false, momentum_windows: [] },
  },
];

/** generate_fusion_name (allocations in %, top 2 by weight). */
export function fusionName(allocations: Record<string, number>, frequency: string): string {
  const top = Object.entries(allocations)
    .filter(([, v]) => v != null && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([n, pct]) => `${n} ${(pct <= 1 ? pct * 100 : pct).toFixed(0)}%`);
  return top.length ? `Fusion ${top.join(' ')} (${frequency})` : `Fusion (${frequency})`;
}

export function equalFusionAllocations(names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  names.forEach((n) => { out[n] = names.length ? 1 / names.length : 0; });
  return out;
}

export function normalizeWeights<T extends Record<string, number>>(allocations: T): T {
  const total = Object.values(allocations).reduce((s, v) => s + (Number(v) || 0), 0);
  if (!(total > 0)) return allocations;
  const out = {} as Record<string, number>;
  for (const [k, v] of Object.entries(allocations)) out[k] = (Number(v) || 0) / total;
  return out as T;
}

/** Export compatible with the Streamlit "paste all portfolios" import. */
export function exportJson(portfolios: EditablePortfolio[], options: RunOptions): string {
  const list = portfolios.map((p) => ({
    ...toEngineConfig(p),
    start_with: options.start_with === 'oldest' ? 'first' : 'all',
    first_rebalance_strategy: options.first_rebalance_strategy,
    auto_adjust_momentum_start: options.auto_adjust_momentum_start,
    start_date_user: options.start_date,
    end_date_user: options.end_date,
  }));
  return JSON.stringify(list, null, 2);
}

export function totalAllocation(p: PortfolioConfig): number {
  return p.stocks.reduce((s, x) => s + (Number(x.allocation) || 0), 0);
}

export function isFusion(p: PortfolioConfig): boolean {
  return Boolean(p.fusion_portfolio?.enabled);
}

/** ensure_unique_portfolio_name: "Name (1)", "Name (2)", … */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let i = 1;
  while (taken.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}
