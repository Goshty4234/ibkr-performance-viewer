'use client';

import { useEffect, useMemo, useState } from 'react';
import DrawdownChart from '@/components/DrawdownChart';
import PerformanceChart from '@/components/PerformanceChart';
import { type ChartsResult, FOCUSED_COLUMNS, FOCUSED_DEFINITIONS, formatFocused, type FocusedRow } from '@/lib/backtest/analytics';
import { portfolioColor } from '@/lib/backtest/chart-data';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { useAnalytics } from '@/lib/backtest/worker/use-analytics';
import type { ChartBrushSelection } from '@/lib/chart-range';
import type { PortfolioSummaryOk } from '@/lib/engine/types';
import DataGrid, { type GridColumn } from '../grid/DataGrid';
import { ColumnDefinitions } from '../StatsTable';
import styles from '../Results.module.css';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const PRESETS: { label: string; years: number | null }[] = [
  { label: '1 an', years: 1 },
  { label: '3 ans', years: 3 },
  { label: '5 ans', years: 5 },
  { label: '10 ans', years: 10 },
  { label: 'Tout', years: null },
];

export default function FocusedTab({
  result,
  portfolios,
  hidden,
  onToggle,
  benchmarks,
}: {
  result: LoadedResult;
  portfolios: PortfolioSummaryOk[];
  hidden: Set<string>;
  onToggle: (id: string) => void;
  benchmarks: string[];
}) {
  const bounds = useMemo(() => {
    const d = result.summary.dates;
    if (d.length) return { min: d[0], max: d[d.length - 1] };
    const all = portfolios.flatMap((p) => (p.series.dates ? [p.series.dates[0], p.series.dates[p.series.dates.length - 1]] : []));
    all.sort();
    return { min: all[0] ?? '', max: all[all.length - 1] ?? '' };
  }, [result, portfolios]);
  const [start, setStart] = useState(bounds.min);
  const [end, setEnd] = useState(bounds.max);
  const [essential, setEssential] = useState(false);
  useEffect(() => {
    setStart(bounds.min);
    setEnd(bounds.max);
  }, [bounds]);

  const range = useDebounced({ start, end }, 250);
  const valid = !!range.start && !!range.end && range.start <= range.end;
  const { data, loading, error } = useAnalytics<FocusedRow[]>(result, valid ? { op: 'focused', start: range.start, end: range.end } : null);

  // Curves over the chosen period only: everything restarts at 0 % on its first day (drawdown included).
  const charts = useAnalytics<ChartsResult>(
    result,
    valid ? { op: 'rangeCharts', mode: 'no_additions', benchmarks, start: range.start, end: range.end } : null,
  );
  const [brush, setBrush] = useState<ChartBrushSelection | null>(null);
  const benchSig = benchmarks.join(',');
  useEffect(() => {
    setBrush(null);
  }, [range.start, range.end, benchSig]);
  const cd = charts.data?.charts ?? null;
  const firstDay = cd?.pctData[0]?.date;
  const lastDay = cd?.pctData[cd.pctData.length - 1]?.date;

  const columns = useMemo<GridColumn<FocusedRow>[]>(() => {
    const cols = FOCUSED_COLUMNS.filter((c) => !essential || c.essential);
    return [
      {
        key: 'name',
        label: 'Portfolio',
        width: 230,
        value: (r) => r.name,
        format: (_v, r) => (
          <span className={styles.nameCell} title={r.name}>
            <span className={styles.swatchBtn} style={{ borderColor: portfolioColor(r.index), background: portfolioColor(r.index) }} />
            <span className={styles.nameText}>{r.name}</span>
          </span>
        ),
      },
      ...cols.map<GridColumn<FocusedRow>>((c) => ({
        key: c.key,
        label: c.label,
        title: FOCUSED_DEFINITIONS[c.key],
        width: c.key === 'finalValueNoContrib' ? 170 : Math.max(100, c.label.length * 7.5 + 24),
        align: 'right',
        value: (r) => {
          const v = r[c.key];
          return Number.isNaN(v) ? null : v === Infinity ? Number.MAX_VALUE : v;
        },
        format: (_v, r) => formatFocused(r[c.key], c.fmt),
      })),
    ];
  }, [essential]);

  const setPreset = (years: number | null) => {
    setEnd(bounds.max);
    if (years === null) {
      setStart(bounds.min);
      return;
    }
    const d = new Date(`${bounds.max}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    const s = d.toISOString().slice(0, 10);
    setStart(s < bounds.min ? bounds.min : s);
  };

  return (
    <>
      <div className="card">
        <div className={styles.cardHead}>
          <div>
            <div className={styles.cardTitle}>Analyse ciblée</div>
            <div className={styles.cardSub}>
              Choisis une période : les courbes repartent de 0 % au premier jour et les métriques sont recalculées sur cette période
              (série sans ajouts, taux sans risque 2 %) · calcul instantané
            </div>
          </div>
        </div>
        <div className={styles.toolbarRow}>
          <label className={styles.inlineField}>
            Début
            <input type="date" className="input" value={start} min={bounds.min} max={bounds.max} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className={styles.inlineField}>
            Fin
            <input type="date" className="input" value={end} min={bounds.min} max={bounds.max} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className={styles.segment}>
            {PRESETS.map((p) => (
              <button key={p.label} type="button" onClick={() => setPreset(p.years)}>{p.label}</button>
            ))}
          </div>
          <label className={styles.inlineCheck}>
            <input type="checkbox" checked={essential} onChange={(e) => setEssential(e.target.checked)} />
            Métriques essentielles seulement
          </label>
          {brush && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              title="Les courbes et les métriques repartent de 0 % au début de la sélection"
              onClick={() => {
                setStart(brush.startDate);
                setEnd(brush.endDate);
                setBrush(null);
              }}
            >
              Utiliser la sélection ({brush.startDate} → {brush.endDate})
            </button>
          )}
          {(loading || charts.loading) && <span className={styles.muted}>Calcul…</span>}
        </div>
        {!valid && <div className={styles.padded}>La date de début doit précéder la date de fin.</div>}
      </div>

      {valid && (
        <div className="card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>Métriques sur la période</div>
              <div className={styles.cardSub}>{range.start} → {range.end}</div>
            </div>
          </div>
          {error ? (
            <div className={styles.padded}>{error}</div>
          ) : (
            <div className={styles.padded}>
              <DataGrid
                columns={columns}
                rows={data ?? []}
                rowKey={(r) => r.index}
                maxHeight={620}
                csvName={`analyse-ciblee-${range.start}-${range.end}`}
                empty={loading ? 'Calcul…' : 'Aucun portfolio n’a assez de données sur cette période.'}
              />
              <ColumnDefinitions
                columns={FOCUSED_COLUMNS.filter((c) => !essential || c.essential).map((c) => ({ label: c.label, title: FOCUSED_DEFINITIONS[c.key] }))}
              />
            </div>
          )}
        </div>
      )}

      {valid &&
        (cd ? (
          <div className={styles.chartStack}>
            <PerformanceChart
              series={cd.defs}
              data={cd.pctData}
              hidden={hidden}
              onToggleSeries={onToggle}
              brush={brush}
              onBrushChange={setBrush}
              loading={false}
              hasStatements
              noDataInRange={cd.pctData.length === 0}
              stacked
              logToggle
              title="Performance cumulée sur la période (sans ajouts)"
              subtitle={
                firstDay && lastDay
                  ? `Tous les portfolios partent de 0 % le ${firstDay} · jusqu’au ${lastDay} · benchmarks en pointillés`
                  : 'Série « no_additions » du moteur · 0 % au premier jour de la période'
              }
              hint="Cliquez-glissez pour mesurer une sous-période, puis « Utiliser la sélection » pour repartir de 0 % sur cette sous-période · Échap pour effacer."
            />
            <DrawdownChart series={cd.defs} data={cd.pctData} hidden={hidden} loading={false} show stacked />
          </div>
        ) : (
          <div className={`card ${styles.loadingCard}`}>{charts.error ?? 'Préparation des graphiques…'}</div>
        ))}
    </>
  );
}
