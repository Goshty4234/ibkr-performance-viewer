import type { MomentumWindow } from '@/lib/engine/types';
import { type EditablePortfolio, newId, uniqueName } from './portfolio';

/** Option lists of the Streamlit "Generate Portfolio Variants" expander. */
export interface ValueAxis<T> { off: boolean; on: boolean; values: T[] }
export interface WindowConfig { lookback: number; exclude: number; tag: string }
export interface MomentumConfig { windows: MomentumWindow[]; tag: string }

export interface VariantSpec {
  keepCurrent: boolean;
  rebalance: string[];
  useMomentum: boolean;
  momentumStrategies: string[];
  negativeStrategies: string[];
  beta: boolean[];
  volatility: boolean[];
  threshold: ValueAxis<number>;
  maxAllocation: ValueAxis<number>;
  equalWeight: ValueAxis<number>;
  limitTopN: ValueAxis<number>;
  momentumConfigs: MomentumConfig[];
  betaConfigs: WindowConfig[];
  volatilityConfigs: WindowConfig[];
  maDisabled: boolean;
  sma: { on: boolean; values: number[] };
  ema: { on: boolean; values: number[] };
  maCross: { off: boolean; on: boolean; tolerances: number[]; delays: number[] };
}

export const DEFAULT_WINDOWS: MomentumWindow[] = [
  { lookback: 365, exclude: 30, weight: 0.5, discard_if_negative: false, discard_unless_recent_positive: false },
  { lookback: 180, exclude: 30, weight: 0.3, discard_if_negative: false, discard_unless_recent_positive: false },
  { lookback: 120, exclude: 30, weight: 0.2, discard_if_negative: false, discard_unless_recent_positive: false },
];

export function defaultVariantSpec(): VariantSpec {
  return {
    keepCurrent: true,
    rebalance: ['Monthly'],
    useMomentum: true,
    momentumStrategies: ['Classic'],
    negativeStrategies: ['Cash'],
    beta: [true],
    volatility: [true],
    threshold: { off: true, on: false, values: [2] },
    maxAllocation: { off: true, on: false, values: [10] },
    equalWeight: { off: true, on: false, values: [10] },
    limitTopN: { off: true, on: false, values: [10] },
    momentumConfigs: [{ windows: DEFAULT_WINDOWS.map((w) => ({ ...w })), tag: '' }],
    betaConfigs: [{ lookback: 365, exclude: 30, tag: '' }],
    volatilityConfigs: [{ lookback: 365, exclude: 30, tag: '' }],
    maDisabled: true,
    sma: { on: false, values: [200] },
    ema: { on: false, values: [200] },
    maCross: { off: true, on: false, tolerances: [2], delays: [3] },
  };
}

type Axis = { key: string; values: unknown[] };

const axisValues = <T,>(a: ValueAxis<T>): (T | null)[] => [...(a.off ? [null] : []), ...(a.on ? a.values : [])];

/** Parameter axes in the insertion order of Streamlit's variant_params dict (drives the product order). */
function buildAxes(s: VariantSpec): Axis[] {
  const axes: Axis[] = [];
  const push = (key: string, values: unknown[]) => axes.push({ key, values });
  if (s.rebalance.length) push('rebalance_frequency', s.rebalance);
  if (s.useMomentum) {
    if (s.momentumStrategies.length) push('momentum_strategy', s.momentumStrategies);
    if (s.negativeStrategies.length) push('negative_strategy', s.negativeStrategies);
    if (s.beta.length) push('include_beta', s.beta);
    if (s.volatility.length) push('include_volatility', s.volatility);
  }
  for (const [key, axis] of [
    ['minimal_threshold', s.threshold],
    ['max_allocation', s.maxAllocation],
    ['equal_weight', s.equalWeight],
    ['limit_to_top_n', s.limitTopN],
  ] as const) {
    if (!s.useMomentum) push(key, [null]);
    else {
      const v = axisValues(axis);
      if (v.length) push(key, v);
    }
  }
  if (s.useMomentum) {
    push('momentum_windows', s.momentumConfigs.map((c, i) => [i, c.windows]));
    if (s.betaConfigs.length) push('beta_configs', s.betaConfigs.map((c, i) => [i, [c.lookback, c.exclude]]));
    if (s.volatilityConfigs.length) push('volatility_configs', s.volatilityConfigs.map((c, i) => [i, [c.lookback, c.exclude]]));
  }
  const ma: unknown[] = [
    ...(s.maDisabled ? [null] : []),
    ...(s.sma.on ? s.sma.values.map((v) => ['SMA', v]) : []),
    ...(s.ema.on ? s.ema.values.map((v) => ['EMA', v]) : []),
  ];
  push('ma_windows', (ma.length ? ma : [null]).map((v, i) => [i, v]));
  push('ma_multiplier', [1.48]);
  const anyMa = s.sma.on || s.ema.on;
  const cross = anyMa ? [...(s.maCross.off ? [false] : []), ...(s.maCross.on ? [true] : [])] : [false];
  if (cross.length) {
    push('ma_cross_rebalance', cross);
    push('ma_tolerance_percent', anyMa && s.maCross.on ? s.maCross.tolerances : [2]);
    push('ma_confirmation_days', anyMa && s.maCross.on ? s.maCross.delays : [3]);
  } else {
    push('ma_cross_rebalance', [false]);
    push('ma_tolerance_percent', [2]);
    push('ma_confirmation_days', [3]);
  }
  return axes;
}

export function variantCount(s: VariantSpec): number {
  return buildAxes(s).reduce((n, a) => n * a.values.length, 1);
}

export function validateVariantSpec(s: VariantSpec): string[] {
  const errors: string[] = [];
  if (!s.rebalance.length) errors.push('Choisis au moins une fréquence de rebalancement.');
  if (s.useMomentum) {
    if (!s.momentumStrategies.length) errors.push('Choisis au moins une stratégie momentum.');
    if (!s.negativeStrategies.length) errors.push('Choisis au moins une stratégie « tout négatif ».');
    if (!s.beta.length) errors.push('Choisis au moins une option bêta.');
    if (!s.volatility.length) errors.push('Choisis au moins une option volatilité.');
    if (!axisValues(s.threshold).length) errors.push('Choisis au moins une option de seuil minimal.');
    if (!axisValues(s.maxAllocation).length) errors.push('Choisis au moins une option d’allocation maximale.');
    if (!s.momentumConfigs.length) errors.push('Ajoute au moins une configuration de fenêtres momentum.');
  }
  if (!s.maDisabled && !s.sma.on && !s.ema.on) errors.push('Filtre MA : coche au moins une option (sans MA, SMA ou EMA).');
  if (s.sma.on && !s.sma.values.length) errors.push('SMA : ajoute au moins une valeur.');
  if (s.ema.on && !s.ema.values.length) errors.push('EMA : ajoute au moins une valeur.');
  if ((s.sma.on || s.ema.on) && !s.maCross.off && !s.maCross.on) {
    errors.push('Croisement MA : coche au moins une option (désactivé ou activé).');
  }
  return errors;
}

/** Python's "{:.Nf}": exact ties round half to even (JS toFixed rounds them up). */
export function pyFixed(v: number, digits: number): string {
  // toFixed is exact up to 100 digits, which exposes the true binary value (2.675 is 2.67499…).
  const [int, frac = ''] = Math.abs(v).toFixed(Math.min(100, digits + 30)).split('.');
  if (!/^50*$/.test(frac.slice(digits))) return v.toFixed(digits);
  const kept = BigInt(int + frac.slice(0, digits));
  const one = BigInt(1);
  const s = ((kept & one) === BigInt(0) ? kept : kept + one).toString().padStart(digits + 1, '0');
  const out = digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s;
  return v < 0 ? `-${out}` : out;
}

function variantName(v: EditablePortfolio, baseName: string, tags: string): string {
  const parts: string[] = [String(v.rebalancing_frequency), '-'];
  if (v.use_momentum) {
    parts.push('Momentum :');
    const ms = v.momentum_strategy;
    if (ms === 'Classic') parts.push('Classic');
    else if (ms === 'Relative Momentum') parts.push('Relative');
    else if (ms === 'Near-Zero Symmetry') parts.push('NZS');
    const ns = v.negative_momentum_strategy;
    if (ns === 'Cash') parts.push('and Cash');
    else if (ns === 'Equal weight') parts.push('and Equal Weight');
    else if (ns === 'Relative momentum') parts.push('and Relative');
    else if (ns === 'Near-Zero Symmetry') parts.push('and NZS');
    if (v.calc_beta) parts.push('- Beta');
    if (v.calc_volatility) parts.push('- Volatility');
  } else {
    parts.push('No Momentum');
  }
  if (v.use_minimal_threshold) parts.push(`- Min ${pyFixed(Number(v.minimal_threshold_percent ?? 4), 2)}%`);
  if (v.use_max_allocation) parts.push(`- Max ${pyFixed(Number(v.max_allocation_percent ?? 20), 2)}%`);
  if (v.use_equal_weight) parts.push(`- Equal ${v.equal_weight_n_tickers ?? 10}`);
  if (v.use_limit_to_top_n) parts.push(`- Tickers ${v.limit_to_top_n_tickers ?? 10}`);
  if (v.use_sma_filter) {
    const mult = Number(v.ma_multiplier ?? 1.48);
    const label = `${v.ma_type ?? 'SMA'}${v.sma_window ?? 200}`;
    parts.push(mult !== 1.48 ? `- ${label}x${pyFixed(mult, 2)}` : `- ${label}`);
  }
  if (v.ma_cross_rebalance && v.use_sma_filter) {
    parts.push(`- Cross Band ${pyFixed(Number(v.ma_tolerance_percent ?? 2), 0)}% Days ${v.ma_confirmation_days ?? 3}`);
  }
  return tags ? `${baseName} ${tags} (${parts.join(' ')})` : `${baseName} (${parts.join(' ')})`;
}

function applyValue(v: EditablePortfolio, key: string, value: unknown) {
  switch (key) {
    case 'rebalance_frequency': v.rebalancing_frequency = value as string; break;
    case 'momentum_strategy': v.momentum_strategy = value as string; break;
    case 'negative_strategy': v.negative_momentum_strategy = value as string; break;
    case 'include_beta': v.calc_beta = value as boolean; break;
    case 'include_volatility': v.calc_volatility = value as boolean; break;
    case 'momentum_windows': v.momentum_windows = (value as MomentumWindow[]).map((w) => ({ ...w })); break;
    case 'beta_configs': [v.beta_window_days, v.exclude_days_beta] = value as [number, number]; break;
    case 'volatility_configs': [v.vol_window_days, v.exclude_days_vol] = value as [number, number]; break;
    case 'minimal_threshold':
      v.use_minimal_threshold = value !== null;
      v.minimal_threshold_percent = value === null ? 4 : (value as number);
      break;
    case 'max_allocation':
      v.use_max_allocation = value !== null;
      v.max_allocation_percent = value === null ? 20 : (value as number);
      break;
    case 'equal_weight':
      v.use_equal_weight = value !== null;
      v.equal_weight_n_tickers = value === null ? 10 : value;
      break;
    case 'limit_to_top_n':
      v.use_limit_to_top_n = value !== null;
      v.limit_to_top_n_tickers = value === null ? 10 : value;
      break;
    case 'ma_windows':
      if (value === null) {
        v.use_sma_filter = false;
        v.sma_window = 200;
        v.ma_type = 'SMA';
      } else {
        const [type, window] = value as [string, number];
        v.ma_type = type;
        v.sma_window = window;
        v.use_sma_filter = true;
      }
      break;
    case 'ma_cross_rebalance': v.ma_cross_rebalance = value as boolean; break;
    case 'ma_tolerance_percent': v.ma_tolerance_percent = value as number; break;
    case 'ma_confirmation_days': v.ma_confirmation_days = value as number; break;
    case 'ma_multiplier': v.ma_multiplier = value as number; break;
    default: v[key] = value;
  }
}

/**
 * itertools.product over the axes, Streamlit field mapping and naming.
 * Variants share the base `stocks` array: store updates are immutable, so editing one never touches another.
 */
export function generateVariants(base: EditablePortfolio, spec: VariantSpec, takenNames: Iterable<string>): EditablePortfolio[] {
  const seed: EditablePortfolio = { ...base, momentum_windows: (base.momentum_windows ?? []).map((w) => ({ ...w })) };
  if (spec.useMomentum) {
    seed.use_momentum = true;
    if (!seed.momentum_windows?.length) {
      seed.momentum_windows = [
        { lookback: 365, exclude: 30, weight: 0.5 },
        { lookback: 180, exclude: 30, weight: 0.3 },
        { lookback: 120, exclude: 30, weight: 0.2 },
      ];
      seed.momentum_strategy ??= 'Classic';
      seed.negative_momentum_strategy ??= 'Cash';
      seed.calc_beta ??= false;
      seed.calc_volatility ??= true;
    }
  } else {
    seed.use_momentum = false;
  }

  const axes = buildAxes(spec);
  const total = axes.reduce((n, a) => n * a.values.length, 1);
  const taken = new Set(takenNames);
  const out: EditablePortfolio[] = [];
  const idx = new Array<number>(axes.length).fill(0);
  for (let n = 0; n < total; n++) {
    const v: EditablePortfolio = { ...seed, _id: newId() };
    const tagIdx: Record<string, number> = {};
    axes.forEach((axis, j) => {
      let value = axis.values[idx[j]];
      if (['momentum_windows', 'beta_configs', 'volatility_configs', 'ma_windows'].includes(axis.key)) {
        const [i, inner] = value as [number, unknown];
        tagIdx[axis.key] = i;
        value = inner;
      }
      applyValue(v, axis.key, value);
    });
    const tags = [
      spec.momentumConfigs[tagIdx.momentum_windows ?? -1]?.tag,
      spec.betaConfigs[tagIdx.beta_configs ?? -1]?.tag,
      spec.volatilityConfigs[tagIdx.volatility_configs ?? -1]?.tag,
    ]
      .filter((t): t is string => !!t && !!t.trim())
      .map((t) => `[${t}]`)
      .join('');
    const name = uniqueName(variantName(v, base.name, tags), taken);
    taken.add(name);
    v.name = name;
    out.push(v);
    for (let j = axes.length - 1; j >= 0; j--) {
      if (++idx[j] < axes[j].values.length) break;
      idx[j] = 0;
    }
  }
  return out;
}
