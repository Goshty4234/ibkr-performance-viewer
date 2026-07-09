'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { createClient } from '@/lib/supabase/client';
import { parseIbkrCsv } from '@/lib/ibkr';
import { dbToStatement } from '@/lib/db-mapper';
import {
  alignBenchmark,
  buildPerformanceCurve,
  computeSummary,
  fetchBenchmark,
  fmtPct,
  getTimelineBounds,
  getUniqueAccounts,
  mergeStatements,
} from '@/lib/performance';
import type { BenchmarkSymbol, DbStatement, PerformancePoint } from '@/lib/types';
import { BENCHMARK_LABELS } from '@/lib/types';
import Header from './Header';
import StatsGrid from './StatsGrid';
import PerformanceChart from './PerformanceChart';
import StatementList from './StatementList';
import FileUpload from './FileUpload';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  const [statements, setStatements] = useState<DbStatement[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkSymbol>('SPY');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [chartData, setChartData] = useState<PerformancePoint[]>([]);
  const [chartLoading, setChartLoading] = useState(false);

  const loadStatements = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/statements');
    if (!res.ok) { setError('Erreur de chargement'); setLoading(false); return; }
    const data = await res.json();
    setStatements(data.map(dbToStatement));
    setLoading(false);
  }, []);

  useEffect(() => { loadStatements(); }, [loadStatements]);

  const filtered = useMemo(() => {
    if (accountFilter === 'all') return statements;
    return statements.filter((s) => s.accountId === accountFilter);
  }, [statements, accountFilter]);

  const accounts = useMemo(() => getUniqueAccounts(statements), [statements]);
  const bounds = useMemo(() => getTimelineBounds(filtered), [filtered]);
  const merged = useMemo(() => mergeStatements(filtered), [filtered]);

  useEffect(() => {
    if (bounds && !rangeStart) {
      setRangeStart(bounds.min);
      setRangeEnd(bounds.max);
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
        const portfolio = buildPerformanceCurve(filtered, rangeStart, rangeEnd);
        if (!portfolio.length) { setChartData([]); return; }
        const prices = await fetchBenchmark(benchmark, rangeStart, rangeEnd);
        if (!cancelled) setChartData(alignBenchmark(portfolio, prices));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Erreur');
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [filtered, benchmark, rangeStart, rangeEnd, bounds]);

  const summary = useMemo(() => {
    if (!chartData.length || !rangeStart || !rangeEnd) return null;
    return computeSummary(chartData, rangeStart, rangeEnd);
  }, [chartData, rangeStart, rangeEnd]);

  async function handleFiles(files: FileList) {
    setUploading(true);
    setError(null);
    const errs: string[] = [];
    let count = 0;

    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.csv')) continue;
      try {
        const parsed = parseIbkrCsv(await file.text(), file.name);
        const res = await fetch('/api/statements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed),
        });
        if (!res.ok) {
          const j = await res.json();
          throw new Error(j.error || 'Erreur sauvegarde');
        }
        count++;
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : 'erreur'}`);
      }
    }

    if (count > 0) await loadStatements();
    if (errs.length) setError(errs.join(' · '));
    setUploading(false);
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/statements?id=${id}`, { method: 'DELETE' });
    if (res.ok) await loadStatements();
  }

  async function handleSignOut() {
    await createClient().auth.signOut();
    window.location.href = '/login';
  }

  return (
    <div className={styles.app}>
      <Header onSignOut={handleSignOut} statementCount={statements.length} />

      {error && <div className={styles.error}>{error}</div>}

      <FileUpload onFiles={handleFiles} uploading={uploading} />

      {loading ? (
        <p className={styles.loading}>Chargement de vos données…</p>
      ) : (
        <>
          <StatementList
            statements={merged}
            onDelete={handleDelete}
          />

          {bounds && (
            <div className={styles.controls}>
              <div className={styles.ctrl}>
                <label>Compte</label>
                <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
                  <option value="all">Tous les comptes</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.alias} ({a.currency})</option>
                  ))}
                </select>
              </div>
              <div className={styles.ctrl}>
                <label>Période</label>
                <div className={styles.dates}>
                  <input type="date" value={rangeStart} min={bounds.min} max={rangeEnd} onChange={(e) => setRangeStart(e.target.value)} />
                  <span>→</span>
                  <input type="date" value={rangeEnd} min={rangeStart} max={bounds.max} onChange={(e) => setRangeEnd(e.target.value)} />
                </div>
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

          {summary && <StatsGrid summary={summary} benchmark={benchmark} />}

          <PerformanceChart
            data={chartData}
            benchmark={benchmark}
            loading={chartLoading}
            hasStatements={filtered.length > 0}
          />
        </>
      )}

      <div className={styles.info}>
        <strong>Méthode TWRR</strong> — Les dépôts, retraits et transferts n&apos;affectent pas la courbe de performance.
        Importez des statements <strong>mensuels</strong> depuis IBKR pour un historique plus détaillé.
        Vos données sont sauvegardées dans Supabase et accessibles depuis n&apos;importe quel appareil.
      </div>
    </div>
  );
}

export function formatDateLabel(dateStr: string): string {
  try {
    return format(new Date(dateStr + 'T12:00:00'), 'd MMM yyyy', { locale: fr });
  } catch {
    return dateStr;
  }
}
