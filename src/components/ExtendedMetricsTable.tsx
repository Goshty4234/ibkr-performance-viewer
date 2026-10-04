'use client';

import { useMemo } from 'react';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { sliceAndRebaseChartData, type ChartBrushSelection } from '@/lib/chart-range';
import { computeExtendedRows, type ExtendedMetrics } from '@/lib/extended-metrics';
import { fmtPct } from '@/lib/performance';
import styles from './AccountExtras.module.css';

interface Props {
  series: ChartSeriesDef[];
  data: MultiSeriesChartPoint[];
  hidden: Set<string>;
  brush: ChartBrushSelection | null;
  loading: boolean;
}

type Fmt = 'pct' | 'pct1' | 'ratio' | 'days';

const COLUMNS: { key: keyof ExtendedMetrics; label: string; fmt: Fmt; help: string }[] = [
  { key: 'currentDrawdown', label: 'Drawdown actuel', fmt: 'pct', help: 'Distance entre la valeur actuelle et le dernier sommet.' },
  { key: 'medianDrawdown', label: 'Drawdown médian', fmt: 'pct', help: 'Baisse médiane depuis le dernier sommet.' },
  { key: 'longestDrawdownDays', label: 'Plus longue baisse', fmt: 'days', help: 'Plus longue période (en jours) passée sous un sommet précédent.' },
  { key: 'winRate', label: 'Jours gagnants', fmt: 'pct1', help: 'Pourcentage de jours en hausse (jours sans variation exclus).' },
  { key: 'lossRate', label: 'Jours perdants', fmt: 'pct1', help: 'Pourcentage de jours en baisse (jours sans variation exclus).' },
  { key: 'medianWin', label: 'Gain médian', fmt: 'pct', help: 'Rendement médian des jours en hausse.' },
  { key: 'medianLoss', label: 'Perte médiane', fmt: 'pct', help: 'Rendement médian des jours en baisse.' },
  { key: 'bestDay', label: 'Meilleur jour', fmt: 'pct', help: 'Meilleur rendement quotidien.' },
  { key: 'worstDay', label: 'Pire jour', fmt: 'pct', help: 'Pire rendement quotidien.' },
  { key: 'profitFactor', label: 'Profit factor', fmt: 'ratio', help: 'Somme des gains quotidiens divisée par la somme des pertes quotidiennes.' },
  { key: 'bestMonth', label: 'Meilleur mois', fmt: 'pct', help: 'Meilleur rendement mensuel.' },
  { key: 'worstMonth', label: 'Pire mois', fmt: 'pct', help: 'Pire rendement mensuel.' },
  { key: 'medianMonthly', label: 'Mois médian', fmt: 'pct', help: 'Rendement mensuel médian.' },
  { key: 'positiveMonthsPct', label: 'Mois positifs', fmt: 'pct1', help: 'Part des mois avec un rendement positif.' },
  { key: 'calmar', label: 'Calmar', fmt: 'ratio', help: 'CAGR divisé par la pire baisse (max drawdown).' },
  { key: 'sterling', label: 'Sterling', fmt: 'ratio', help: 'CAGR divisé par la baisse médiane.' },
  { key: 'recoveryFactor', label: 'Recovery factor', fmt: 'ratio', help: 'Rendement total divisé par la pire baisse : capacité à se remettre des baisses.' },
  { key: 'tailRatio', label: 'Tail ratio', fmt: 'ratio', help: '95e centile des rendements quotidiens divisé par la valeur absolue du 5e : asymétrie des extrêmes.' },
];

function fmt(v: number | null, kind: Fmt): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (kind === 'pct') return fmtPct(v);
  if (kind === 'pct1') return `${v.toFixed(1)} %`;
  if (kind === 'days') return `${Math.round(v)} j`;
  return v.toFixed(2);
}

export default function ExtendedMetricsTable({ series, data, hidden, brush, loading }: Props) {
  const metricsData = useMemo(() => {
    if (!brush) return data;
    return sliceAndRebaseChartData(data, series.map((s) => s.id), brush.startIdx, brush.endIdx);
  }, [brush, data, series]);

  const rows = useMemo(() => computeExtendedRows(metricsData, series, hidden), [metricsData, series, hidden]);

  if (loading || rows.length === 0) return null;

  return (
    <div className={styles.card}>
      <div className={styles.title}>Analyse détaillée</div>
      <div className={styles.sub}>
        Mêmes définitions que l’« Analyse ciblée » du Backtester, calculées sur la courbe de rendement affichée
        {brush ? ' (sous-plage sélectionnée)' : ''}. Passe la souris sur un titre de colonne pour sa définition.
      </div>
      <div className={styles.wrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Courbe</th>
              {COLUMNS.map((c) => (
                <th key={c.key} title={c.help}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.seriesId}>
                <td>{row.label}</td>
                {COLUMNS.map((c) => {
                  const raw = row.metrics[c.key];
                  const cls = c.fmt === 'pct' && typeof raw === 'number' ? (raw > 0 ? 'positive' : raw < 0 ? 'negative' : '') : '';
                  return (
                    <td key={c.key} className={`mono ${cls}`}>{fmt(raw as number | null, c.fmt)}</td>
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
