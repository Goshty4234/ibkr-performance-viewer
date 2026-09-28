'use client';

import { useMemo, useState } from 'react';
import DrawdownChart from '@/components/DrawdownChart';
import PerformanceChart from '@/components/PerformanceChart';
import { symLog, type ChartsResult, type OverviewResult } from '@/lib/backtest/analytics';
import { portfolioColor, portfolioSeriesId } from '@/lib/backtest/chart-data';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { useAnalytics } from '@/lib/backtest/worker/use-analytics';
import type { ChartBrushSelection } from '@/lib/chart-range';
import type { PortfolioSummaryOk } from '@/lib/engine/types';
import EChart from '../charts/EChart';
import { CHART_COLORS } from '../charts/echarts-setup';
import StatsTable from '../StatsTable';
import ValueChart from '../ValueChart';
import styles from '../Results.module.css';

const METRICS: { key: keyof OverviewResult['variation'][number]; label: string; color: string }[] = [
  { key: 'totalReturn', label: 'Total Return', color: '#1f77b4' },
  { key: 'cagr', label: 'CAGR', color: '#2ca02c' },
  { key: 'volatility', label: 'Volatility', color: '#ff7f0e' },
  { key: 'maxDrawdown', label: 'Max Drawdown', color: '#d62728' },
];

function VariationChart({ data, hidden }: { data: OverviewResult['variation']; hidden: Set<string> }) {
  const rows = data.filter((r) => !hidden.has(portfolioSeriesId(r.index)));
  const option = useMemo(() => ({
    grid: { left: 24, right: 16, top: 40, bottom: 90, containLabel: false },
    legend: { top: 4, right: 8 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (items: { seriesIndex: number; dataIndex: number; name: string }[]) => {
        if (!items.length) return '';
        const r = rows[items[0].dataIndex];
        return [`<b>${r.name}</b>`, ...METRICS.map((m) => `${m.label}: ${Number.isFinite(r[m.key] as number) ? (r[m.key] as number).toFixed(2) + '%' : 'N/A'}`)].join('<br/>');
      },
    },
    xAxis: { type: 'category', data: rows.map((r) => r.name), axisLabel: { rotate: rows.length > 6 ? 35 : 0, interval: 0, width: 140, overflow: 'truncate' } },
    yAxis: { type: 'value', axisLabel: { show: false }, name: 'Percent (échelle log)', nameTextStyle: { color: CHART_COLORS.faint } },
    series: METRICS.map((m) => ({
      name: m.label,
      type: 'bar',
      itemStyle: { color: m.color },
      data: rows.map((r) => {
        const v = r[m.key] as number;
        return Number.isFinite(v) ? symLog(v) : null;
      }),
      label: {
        show: rows.length <= 8,
        position: 'top',
        fontSize: 10,
        color: CHART_COLORS.text,
        formatter: (p: { dataIndex: number }) => {
          const v = rows[p.dataIndex][m.key] as number;
          return Number.isFinite(v) ? `${v.toFixed(1)}%` : 'N/A';
        },
      },
    })),
  }), [rows]);
  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Résumé des variations</div>
          <div className={styles.cardSub}>Rendement total, CAGR, volatilité et drawdown max (série sans ajouts) · barres en échelle log symétrique comme dans Streamlit</div>
        </div>
      </div>
      <EChart option={option} height={420} />
    </div>
  );
}

function Heatmap({ data }: { data: OverviewResult['heatmap'] }) {
  const option = useMemo(() => {
    const bound = Math.max(Math.abs(data.min), Math.abs(data.max)) || 1;
    return {
      grid: { left: 150, right: 70, top: 10, bottom: 60 },
      tooltip: {
        formatter: (p: { value: [number, number, number] }) =>
          `${data.rows[p.value[1]].name}<br/>${data.months[p.value[0]]} : <b>${p.value[2].toFixed(2)}%</b>`,
      },
      xAxis: { type: 'category', data: data.months, splitArea: { show: false } },
      yAxis: { type: 'category', data: data.rows.map((r) => r.name), inverse: true, axisLabel: { width: 140, overflow: 'truncate' } },
      visualMap: {
        min: -bound,
        max: bound,
        calculable: true,
        orient: 'vertical',
        right: 0,
        top: 'center',
        itemHeight: 160,
        textStyle: { color: CHART_COLORS.faint },
        inRange: { color: ['#a50026', '#f46d43', '#fee08b', '#d9ef8b', '#66bd63', '#006837'] },
        formatter: (v: number) => `${v.toFixed(0)}%`,
      },
      dataZoom: data.months.length > 120 ? [{ type: 'slider', xAxisIndex: 0, bottom: 8, height: 16 }, { type: 'inside', xAxisIndex: 0 }] : [],
      series: [{ type: 'heatmap', data: data.cells, progressive: 5000, emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } } }],
    };
  }, [data]);
  const height = Math.min(900, Math.max(220, data.rows.length * 22 + 90));
  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Heatmap des rendements mensuels</div>
          <div className={styles.cardSub}>Lignes = portfolios, colonnes = année-mois (série sans ajouts)</div>
        </div>
      </div>
      <EChart option={option} height={height} />
    </div>
  );
}

export default function OverviewTab({
  result,
  portfolios,
  hidden,
  onToggle,
  benchmarks,
  selected,
  onSelect,
}: {
  result: LoadedResult;
  portfolios: PortfolioSummaryOk[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  benchmarks: string[];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const [brush, setBrush] = useState<ChartBrushSelection | null>(null);
  const pct = useAnalytics<ChartsResult>(result, { op: 'charts', mode: 'no_additions', benchmarks });
  const withAdd = useAnalytics<ChartsResult>(result, { op: 'charts', mode: 'with_additions', benchmarks: [] });
  const overview = useAnalytics<OverviewResult>(result, { op: 'overview' });
  const colors = useMemo(() => Object.fromEntries(portfolios.map((p) => [p.index, portfolioColor(p.index)])), [portfolios]);
  const hasAdditions = useMemo(
    () => portfolios.some((p) => (p.stats['Total Money Added'] ?? 0) > (p.config.initial_value ?? 0) + 1e-6),
    [portfolios],
  );
  const charts = pct.data?.charts;

  return (
    <>
      <StatsTable portfolios={portfolios} colors={colors} hidden={hidden} onToggle={onToggle} selected={selected} onSelect={onSelect} />
      {charts ? (
        <>
          <PerformanceChart
            series={charts.defs}
            data={charts.pctData}
            hidden={hidden}
            onToggleSeries={onToggle}
            brush={brush}
            onBrushChange={setBrush}
            loading={false}
            hasStatements
            stacked
            title="Performance cumulée (sans ajouts)"
            subtitle="Série « no_additions » du moteur · base 0 % au début · benchmarks en pointillés"
            hint="Cliquez-glissez pour mesurer une sous-période · simple clic ou Échap pour effacer."
          />
        </>
      ) : (
        <div className={`card ${styles.loadingCard}`}>{pct.error ?? 'Préparation des graphiques…'}</div>
      )}
      <div className={styles.wideGrid}>
        {charts && <DrawdownChart series={charts.defs} data={charts.pctData} hidden={hidden} loading={false} show stacked />}
        {withAdd.data && (
          <ValueChart
            data={withAdd.data.charts.valueData}
            series={withAdd.data.charts.defs}
            hidden={hidden}
            title={hasAdditions ? 'Valeur du portefeuille (avec ajouts)' : 'Valeur du portefeuille'}
            subtitle={hasAdditions ? 'Série « with_additions » : capital initial + versements périodiques' : 'Capital initial, sans versements'}
          />
        )}
      </div>
      {overview.data && (
        <>
          <VariationChart data={overview.data.variation} hidden={hidden} />
          {overview.data.heatmap.cells.length > 0 && <Heatmap data={overview.data.heatmap} />}
        </>
      )}
    </>
  );
}
