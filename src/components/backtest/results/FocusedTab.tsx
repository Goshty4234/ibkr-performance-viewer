'use client';

import { useEffect, useMemo, useState } from 'react';
import { FOCUSED_COLUMNS, formatFocused, type FocusedRow } from '@/lib/backtest/analytics';
import { portfolioColor } from '@/lib/backtest/chart-data';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { useAnalytics } from '@/lib/backtest/worker/use-analytics';
import type { PortfolioSummaryOk } from '@/lib/engine/types';
import DataGrid, { type GridColumn } from '../grid/DataGrid';
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

export default function FocusedTab({ result, portfolios }: { result: LoadedResult; portfolios: PortfolioSummaryOk[] }) {
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

  const columns = useMemo<GridColumn<FocusedRow>[]>(() => {
    const cols = FOCUSED_COLUMNS.filter((c) => !essential || c.essential);
    return [
      {
        key: 'name',
        label: 'Portfolio',
        width: 230,
        value: (r) => r.name,
        format: (_v, r) => (
          <span className={styles.nameCell}>
            <span className={styles.swatchBtn} style={{ borderColor: portfolioColor(r.index), background: portfolioColor(r.index) }} />
            <span className={styles.nameText}>{r.name}</span>
          </span>
        ),
      },
      ...cols.map<GridColumn<FocusedRow>>((c) => ({
        key: c.key,
        label: c.label,
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
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Analyse ciblée</div>
          <div className={styles.cardSub}>
            Métriques de chaque portfolio sur la période choisie (série sans ajouts, taux sans risque 2 %) · calcul instantané
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
        {loading && <span className={styles.muted}>Calcul…</span>}
      </div>
      {!valid ? (
        <div className={styles.padded}>La date de début doit précéder la date de fin.</div>
      ) : error ? (
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
        </div>
      )}
    </div>
  );
}
