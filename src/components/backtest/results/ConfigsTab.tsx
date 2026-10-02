'use client';

import { useMemo } from 'react';
import type { PortfolioConfig, PortfolioSummary } from '@/lib/engine/types';
import DataGrid, { type GridColumn } from '../grid/DataGrid';
import styles from '../Results.module.css';

type Field = { label: string; get: (c: PortfolioConfig) => string; width?: number };

const usd = (v: unknown) => `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const yes = (v: unknown) => (v ? 'Yes' : 'No');
const n = (v: unknown, d: number) => (Number(v) || 0).toFixed(d);

/** Same rows as Streamlit's "Portfolio Configuration Comparison". */
const FIELDS: Field[] = [
  { label: 'Initial Investment', get: (c) => usd(c.initial_value) },
  { label: 'Added Amount', get: (c) => usd(c.added_amount) },
  { label: 'Added Frequency', get: (c) => String(c.added_frequency ?? 'None') },
  { label: 'Rebalancing Frequency', get: (c) => String(c.rebalancing_frequency ?? 'None') },
  { label: 'Use Momentum', get: (c) => yes(c.use_momentum) },
  { label: 'Momentum Strategy', get: (c) => String(c.momentum_strategy ?? 'N/A') },
  { label: 'Negative Momentum Strategy', get: (c) => String(c.negative_momentum_strategy ?? 'N/A'), width: 200 },
  { label: 'Number of Stocks', get: (c) => String(c.stocks?.length ?? 0) },
  { label: 'Stocks', get: (c) => (c.stocks ?? []).map((s) => s.ticker).join(', '), width: 260 },
  { label: 'Benchmark', get: (c) => String(c.benchmark_ticker ?? 'N/A') },
  {
    label: 'Momentum Windows',
    get: (c) => (c.momentum_windows ?? []).map((w) => `${w.lookback}/${w.exclude}×${w.weight}`).join(' · '),
    width: 220,
  },
  { label: 'Window-Capped Score', get: (c) => yes(c.use_window_capped_score) },
  { label: 'Beta Enabled', get: (c) => yes(c.calc_beta) },
  { label: 'Volatility Enabled', get: (c) => yes(c.calc_volatility) },
  { label: 'Beta Window', get: (c) => (c.calc_beta ? `${c.beta_window_days ?? 0}-${c.exclude_days_beta ?? 0}` : 'N/A') },
  { label: 'Volatility Window', get: (c) => (c.calc_volatility ? `${c.vol_window_days ?? 0}-${c.exclude_days_vol ?? 0}` : 'N/A') },
  { label: 'Minimal Threshold', get: (c) => (c.use_minimal_threshold ? `${n(c.minimal_threshold_percent ?? 4, 1)}%` : 'Disabled') },
  { label: 'Maximum Allocation', get: (c) => (c.use_max_allocation ? `${n(c.max_allocation_percent ?? 20, 1)}%` : 'Disabled') },
  { label: 'MA Filter', get: (c) => yes(c.use_sma_filter) },
  { label: 'MA Type', get: (c) => String(c.ma_type ?? 'SMA') },
  { label: 'MA Window', get: (c) => `${c.sma_window ?? 200} days` },
  { label: 'MA Multiplier', get: (c) => n(c.ma_multiplier ?? 1.48, 4) },
  { label: 'MA Cross Rebalancing', get: (c) => yes(c.ma_cross_rebalance) },
  { label: 'MA Tolerance Band', get: (c) => (c.ma_cross_rebalance ? `${n(c.ma_tolerance_percent ?? 2, 1)}%` : 'N/A') },
  { label: 'MA Confirmation Days', get: (c) => (c.ma_cross_rebalance ? `${c.ma_confirmation_days ?? 3} days` : 'N/A') },
];

type Row = { index: number; name: string; config: PortfolioConfig; ok: boolean };

export default function ConfigsTab({ portfolios }: { portfolios: PortfolioSummary[] }) {
  const rows = useMemo<Row[]>(
    () => portfolios.filter((p) => p.config).map((p) => ({ index: p.index, name: p.name, config: p.config as PortfolioConfig, ok: p.ok })),
    [portfolios],
  );
  const columns = useMemo<GridColumn<Row>[]>(() => [
    { key: 'name', label: 'Portfolio', width: 220, value: (r) => r.name, format: (v, r) => (r.ok ? String(v) : `${v} (échec)`) },
    ...FIELDS.map<GridColumn<Row>>((f) => ({
      key: f.label,
      label: f.label,
      width: f.width ?? Math.max(120, f.label.length * 7.5 + 20),
      value: (r) => f.get(r.config),
    })),
  ], []);
  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Comparaison des configurations</div>
          <div className={styles.cardSub}>Paramètres de chaque portfolio du run</div>
        </div>
      </div>
      <div className={styles.padded}>
        <DataGrid columns={columns} rows={rows} rowKey={(r) => r.index} maxHeight={620} csvName="configurations" />
      </div>
    </div>
  );
}
