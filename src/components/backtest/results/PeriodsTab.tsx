'use client';

import { useMemo, useState } from 'react';
import type { PeriodKind, PeriodsResult, RobustRow } from '@/lib/backtest/analytics';
import { portfolioColor, portfolioSeriesId } from '@/lib/backtest/chart-data';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { useAnalytics } from '@/lib/backtest/worker/use-analytics';
import EChart from '../charts/EChart';
import DataGrid, { type GridColumn } from '../grid/DataGrid';
import { gradient, money, num, pct } from './format';
import styles from '../Results.module.css';

type PeriodRow = { k: number; label: string };

const MAX_CHART_PORTFOLIOS = 15;

function robustColumns(kind: PeriodKind): GridColumn<RobustRow>[] {
  const unit = kind === 'year' ? 'Years' : 'Months';
  const vol = kind === 'year' ? 'per-year from monthly %' : 'per-month from daily %';
  const p = (key: keyof RobustRow, label: string, title?: string, scale = 1): GridColumn<RobustRow> => ({
    key,
    label,
    title,
    width: Math.max(110, label.length * 7 + 20),
    align: 'right',
    value: (r) => {
      const v = r[key] as number;
      return Number.isNaN(v) ? null : v * scale;
    },
    format: (v) => pct(v as number),
  });
  return [
    { key: 'name', label: 'Portfolio', width: 220, value: (r) => r.name },
    { key: 'positives', label: `Positive ${unit}`, width: 120, align: 'right', value: (r) => r.positives },
    p('positivePct', `% Positive ${unit}`),
    p('mean', 'Mean % Change'),
    p('median', 'Median % Change'),
    p('std', 'Std % Change', 'Écart-type population (ddof=0)'),
    p('posMean', `Mean % (${unit} > 0)`),
    p('posMedian', `Median % (${unit} > 0)`),
    p('negMean', `Mean % (${unit} < 0)`),
    p('negMedian', `Median % (${unit} < 0)`),
    p('volMean', `Vol Mean (${vol})`, undefined, 100),
    p('volMedian', `Vol Median (${vol})`, undefined, 100),
    p('volAnnMean', 'Vol Mean (Annualized)', kind === 'year' ? '× √12' : '× √252', 100),
    p('volAnnMedian', 'Vol Median (Annualized)', kind === 'year' ? '× √12' : '× √252', 100),
    {
      key: 'betaMean', label: `Beta Mean (${kind === 'year' ? 'Yearly' : 'Monthly'})`, width: 150, align: 'right',
      value: (r) => (Number.isNaN(r.betaMean) ? null : r.betaMean), format: (v) => num(v as number, 3),
    },
    {
      key: 'betaMedian', label: `Beta Median (${kind === 'year' ? 'Yearly' : 'Monthly'})`, width: 160, align: 'right',
      value: (r) => (Number.isNaN(r.betaMedian) ? null : r.betaMedian), format: (v) => num(v as number, 3),
    },
  ];
}

export default function PeriodsTab({ result, hidden }: { result: LoadedResult; hidden: Set<string> }) {
  const [kind, setKind] = useState<PeriodKind>('year');
  const [showFinal, setShowFinal] = useState(true);
  const { data, loading, error } = useAnalytics<PeriodsResult>(result, { op: 'periods', kind });

  const visibleCols = useMemo(
    () => (data ? data.table.columns.filter((c) => !hidden.has(portfolioSeriesId(c.index))) : []),
    [data, hidden],
  );
  const rows = useMemo<PeriodRow[]>(() => (data ? data.table.labels.map((label, k) => ({ k, label })) : []), [data]);
  const columns = useMemo<GridColumn<PeriodRow>[]>(() => {
    const cols: GridColumn<PeriodRow>[] = [
      { key: 'label', label: kind === 'year' ? 'Année' : 'Mois', width: 90, value: (r) => r.label },
    ];
    // Headers carry the portfolio name: size columns to it (capped so 20+ portfolios stay usable).
    const fit = (label: string) => Math.min(280, Math.max(130, label.length * 7 + 28));
    for (const c of visibleCols) {
      cols.push({
        key: `p${c.index}`,
        label: `${c.name} % Change`,
        width: fit(`${c.name} % Change`),
        align: 'right',
        value: (r) => (Number.isNaN(c.pct[r.k]) ? null : c.pct[r.k]),
        format: (v) => pct(v as number),
        cellStyle: (v) => gradient(v as number, kind === 'year' ? 30 : 8),
      });
      if (showFinal) {
        cols.push({
          key: `f${c.index}`,
          label: `${c.name} Final Value`,
          width: fit(`${c.name} Final Value`),
          align: 'right',
          value: (r) => (Number.isNaN(c.final[r.k]) ? null : c.final[r.k]),
          format: (v) => money(v as number),
        });
      }
    }
    return cols;
  }, [visibleCols, kind, showFinal]);

  const robust = useMemo(
    () => (data ? data.robust.filter((r) => !hidden.has(portfolioSeriesId(r.index))) : []),
    [data, hidden],
  );

  const chartOption = useMemo(() => {
    if (!data || kind !== 'year') return null;
    const cols = visibleCols.slice(0, MAX_CHART_PORTFOLIOS);
    return {
      grid: { left: 56, right: 16, top: 40, bottom: 40 },
      legend: { top: 4, type: 'scroll' },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => (v === null || v === undefined ? 'N/A' : `${v.toFixed(2)}%`) },
      xAxis: { type: 'category', data: data.table.labels },
      yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
      dataZoom: data.table.labels.length > 40 ? [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 6 }] : [],
      series: cols.map((c) => ({
        name: c.name,
        type: 'bar',
        itemStyle: { color: portfolioColor(c.index) },
        data: Array.from(c.pct, (v) => (Number.isNaN(v) ? null : v)),
      })),
    };
  }, [data, kind, visibleCols]);

  return (
    <>
      <div className="card">
        <div className={styles.cardHead}>
          <div>
            <div className={styles.cardTitle}>{kind === 'year' ? 'Performance annuelle' : 'Performance mensuelle'}</div>
            <div className={styles.cardSub}>
              % de variation calculé sur la série sans ajouts (1re période depuis la valeur initiale) · valeur finale avec ajouts
            </div>
          </div>
          <div className={styles.toolbarInline}>
            <label className={styles.inlineCheck}>
              <input type="checkbox" checked={showFinal} onChange={(e) => setShowFinal(e.target.checked)} />
              Valeurs finales
            </label>
            <div className={styles.segment}>
              <button type="button" className={kind === 'year' ? styles.segOn : ''} onClick={() => setKind('year')}>Annuel</button>
              <button type="button" className={kind === 'month' ? styles.segOn : ''} onClick={() => setKind('month')}>Mensuel</button>
            </div>
          </div>
        </div>
        <div className={styles.padded}>
          {error ? (
            <div className={styles.muted}>{error}</div>
          ) : (
            <DataGrid
              columns={columns}
              rows={rows}
              rowKey={(r) => r.k}
              maxHeight={560}
              initialSort={null}
              csvName={kind === 'year' ? 'performance-annuelle' : 'performance-mensuelle'}
              empty={loading ? 'Calcul…' : 'Aucune donnée.'}
            />
          )}
        </div>
      </div>

      <div className="card">
        <div className={styles.cardHead}>
          <div>
            <div className={styles.cardTitle}>{kind === 'year' ? 'Statistiques robustes annuelles' : 'Statistiques robustes mensuelles'}</div>
            <div className={styles.cardSub}>
              Bêta calculé contre le benchmark du premier portfolio, sur les rendements quotidiens de chaque {kind === 'year' ? 'année' : 'mois'}
            </div>
          </div>
        </div>
        <div className={styles.padded}>
          <DataGrid columns={robustColumns(kind)} rows={robust} rowKey={(r) => r.index} maxHeight={480} csvName={`stats-robustes-${kind}`} />
        </div>
      </div>

      {chartOption && (
        <div className="card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>Rendements annuels</div>
              <div className={styles.cardSub}>
                {visibleCols.length > MAX_CHART_PORTFOLIOS ? `${MAX_CHART_PORTFOLIOS} premiers portfolios visibles` : 'Portfolios visibles'}
              </div>
            </div>
          </div>
          <EChart option={chartOption} height={380} />
        </div>
      )}
    </>
  );
}
