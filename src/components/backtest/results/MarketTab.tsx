'use client';

import { useMemo, useState } from 'react';
import { refDates } from '@/lib/backtest/result-data';
import type { ResultSummary, SeriesRef } from '@/lib/engine/types';
import EChart from '../charts/EChart';
import { CHART_COLORS } from '../charts/echarts-setup';
import styles from '../Results.module.css';

function decode(summary: ResultSummary, ref: SeriesRef | undefined) {
  if (!ref) return null;
  return { dates: refDates(summary, ref, ref.values.length), values: ref.values };
}

function lineOption(dates: string[], values: (number | null)[], name: string, color: string, unit: string, digits = 2) {
  return {
    grid: { left: 60, right: 20, top: 24, bottom: 60 },
    tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v === null || v === undefined ? 'N/A' : `${v.toFixed(digits)}${unit}`) },
    xAxis: { type: 'category', data: dates, boundaryGap: false },
    yAxis: { type: 'value', scale: true, axisLabel: { formatter: `{value}${unit}` } },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }],
    series: [{ name, type: 'line', data: values, showSymbol: false, sampling: 'lttb', lineStyle: { width: 1.3, color }, areaStyle: { color, opacity: 0.08 } }],
  };
}

export default function MarketTab({ summary }: { summary: ResultSummary }) {
  const market = summary.market ?? {};
  const [rfMode, setRfMode] = useState<'annual' | 'daily'>('annual');
  const vix = useMemo(() => decode(summary, market.vix), [summary, market.vix]);
  const rf = useMemo(() => decode(summary, market.rf_annual_pct), [summary, market.rf_annual_pct]);

  const vixOption = useMemo(() => (vix ? lineOption(vix.dates, vix.values, 'VIX', CHART_COLORS.orange, '') : null), [vix]);
  const rfOption = useMemo(() => {
    if (!rf) return null;
    if (rfMode === 'annual') return lineOption(rf.dates, rf.values, 'Taux annuel', CHART_COLORS.accent, '%', 3);
    const bps = rf.values.map((v) => (v === null ? null : ((1 + v / 100) ** (1 / 365.25) - 1) * 10000));
    return lineOption(rf.dates, bps, 'Taux quotidien', CHART_COLORS.accent, ' pb', 4);
  }, [rf, rfMode]);

  if (!vix && !rf) {
    return (
      <div className={`card ${styles.loadingCard}`}>
        {market.error ? `Données de marché indisponibles : ${market.error}` : 'Ce résultat ne contient pas de données de marché (runs antérieurs à la v2 ou ENGINE_MARKET_DATA=0).'}
      </div>
    );
  }

  const lastVix = vix ? [...vix.values].reverse().find((v) => v !== null) : null;
  const lastRf = rf ? [...rf.values].reverse().find((v) => v !== null) : null;

  return (
    <div className={styles.wideGrid}>
      {vixOption && (
        <div className="card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>VIX</div>
              <div className={styles.cardSub}>
                Indice de volatilité sur la période du backtest{market.vix_first ? ` · données depuis ${market.vix_first}` : ''} · dernier {lastVix?.toFixed(2) ?? 'N/A'}
              </div>
            </div>
          </div>
          <EChart option={vixOption} height={340} />
        </div>
      )}
      {rfOption && (
        <div className="card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>Taux sans risque</div>
              <div className={styles.cardSub}>
                Source {market.rf_symbol ?? 'Treasury'} · utilisé par le moteur pour le cash rémunéré · dernier {lastRf !== null && lastRf !== undefined ? `${lastRf.toFixed(3)}%` : 'N/A'}
              </div>
            </div>
            <div className={styles.segment}>
              <button type="button" className={rfMode === 'annual' ? styles.segOn : ''} onClick={() => setRfMode('annual')}>Annuel %</button>
              <button type="button" className={rfMode === 'daily' ? styles.segOn : ''} onClick={() => setRfMode('daily')}>Quotidien (pb)</button>
            </div>
          </div>
          <EChart option={rfOption} height={340} />
        </div>
      )}
    </div>
  );
}
