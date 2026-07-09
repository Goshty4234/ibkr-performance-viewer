'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { firstVisibleBenchmarkId } from '@/lib/chart-series';
import { sliceAndRebaseChartData, type ChartBrushSelection } from '@/lib/chart-range';
import { fmtAbsPct, fmtPct } from '@/lib/performance';
import { computeRiskMetricsRowsForSeries, DEFAULT_RISK_FREE_ANNUAL_PCT } from '@/lib/risk-metrics';
import styles from './RiskMetricsTable.module.css';

interface Props {
  series: ChartSeriesDef[];
  data: MultiSeriesChartPoint[];
  hidden: Set<string>;
  brush: ChartBrushSelection | null;
  loading: boolean;
  show: boolean;
}

function fmtRatio(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export default function RiskMetricsTable({
  series,
  data,
  hidden,
  brush,
  loading,
  show,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const betaRef = useMemo(
    () => firstVisibleBenchmarkId(series, hidden),
    [series, hidden],
  );

  const metricsData = useMemo(() => {
    if (!brush) return data;
    const ids = series.map((s) => s.id);
    return sliceAndRebaseChartData(data, ids, brush.startIdx, brush.endIdx);
  }, [brush, data, series]);

  const rows = useMemo(
    () => computeRiskMetricsRowsForSeries(metricsData, series, hidden, betaRef),
    [metricsData, series, hidden, betaRef],
  );

  if (!mounted || !show || loading || rows.length === 0) return null;

  const columns = [
    { key: 'totalReturn', label: 'Rendement', fmt: (v: number) => fmtPct(v) },
    { key: 'cagr', label: 'CAGR', fmt: (v: number) => fmtPct(v) },
    { key: 'maxDrawdown', label: 'Max drawdown', fmt: (v: number) => fmtPct(v) },
    { key: 'volatility', label: 'Volatilité', fmt: (v: number) => fmtAbsPct(v) },
    { key: 'sharpe', label: 'Sharpe', fmt: (v: number) => fmtRatio(v) },
    { key: 'sortino', label: 'Sortino', fmt: (v: number | null) => fmtRatio(v) },
    { key: 'ulcerIndex', label: 'Ulcer index', fmt: (v: number) => fmtAbsPct(v) },
    { key: 'upi', label: 'UPI', fmt: (v: number | null) => fmtRatio(v) },
    { key: 'beta', label: 'Beta', fmt: (v: number | null) => fmtRatio(v) },
  ] as const;

  return (
    <div className={styles.card}>
      <div className={styles.title}>Métriques de risque</div>
      <div className={styles.sub}>
        {brush
          ? 'Sous-plage mesurée sur le graphique (métriques recalculées pour cette sélection)'
          : 'Période affichée · volatilité annualisée (√252)'}
        {` · Sharpe (CAGR) / Sortino (R̄) avec rf = ${DEFAULT_RISK_FREE_ANNUAL_PCT} % (Trésor 3 mois)`}
        {betaRef && ' · Beta vs premier benchmark visible'}
      </div>
      <div className={styles.wrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Courbe</th>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.seriesId}>
                <td className={styles.rowLabel}>{row.label}</td>
                {columns.map((c) => {
                  const raw = row.metrics[c.key];
                  const text = c.fmt(raw as never);
                  const positive = typeof raw === 'number' && raw > 0;
                  const negative = typeof raw === 'number' && raw < 0;
                  const colorClass =
                    c.key === 'maxDrawdown' || c.key === 'cagr' || c.key === 'totalReturn'
                      ? negative
                        ? 'negative'
                        : positive
                          ? 'positive'
                          : ''
                      : '';
                  return (
                    <td key={c.key} className={`mono ${colorClass}`}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
