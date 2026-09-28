/** Portfolio Variation Summary and monthly returns heatmap (1_Multi_Backtest.py). */
import { cagrOf, volatilityOf } from './focused';
import { monthLabel, pctChange, resampleLast, type PfSeries } from './series';

export interface VariationRow {
  index: number;
  name: string;
  totalReturn: number;
  cagr: number;
  volatility: number;
  maxDrawdown: number;
}

export function variationSummary(pfs: PfSeries[]): VariationRow[] {
  const out: VariationRow[] = [];
  for (const pf of pfs) {
    const v = pf.noAdd;
    if (v.length < 2) continue;
    const totalReturn = v[0] && !Number.isNaN(v[0]) ? (v[v.length - 1] / v[0] - 1) * 100 : NaN;
    const cagr = cagrOf(pf.days, v);
    const r = pctChange(v);
    for (let i = 0; i < r.length; i++) if (Number.isNaN(r[i])) r[i] = 0;
    const vol = volatilityOf(r);
    // np.maximum.accumulate propagates NaN, like the Streamlit helper.
    let peak = -Infinity;
    let maxDd = NaN;
    for (let i = 0; i < v.length; i++) {
      peak = Number.isNaN(v[i]) || Number.isNaN(peak) ? NaN : Math.max(peak, v[i]);
      const dd = (v[i] - peak) / (peak === 0 ? 1 : peak);
      if (!Number.isNaN(dd) && !(dd >= maxDd)) maxDd = dd;
    }
    out.push({
      index: pf.index,
      name: pf.name,
      totalReturn,
      cagr: cagr * 100,
      volatility: vol * 100,
      maxDrawdown: maxDd * 100,
    });
  }
  return out;
}

/** Streamlit's symmetric log transform for the grouped bar chart. */
export function symLog(v: number): number {
  if (Number.isNaN(v)) return NaN;
  if (v > 0) return Math.log10(v + 1);
  if (v < 0) return -Math.log10(Math.abs(v) + 1);
  return 0;
}

export interface Heatmap {
  months: string[];
  rows: { index: number; name: string }[];
  /** [monthIdx, rowIdx, value %] triplets (only defined cells) */
  cells: [number, number, number][];
  min: number;
  max: number;
}

export function monthlyHeatmap(pfs: PfSeries[]): Heatmap {
  const perPf: { pf: PfSeries; keys: number[]; pct: Float64Array }[] = [];
  const keySet = new Set<number>();
  for (const pf of pfs) {
    if (pf.noAdd.length < 2) continue;
    const m = resampleLast(pf.noAdd, pf.months);
    const pct = pctChange(m.values);
    const keys: number[] = [];
    const vals: number[] = [];
    pct.forEach((v, k) => {
      if (!Number.isNaN(v)) {
        keys.push(m.keys[k]);
        vals.push(v * 100);
        keySet.add(m.keys[k]);
      }
    });
    perPf.push({ pf, keys, pct: Float64Array.from(vals) });
  }
  const allKeys = [...keySet].sort((a, b) => a - b);
  const pos = new Map(allKeys.map((k, i) => [k, i]));
  const cells: [number, number, number][] = [];
  let lo = Infinity;
  let hi = -Infinity;
  perPf.forEach(({ keys, pct }, row) => {
    keys.forEach((k, j) => {
      const v = pct[j];
      cells.push([pos.get(k)!, row, v]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    });
  });
  return {
    months: allKeys.map(monthLabel),
    rows: perPf.map(({ pf }) => ({ index: pf.index, name: pf.name })),
    cells,
    min: Number.isFinite(lo) ? lo : 0,
    max: Number.isFinite(hi) ? hi : 0,
  };
}

export interface DrawdownSeries {
  index: number;
  /** drawdown % per row of the portfolio's series */
  values: Float64Array;
}

/** Drawdown of the no-additions series (Streamlit `calculate_max_drawdown`). */
export function drawdowns(pfs: PfSeries[]): DrawdownSeries[] {
  return pfs.map((pf) => {
    const v = pf.noAdd;
    const out = new Float64Array(v.length);
    let peak = -Infinity;
    for (let i = 0; i < v.length; i++) {
      if (!Number.isNaN(v[i]) && v[i] > peak) peak = v[i];
      out[i] = Number.isNaN(v[i]) ? NaN : ((v[i] - peak) / (peak === 0 ? 1 : peak)) * 100;
    }
    return { index: pf.index, values: out };
  });
}
