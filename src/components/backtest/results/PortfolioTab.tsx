'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import type { HoldingsTable, MetricsColumns, PortfolioDetail, PortfolioSummaryOk } from '@/lib/engine/types';
import AllocationPanel from '../AllocationPanel';
import DataGrid, { type GridColumn } from '../grid/DataGrid';
import { money, qty } from './format';
import TaxPanel from './TaxPanel';
import styles from '../Results.module.css';

function inRange(date: string, start: string, end: string): boolean {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

const PCT_FIELDS = /weight|allocation|return|momentum|vol|drawdown/i;

function fmtMetric(field: string, v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return 'N/A';
  if (field === 'Beta') return v.toFixed(2);
  if (/weight|^momentum$|^volatility$/i.test(field)) return `${(v * 100).toFixed(2)}%`;
  if (PCT_FIELDS.test(field)) return Math.abs(v) < 5 ? v.toFixed(4) : v.toFixed(2);
  return Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toFixed(4);
}

function MetricsSection({ metrics, start, end }: { metrics: MetricsColumns; start: string; end: string }) {
  const dates = useMemo(() => metrics.dates.filter((d) => inRange(d, start, end)), [metrics, start, end]);
  const [date, setDate] = useState<string>('');
  const [allDates, setAllDates] = useState(false);
  useEffect(() => {
    setDate(dates[dates.length - 1] ?? '');
    setAllDates(false);
  }, [dates]);
  const dIdx = metrics.dates.indexOf(date);

  type Row = { k: number };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let k = 0; k < metrics.date_idx.length; k++) {
      const d = metrics.dates[metrics.date_idx[k]];
      if (!inRange(d, start, end)) continue;
      if (allDates || metrics.date_idx[k] === dIdx) out.push({ k });
    }
    return out;
  }, [metrics, dIdx, allDates, start, end]);

  const columns = useMemo<GridColumn<Row>[]>(() => {
    const cols: GridColumn<Row>[] = [];
    if (allDates) cols.push({ key: '_date', label: 'Date', width: 104, value: (r) => metrics.dates[metrics.date_idx[r.k]] });
    cols.push({ key: '_ticker', label: 'Ticker', width: 100, value: (r) => metrics.tickers[metrics.ticker_idx[r.k]] });
    for (const f of metrics.fields) {
      const col = metrics.values[f];
      cols.push({
        key: f,
        label: f.replace(/_/g, ' '),
        width: Math.max(110, f.length * 7 + 24),
        align: 'right',
        value: (r) => col[r.k] ?? null,
        format: (v) => fmtMetric(f, v),
        cellStyle: /^momentum$/i.test(f)
          ? (v) => (typeof v === 'number' && Number.isFinite(v) ? { color: v > 0 ? 'var(--green)' : 'var(--red)' } : undefined)
          : undefined,
      });
    }
    return cols;
  }, [metrics, allDates]);

  const recentDates = useMemo(() => [...dates].reverse(), [dates]);
  const weightField = metrics.fields.find((f) => f === 'Calculated_Weight');

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Métriques de momentum</div>
          <div className={styles.cardSub}>
            Scores calculés à chaque rebalancement ({metrics.dates.length.toLocaleString('fr-CA')} dates
            {metrics.truncated ? ', historique tronqué aux dates les plus récentes' : ''})
          </div>
        </div>
      </div>
      <div className={styles.padded}>
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(r) => r.k}
          maxHeight={520}
          csvName="metriques-momentum"
          initialSort={weightField ? { key: weightField, dir: 'desc' } : null}
          toolbar={
            <>
              <select className={styles.select} value={date} disabled={allDates} onChange={(e) => setDate(e.target.value)}>
                {recentDates.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <label className={styles.inlineCheck}>
                <input type="checkbox" checked={allDates} onChange={(e) => setAllDates(e.target.checked)} />
                Toutes les dates
              </label>
            </>
          }
        />
      </div>
    </div>
  );
}

export function AllocationHistorySection({
  allocations,
  start = '',
  end = '',
}: {
  allocations: NonNullable<PortfolioDetail['allocations']>;
  start?: string;
  end?: string;
}) {
  const [query, setQuery] = useState('');
  type Row = { i: number };
  const tickers = useMemo(() => {
    const ts = Object.keys(allocations.weights).filter((t) => allocations.weights[t].some((v) => (v ?? 0) !== 0));
    return [...ts.filter((t) => t !== 'CASH').sort(), ...ts.filter((t) => t === 'CASH')];
  }, [allocations]);
  const q = query.trim().toUpperCase();
  const shown = useMemo(
    () => (q ? tickers.filter((t) => t.toUpperCase().includes(q)) : tickers),
    [tickers, q],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = allocations.dates.length - 1; i >= 0; i--) {
      if (inRange(allocations.dates[i], start, end)) out.push({ i });
    }
    return out;
  }, [allocations, start, end]);
  const columns = useMemo<GridColumn<Row>[]>(() => [
    { key: 'date', label: 'Date', width: 104, value: (r) => allocations.dates[r.i] },
    ...shown.map<GridColumn<Row>>((t) => ({
      key: t,
      label: t,
      width: 96,
      align: 'right',
      value: (r) => (allocations.weights[t][r.i] ?? 0) * 100,
      format: (v) => `${(v as number).toFixed(0)}%`,
      cellStyle: t === 'CASH' ? () => ({ background: 'rgba(0, 100, 0, 0.35)' }) : undefined,
    })),
  ], [allocations, shown]);
  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Allocations historiques</div>
          <div className={styles.cardSub}>
            {shown.length.toLocaleString('fr-CA')} titre{shown.length > 1 ? 's' : ''}
            {q ? ` sur ${tickers.length.toLocaleString('fr-CA')}` : ''}
            {' · '}
            {rows.length.toLocaleString('fr-CA')} date{rows.length > 1 ? 's' : ''}, plus récentes en premier
          </div>
        </div>
      </div>
      <div className={styles.padded}>
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(r) => r.i}
          maxHeight={480}
          csvName="allocations-historiques"
          empty={q ? `Aucun ticker ne contient « ${query.trim()} ».` : 'Aucune date sur cette période.'}
          toolbar={
            <input
              className="input"
              style={{ width: 200 }}
              placeholder="Ticker, ex. AAPL"
              aria-label="Filtrer les tickers"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          }
        />
      </div>
    </div>
  );
}

function HoldingsSection({ holdings, start, end }: { holdings: HoldingsTable; start: string; end: string }) {
  const [mode, setMode] = useState<'shares' | 'values'>('shares');
  type Row = { i: number };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = holdings.dates.length - 1; i >= 0; i--) {
      if (inRange(holdings.dates[i], start, end)) out.push({ i });
    }
    return out;
  }, [holdings, start, end]);
  const columns = useMemo<GridColumn<Row>[]>(() => {
    const src = mode === 'shares' ? holdings.shares : holdings.values;
    const cols: GridColumn<Row>[] = [{ key: 'date', label: 'Date', width: 104, value: (r) => holdings.dates[r.i] }];
    holdings.tickers.forEach((t, j) => {
      cols.push({
        key: t,
        label: t,
        width: 110,
        align: 'right',
        value: (r) => src[r.i]?.[j] ?? null,
        format: (v) => (mode === 'shares' ? qty(v as number, 2) : money(v as number)),
      });
    });
    if (mode === 'values') {
      cols.push({
        key: '_total', label: 'Total', width: 130, align: 'right',
        value: (r) => (src[r.i] ?? []).reduce<number>((a, v) => a + (v ?? 0), 0), format: (v) => money(v as number),
      });
    }
    return cols;
  }, [holdings, mode]);
  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Actions détenues</div>
          <div className={styles.cardSub}>À chaque date de rebalancement ({holdings.frequency}) · nombre d&apos;actions ou valeur par titre</div>
        </div>
        <div className={styles.segment}>
          <button type="button" className={mode === 'shares' ? styles.segOn : ''} onClick={() => setMode('shares')}>Actions</button>
          <button type="button" className={mode === 'values' ? styles.segOn : ''} onClick={() => setMode('values')}>Valeurs</button>
        </div>
      </div>
      <div className={styles.padded}>
        <DataGrid columns={columns} rows={rows} rowKey={(r) => r.i} maxHeight={480} csvName={`actions-${mode}`} />
      </div>
    </div>
  );
}

export default function PortfolioTab({
  result,
  portfolios,
  selected,
  onSelect,
}: {
  result: LoadedResult;
  portfolios: PortfolioSummaryOk[];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const bounds = useMemo(() => {
    const d = result.summary.dates;
    if (d.length) return { min: d[0], max: d[d.length - 1] };
    return { min: '', max: '' };
  }, [result]);
  const [start, setStart] = useState(bounds.min);
  const [end, setEnd] = useState(bounds.max);
  useEffect(() => {
    setStart(bounds.min);
    setEnd(bounds.max);
  }, [bounds.min, bounds.max]);
  const p = portfolios.find((x) => x.index === selected) ?? portfolios[0];
  const { detail, loading, error } = usePortfolioDetail(result, p?.index ?? null);
  if (!p) return null;
  const errs = detail?.analytics_errors ? Object.keys(detail.analytics_errors).filter((k) => !k.startsWith('_')) : [];

  return (
    <>
      <AllocationPanel
        result={result}
        portfolios={portfolios}
        selected={p.index}
        onSelect={onSelect}
        start={start}
        end={end}
        onRange={(s, e) => { setStart(s); setEnd(e); }}
      />
      {loading && !detail && <div className={`card ${styles.loadingCard}`}>Chargement du détail de {p.name}…</div>}
      {error && <div className={`card ${styles.loadingCard}`}>{error}</div>}
      {errs.length > 0 && (
        <div className={styles.inlineWarn}>Certaines analyses ont échoué pour ce portfolio : {errs.join(', ')}</div>
      )}
      {detail?.allocations && detail.allocations.dates.length > 0 && (
        <AllocationHistorySection allocations={detail.allocations} start={start} end={end} />
      )}
      {detail?.metrics && detail.metrics.dates.length > 0 && <MetricsSection metrics={detail.metrics} start={start} end={end} />}
      {detail?.holdings && detail.holdings.dates.length > 0 && <HoldingsSection holdings={detail.holdings} start={start} end={end} />}
      {detail && <TaxPanel gains={detail.gains} tax={detail.tax_acb} />}
    </>
  );
}
