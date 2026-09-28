/**
 * Yearly / monthly performance tables and their "Robust Statistics"
 * (1_Multi_Backtest.py, Yearly and Monthly Performance sections).
 *
 * % change uses the no-additions series (first period starts from the
 * config's initial value, later periods from the previous period end);
 * final values come from the with-additions series.
 */
import { cov, dropNaN, mean, median, std, variance } from './math';
import { monthLabel, pctChange, resampleLast, type PfSeries, yearsOf } from './series';

export type PeriodKind = 'year' | 'month';

export interface PeriodColumn {
  index: number;
  name: string;
  /** % change per period (NaN when Streamlit shows N/A) */
  pct: Float64Array;
  final: Float64Array;
}

export interface PeriodTable {
  kind: PeriodKind;
  keys: number[];
  labels: string[];
  columns: PeriodColumn[];
}

export interface RobustRow {
  index: number;
  name: string;
  positives: number;
  positivePct: number;
  mean: number;
  median: number;
  std: number;
  posMean: number;
  posMedian: number;
  negMean: number;
  negMedian: number;
  volMean: number;
  volMedian: number;
  volAnnMean: number;
  volAnnMedian: number;
  betaMean: number;
  betaMedian: number;
}

function bucketsOf(pf: PfSeries, kind: PeriodKind): Int32Array {
  return kind === 'year' ? yearsOf(pf.months) : pf.months;
}

function lookup(r: { keys: number[]; values: Float64Array }, key: number): number | undefined {
  if (!r.keys.length) return undefined;
  const k = key - r.keys[0];
  return k >= 0 && k < r.keys.length ? r.values[k] : undefined;
}

export function periodTable(pfs: PfSeries[], kind: PeriodKind): PeriodTable {
  const keySet = new Set<number>();
  const perPf = pfs.map((pf) => {
    const b = bucketsOf(pf, kind);
    const withR = resampleLast(pf.withAdd, b);
    const noR = resampleLast(pf.noAdd, b);
    if (kind === 'year') for (const k of withR.keys) keySet.add(k);
    else for (let i = 0; i < b.length; i++) keySet.add(b[i]);
    return { withR, noR };
  });
  const keys = [...keySet].sort((a, b) => a - b);
  const firstKey = keys[0];
  const columns: PeriodColumn[] = pfs.map((pf, j) => {
    const { withR, noR } = perPf[j];
    const pct = new Float64Array(keys.length).fill(NaN);
    const final = new Float64Array(keys.length).fill(NaN);
    keys.forEach((key, i) => {
      let start: number | undefined;
      if (key === firstKey) {
        const iv = Number(pf.config?.initial_value);
        if (iv > 0) start = iv;
      } else {
        const prevKey = kind === 'year' ? key - 1 : keys[i - 1];
        start = lookup(noR, prevKey);
      }
      const end = lookup(noR, key);
      if (end !== undefined && start !== undefined) pct[i] = start > 0 ? ((end - start) / start) * 100 : NaN;
      const fv = lookup(withR, key);
      if (fv !== undefined) final[i] = fv;
    });
    return { index: pf.index, name: pf.name, pct, final };
  });
  const labels = keys.map((k) => (kind === 'year' ? String(k) : monthLabel(k)));
  return { kind, keys, labels, columns };
}

function groupStd(values: number[], groups: number[], ddof: number): number[] {
  const out: number[] = [];
  let start = 0;
  for (let i = 1; i <= values.length; i++) {
    if (i === values.length || groups[i] !== groups[start]) {
      out.push(std(values.slice(start, i), ddof));
      start = i;
    }
  }
  return out;
}

function groupBetas(p: number[], b: number[], groups: number[]): number[] {
  const out: number[] = [];
  let start = 0;
  for (let i = 1; i <= p.length; i++) {
    if (i === p.length || groups[i] !== groups[start]) {
      if (i - start >= 2) {
        const pp = p.slice(start, i);
        const bb = b.slice(start, i);
        const vb = variance(bb, 1);
        if (vb > 0) out.push(cov(pp, bb, 1) / vb);
      }
      start = i;
    }
  }
  return out;
}

/** Daily portfolio returns joined with the benchmark's trading-day returns (pandas concat + dropna). */
function joinDaily(pf: PfSeries, bench: Map<number, number>, kind: PeriodKind) {
  const r = pctChange(pf.noAdd);
  const p: number[] = [];
  const b: number[] = [];
  const g: number[] = [];
  for (let i = 0; i < r.length; i++) {
    if (Number.isNaN(r[i])) continue;
    const br = bench.get(pf.days[i]);
    if (br === undefined) continue;
    p.push(r[i]);
    b.push(br);
    g.push(kind === 'year' ? Math.floor(pf.months[i] / 12) : pf.months[i]);
  }
  return { p, b, g };
}

export function robustStats(table: PeriodTable, pfs: PfSeries[], bench: Map<number, number> | null): RobustRow[] {
  const byIndex = new Map(pfs.map((pf) => [pf.index, pf]));
  return table.columns.map((col) => {
    const s = dropNaN(col.pct);
    const total = s.length;
    const positives = s.filter((v) => v > 0).length;
    const pos = s.filter((v) => v > 0);
    const neg = s.filter((v) => v < 0);
    const row: RobustRow = {
      index: col.index,
      name: col.name,
      positives,
      positivePct: total > 0 ? (positives / total) * 100 : NaN,
      mean: total > 0 ? mean(s) : NaN,
      median: total > 0 ? median(s) : NaN,
      std: total > 1 ? std(s, 0) : NaN,
      posMean: pos.length ? mean(pos) : NaN,
      posMedian: pos.length ? median(pos) : NaN,
      negMean: neg.length ? mean(neg) : NaN,
      negMedian: neg.length ? median(neg) : NaN,
      volMean: NaN,
      volMedian: NaN,
      volAnnMean: NaN,
      volAnnMedian: NaN,
      betaMean: NaN,
      betaMedian: NaN,
    };
    const pf = byIndex.get(col.index);
    if (!pf || !pf.noAdd.length) return row;
    const annFactor = table.kind === 'year' ? Math.sqrt(12) : Math.sqrt(252);
    let computeBeta = true;
    if (table.kind === 'year') {
      const monthly = resampleLast(pf.noAdd, pf.months);
      const mr = pctChange(monthly.values);
      const vals: number[] = [];
      const groups: number[] = [];
      mr.forEach((v, k) => {
        if (!Number.isNaN(v)) {
          vals.push(v);
          groups.push(Math.floor(monthly.keys[k] / 12));
        }
      });
      if (!vals.length) computeBeta = false;
      else {
        const vols = groupStd(vals, groups, 0);
        row.volMean = mean(vols);
        row.volMedian = median(vols);
        const ann = vols.map((v) => v * annFactor);
        row.volAnnMean = mean(ann);
        row.volAnnMedian = median(ann);
      }
    } else {
      const r = pctChange(pf.noAdd);
      const vals: number[] = [];
      const groups: number[] = [];
      r.forEach((v, k) => {
        if (!Number.isNaN(v)) {
          vals.push(v);
          groups.push(pf.months[k]);
        }
      });
      if (vals.length) {
        const vols = groupStd(vals, groups, 0);
        row.volMean = mean(vols);
        row.volMedian = median(vols);
        const ann = vols.map((v) => v * annFactor);
        row.volAnnMean = mean(ann);
        row.volAnnMedian = median(ann);
      }
    }
    if (computeBeta && bench && bench.size) {
      const { p, b, g } = joinDaily(pf, bench, table.kind);
      if (p.length) {
        const betas = groupBetas(p, b, g);
        if (betas.length) {
          row.betaMean = mean(betas);
          row.betaMedian = median(betas);
        }
      }
    }
    return row;
  });
}
