'use client';

import { useMemo, useState } from 'react';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import type { PortfolioDetail, PortfolioSummaryOk } from '@/lib/engine/types';
import EChart from '../charts/EChart';
import { CHART_COLORS } from '../charts/echarts-setup';
import { num } from './format';
import styles from '../Results.module.css';

interface PeSeries {
  dates: string[];
  values: (number | null)[];
  /** Streamlit "Multi-portfolio PE": Σ(pe·w) / Σw over every allocation date. */
  historicalAvg: number | null;
}

/** Same as Streamlit's PE Evolution: current trailing PE applied to every daily allocation. */
function peSeries(detail: PortfolioDetail, pe: Record<string, number | null>): PeSeries | null {
  const { dates, weights } = detail.allocations ?? { dates: [], weights: {} };
  const tickers = Object.keys(weights).filter((t) => t !== 'CASH');
  if (!dates.length || !tickers.length) return null;
  const values: (number | null)[] = [];
  let totPe = 0;
  let totW = 0;
  for (let i = 0; i < dates.length; i++) {
    let stock = 0;
    let wPe = 0;
    let wSum = 0;
    for (const t of tickers) {
      const w = weights[t][i] ?? 0;
      const v = pe[t];
      if (v && v > 0) {
        totPe += v * w;
        totW += w;
      }
      if (!(w > 0)) continue;
      stock += w;
      if (v && v > 0) {
        wPe += v * w;
        wSum += w;
      }
    }
    values.push(stock === 0 || wSum === 0 ? null : wPe / wSum);
  }
  return { dates, values, historicalAvg: totW > 0 ? totPe / totW : null };
}

function stats(values: (number | null)[]) {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const std = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { last: v[v.length - 1], median, mean, std };
}

const BANDS: { k: number; up: string; down: string; type: 'dashed' | 'dotted' | 'solid' }[] = [
  { k: 1, up: '#22d3ee', down: '#4ade80', type: 'dashed' },
  { k: 2, up: '#ff6b7a', down: '#a3e635', type: 'dotted' },
  { k: 3, up: '#b91c1c', down: '#15803d', type: 'solid' },
];

export default function PeEvolution({
  result,
  portfolios,
  pe,
}: {
  result: LoadedResult;
  portfolios: PortfolioSummaryOk[];
  pe: Record<string, number | null>;
}) {
  const [index, setIndex] = useState<number>(portfolios[0]?.index ?? 0);
  const { detail, loading, error } = usePortfolioDetail(result, index);
  const series = useMemo(() => (detail ? peSeries(detail, pe) : null), [detail, pe]);
  const st = useMemo(() => (series ? stats(series.values) : null), [series]);

  const option = useMemo(() => {
    if (!series || !st) return null;
    const lines = [
      { name: `Médiane ${num(st.median)}`, yAxis: st.median, lineStyle: { color: '#4d8dff', type: 'dashed' } },
      { name: `Moyenne ${num(st.mean)}`, yAxis: st.mean, lineStyle: { color: '#c084fc', type: 'dotted' } },
      ...BANDS.flatMap((b) => [
        { name: `+${b.k}σ`, yAxis: st.mean + b.k * st.std, lineStyle: { color: b.up, type: b.type } },
        { name: `-${b.k}σ`, yAxis: st.mean - b.k * st.std, lineStyle: { color: b.down, type: b.type } },
      ]),
    ];
    return {
      grid: { left: 56, right: 90, top: 30, bottom: 60 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v === null || v === undefined ? 'cash' : v.toFixed(2)) },
      xAxis: { type: 'category', data: series.dates, boundaryGap: false },
      yAxis: { type: 'value', scale: true, name: 'PER' },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }],
      series: [{
        name: 'PER pondéré',
        type: 'line',
        data: series.values,
        showSymbol: false,
        connectNulls: false,
        sampling: 'lttb',
        lineStyle: { width: 2, color: '#00ff88' },
        markLine: {
          symbol: 'none',
          silent: true,
          label: { position: 'end', formatter: (p: { name: string }) => p.name, color: CHART_COLORS.text, fontSize: 10 },
          data: lines,
        },
      }],
    };
  }, [series, st]);

  const lastDate = series?.dates[series.dates.length - 1];
  const daysBehind = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86_400_000) : 0;

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Évolution du PER</div>
          <div className={styles.cardSub}>
            PER actuel de chaque titre pondéré par l&apos;allocation de chaque jour (cash exclu) · même calcul que Streamlit
            {series ? ` · ${series.dates[0]} → ${lastDate}` : ''}
          </div>
        </div>
        <select className={styles.select} value={index} onChange={(e) => setIndex(Number(e.target.value))}>
          {portfolios.map((p) => <option key={p.index} value={p.index}>{p.name}</option>)}
        </select>
      </div>
      {daysBehind > 7 && (
        <div className={styles.toolbarRow}>
          <span className={styles.inlineWarn}>Les allocations ont {daysBehind} jours de retard : relance le backtest pour les PER les plus récents.</span>
        </div>
      )}
      {st && (
        <div className={styles.kpis}>
          <div><span>Dernier PER</span><strong>{num(st.last)}</strong></div>
          <div><span>Médiane</span><strong>{num(st.median)}</strong></div>
          <div><span>Moyenne</span><strong>{num(st.mean)}</strong></div>
          <div><span>Écart-type</span><strong>{num(st.std)}</strong></div>
          <div title="Σ(PER × poids) / Σ poids sur toutes les dates (graphique « Multi-portfolio PE » de Streamlit)">
            <span>PER moyen historique</span><strong>{num(series?.historicalAvg ?? null)}</strong>
          </div>
        </div>
      )}
      {loading && !detail ? (
        <div className={styles.padded}>Chargement des allocations…</div>
      ) : error ? (
        <div className={styles.padded}>{error}</div>
      ) : option ? (
        <EChart option={option} height={420} />
      ) : (
        <div className={styles.padded}>Aucun titre avec un PER disponible dans ce portfolio.</div>
      )}
    </div>
  );
}
