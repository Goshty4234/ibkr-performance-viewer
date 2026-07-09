'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseIbkrCsv } from '@/lib/ibkr';
import { dbToAccount } from '@/lib/account-mapper';
import { dbToStatement } from '@/lib/db-mapper';
import {
  alignBenchmark,
  buildPerformanceCurve,
  computeSummary,
  fetchBenchmark,
  getTimelineBounds,
  mergeStatements,
} from '@/lib/performance';
import { analyzeTimeline } from '@/lib/timeline';
import type {
  BenchmarkSymbol,
  DatePreset,
  DbStatement,
  PerformancePoint,
  PortfolioAccount,
} from '@/lib/types';
import { BENCHMARK_LABELS } from '@/lib/types';
import AccountManager from './AccountManager';
import DataPanel from './DataPanel';
import DateRangeControls from './DateRangeControls';
import StatsGrid from './StatsGrid';
import PerformanceChart from './PerformanceChart';
import TimelineStatus from './TimelineStatus';
import FileUpload from './FileUpload';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const [statements, setStatements] = useState<DbStatement[]>([]);
  const [accounts, setAccounts] = useState<PortfolioAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkSymbol>('SPY');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [activePreset, setActivePreset] = useState<DatePreset | null>('MAX');
  const [chartData, setChartData] = useState<PerformancePoint[]>([]);
  const [chartLoading, setChartLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [stmtRes, accRes] = await Promise.all([
      fetch('/api/statements'),
      fetch('/api/accounts'),
    ]);
    if (!stmtRes.ok) {
      setError('Erreur de chargement des données');
      setLoading(false);
      return;
    }
    const stmtData = await stmtRes.json();
    setStatements(stmtData.map(dbToStatement));

    if (accRes.ok) {
      const accData = await accRes.json();
      setAccounts(accData.map(dbToAccount));
    } else {
      const j = await accRes.json().catch(() => ({}));
      if (j.error) setError(`Comptes : ${j.error}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const filtered = useMemo(() => {
    if (accountFilter === 'all') return statements;
    return statements.filter((s) => s.accountId === accountFilter);
  }, [statements, accountFilter]);

  const rawFiltered = useMemo(() => {
    if (accountFilter === 'all') return statements;
    return statements.filter((s) => s.accountId === accountFilter);
  }, [statements, accountFilter]);

  const bounds = useMemo(() => getTimelineBounds(filtered), [filtered]);
  const merged = useMemo(() => mergeStatements(filtered), [filtered]);

  const accountLabel = useMemo(() => {
    if (accountFilter === 'all') return 'Tous les comptes';
    const acc = accounts.find((a) => a.ibkrAccountId === accountFilter);
    return acc?.displayName ?? accountFilter;
  }, [accountFilter, accounts]);

  const timelineHealth = useMemo(() => {
    if (!rangeStart || !rangeEnd) return null;
    return analyzeTimeline(merged, rangeStart, rangeEnd);
  }, [merged, rangeStart, rangeEnd]);

  useEffect(() => {
    if (bounds && !rangeStart) {
      setRangeStart(bounds.min);
      setRangeEnd(bounds.max);
      setActivePreset('MAX');
    }
  }, [bounds, rangeStart]);

  useEffect(() => {
    if (!bounds || !rangeStart || !rangeEnd || !filtered.length) {
      setChartData([]);
      return;
    }
    let cancelled = false;
    async function load() {
      setChartLoading(true);
      setError(null);
      try {
        const health = analyzeTimeline(merged, rangeStart, rangeEnd);
        if (!health.rangeCoverage?.hasAnyData) {
          setChartData([]);
          return;
        }
        const effStart = health.rangeCoverage.availableStart ?? rangeStart;
        const effEnd = health.rangeCoverage.availableEnd ?? rangeEnd;
        const portfolio = buildPerformanceCurve(filtered, effStart, effEnd);
        if (!portfolio.length) { setChartData([]); return; }
        const prices = await fetchBenchmark(benchmark, effStart, effEnd);
        if (!cancelled) setChartData(alignBenchmark(portfolio, prices));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Erreur');
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [filtered, merged, benchmark, rangeStart, rangeEnd, bounds]);

  const summary = useMemo(() => {
    if (!chartData.length || !rangeStart || !rangeEnd) return null;
    const effStart = timelineHealth?.rangeCoverage?.availableStart ?? rangeStart;
    const effEnd = timelineHealth?.rangeCoverage?.availableEnd ?? rangeEnd;
    return computeSummary(chartData, effStart, effEnd);
  }, [chartData, rangeStart, rangeEnd, timelineHealth]);

  async function handleFiles(files: FileList) {
    setUploading(true);
    setError(null);
    setNotice(null);
    const errs: string[] = [];
    const notes: string[] = [];
    let count = 0;

    try {
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.csv')) continue;
      try {
        const parsed = parseIbkrCsv(await file.text(), file.name);
        const res = await fetch('/api/statements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Erreur sauvegarde');
        count++;
        if (j.meta?.replaced > 0) {
          notes.push(`${file.name} : ${j.meta.replaced} chevauchement(s) remplacé(s)`);
        }
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : 'erreur'}`);
      }
    }

    if (count > 0) await loadAll();
    if (notes.length) setNotice(notes.join(' · '));
    if (errs.length) setError(errs.join(' · '));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur à l\'import');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Supprimer cette période de la base de données ?')) return;
    const res = await fetch(`/api/statements?id=${id}`, { method: 'DELETE' });
    if (res.ok) await loadAll();
  }

  async function handleDeleteRange(accId: string, start: string, end: string) {
    const res = await fetch(
      `/api/statements?accountId=${encodeURIComponent(accId)}&rangeStart=${start}&rangeEnd=${end}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const j = await res.json();
      setError(j.error || 'Erreur suppression');
      return;
    }
    await loadAll();
  }

  function handleRangeChange(start: string, end: string) {
    setRangeStart(start);
    setRangeEnd(end);
    setActivePreset(null);
  }

  return (
    <div className={styles.app}>
      <div className={styles.pageHeader}>
        <h1>Tableau de bord</h1>
        <p className={styles.pageSub}>
          Gérez vos comptes, importez vos CSV et analysez votre performance TWRR.
        </p>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}

      <AccountManager
        accounts={accounts}
        selectedId={accountFilter}
        onSelect={setAccountFilter}
        onRefresh={loadAll}
        onAccountCreated={(acc) => {
          setAccounts((prev) => {
            const rest = prev.filter((a) => a.ibkrAccountId !== acc.ibkrAccountId);
            return [...rest, { ...acc, statementCount: 0 }];
          });
          setAccountFilter(acc.ibkrAccountId);
          setNotice(`Compte « ${acc.displayName} » sélectionné — glissez un CSV dans la zone ci-dessous.`);
        }}
      />

      {accountFilter !== 'all' && (
        <div className={styles.activeAccount}>
          <span className={styles.activeLabel}>Compte actif</span>
          <strong>{accountLabel}</strong>
          <button type="button" className={styles.viewAllBtn} onClick={() => setAccountFilter('all')}>
            Voir tous
          </button>
        </div>
      )}

      <FileUpload onFiles={handleFiles} uploading={uploading} accountHint={accountLabel} />

      {!loading && filtered.length === 0 && statements.length > 0 && accountFilter !== 'all' && (
        <div className={styles.emptyState}>
          <strong>Aucune donnée pour ce compte.</strong> Importez un CSV dont l&apos;ID IBKR correspond à « {accountLabel} ».
        </div>
      )}

      {!loading && statements.length === 0 && (
        <div className={styles.emptyState}>
          <strong>Étape suivante :</strong> glissez votre Activity Statement IBKR (fichier .csv) dans la zone ci-dessus.
          Le compte et les données seront créés automatiquement.
        </div>
      )}

      {loading ? (
        <p className={styles.loading}>Chargement de vos données…</p>
      ) : (
        <>
          <DataPanel
            statements={rawFiltered}
            navSeries={null}
            accountId={accountFilter}
            accountLabel={accountLabel}
            onDelete={handleDelete}
            onDeleteNavSeries={async () => {}}
            onDeleteRange={handleDeleteRange}
          />

          {bounds && (
            <div className={styles.controls}>
              <div className={styles.ctrlFull}>
                <label>Période d&apos;analyse</label>
                <DateRangeControls
                  bounds={bounds}
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  activePreset={activePreset}
                  onPreset={setActivePreset}
                  onRangeChange={handleRangeChange}
                />
              </div>
              <div className={styles.ctrl}>
                <label>Benchmark</label>
                <select value={benchmark} onChange={(e) => setBenchmark(e.target.value as BenchmarkSymbol)}>
                  {(Object.keys(BENCHMARK_LABELS) as BenchmarkSymbol[]).map((k) => (
                    <option key={k} value={k}>{BENCHMARK_LABELS[k]}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {timelineHealth && <TimelineStatus health={timelineHealth} />}

          {summary && <StatsGrid summary={summary} benchmark={benchmark} />}

          <PerformanceChart
            data={chartData}
            benchmark={benchmark}
            loading={chartLoading}
            hasStatements={filtered.length > 0}
            noDataInRange={timelineHealth?.rangeCoverage?.hasAnyData === false}
          />
        </>
      )}
    </div>
  );
}
