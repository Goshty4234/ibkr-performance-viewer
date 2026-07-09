'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseIbkrCsv } from '@/lib/ibkr';
import { dbToAccount } from '@/lib/account-mapper';
import { dbToStatement } from '@/lib/db-mapper';
import {
  benchmarkSeriesId,
  buildSeriesDefs,
  primarySeriesId,
  toggleSeriesVisibility,
  type MultiSeriesChartPoint,
} from '@/lib/chart-series';
import { buildComparisonChartData } from '@/lib/comparison-chart';
import { getGlobalAnalysisLock } from '@/lib/analysis-lock';
import {
  computeSummary,
  getTimelineBounds,
  mergeStatements,
} from '@/lib/performance';
import { fetchAccountCurveBundle } from '@/lib/portfolio-curve';
import type { ChartBrushSelection } from '@/lib/chart-range';
import { analyzeTimeline } from '@/lib/timeline';
import type {
  BenchmarkSymbol,
  DatePreset,
  DbStatement,
  PerformancePoint,
  PortfolioAccount,
} from '@/lib/types';
import AccountManager from './AccountManager';
import DataPanel from './DataPanel';
import DateRangeControls from './DateRangeControls';
import StatsGrid from './StatsGrid';
import PerformanceChart from './PerformanceChart';
import ChartRangeBanner from './ChartRangeBanner';
import ComparisonControls from './ComparisonControls';
import DrawdownChart from './DrawdownChart';
import PeriodPerformanceTable from './PeriodPerformanceTable';
import RiskMetricsTable from './RiskMetricsTable';
import YearlyReturnsChart from './YearlyReturnsChart';
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
  const [comparisonBenchmarks, setComparisonBenchmarks] = useState<BenchmarkSymbol[]>(['SPY']);
  const [comparisonAccountIds, setComparisonAccountIds] = useState<string[]>([]);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const [chartBrush, setChartBrush] = useState<ChartBrushSelection | null>(null);
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [activePreset, setActivePreset] = useState<DatePreset | null>('MAX');
  const [multiChartData, setMultiChartData] = useState<MultiSeriesChartPoint[]>([]);
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
    return statements.filter((s) => s.portfolioAccountId === accountFilter);
  }, [statements, accountFilter]);

  const rawFiltered = useMemo(() => {
    if (accountFilter === 'all') return statements;
    return statements.filter((s) => s.portfolioAccountId === accountFilter);
  }, [statements, accountFilter]);

  const bounds = useMemo(() => getTimelineBounds(filtered), [filtered]);
  const merged = useMemo(() => mergeStatements(filtered), [filtered]);

  const accountLabel = useMemo(() => {
    if (accountFilter === 'all') return 'Tous les comptes';
    const acc = accounts.find((a) => a.id === accountFilter);
    return acc?.displayName ?? 'Compte';
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
      setMultiChartData([]);
      return;
    }
    let cancelled = false;
    async function load() {
      setChartLoading(true);
      setError(null);
      try {
        const health = analyzeTimeline(merged, rangeStart, rangeEnd);
        if (!health.rangeCoverage?.hasAnyData) {
          setMultiChartData([]);
          return;
        }
        const effStart = health.rangeCoverage.availableStart ?? rangeStart;
        const effEnd = health.rangeCoverage.availableEnd ?? rangeEnd;
        const globalLock = getGlobalAnalysisLock();
        const accountLocksById = new Map(
          accounts.map((a) => [a.id, a.analysisStartLock ?? null] as const),
        );
        const rangeStartLocked = globalLock && globalLock > effStart ? globalLock : effStart;

        let primaryBundle;
        let primaryAccountId = '';
        if (accountFilter !== 'all') {
          const acc = accounts.find((a) => a.id === accountFilter);
          primaryAccountId = acc?.id ?? '';
          primaryBundle = acc
            ? await fetchAccountCurveBundle(acc.id)
            : { statements: filtered, navSeries: null, twrSeries: null };
        } else {
          primaryBundle = { statements: filtered, navSeries: null, twrSeries: null };
          primaryAccountId = '__all__';
        }

        const chart = await buildComparisonChartData({
          primaryAccountId,
          primaryBundle,
          comparisonAccountIds,
          comparisonBenchmarks,
          rangeStart: effStart,
          rangeEnd: effEnd,
          accountLocksById,
          globalLock,
        });

        if (!chart.length) {
          setMultiChartData([]);
          return;
        }

        if (!cancelled) setMultiChartData(chart);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Erreur');
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [
    filtered,
    merged,
    accounts,
    accountFilter,
    comparisonBenchmarks,
    comparisonAccountIds,
    rangeStart,
    rangeEnd,
    bounds,
  ]);

  useEffect(() => {
    setChartBrush(null);
  }, [rangeStart, rangeEnd, comparisonBenchmarks, comparisonAccountIds, accountFilter]);

  const activePortfolioId = useMemo(() => {
    if (accountFilter === 'all') return null;
    return accountFilter;
  }, [accountFilter]);

  const otherAccounts = useMemo(() => {
    if (!activePortfolioId) return accounts;
    return accounts.filter((a) => a.id !== activePortfolioId);
  }, [accounts, activePortfolioId]);

  const accountLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) {
      map.set(a.id, a.displayName);
    }
    return map;
  }, [accounts]);

  const chartSeries = useMemo(
    () => buildSeriesDefs(accountLabel, comparisonAccountIds, accountLabels, comparisonBenchmarks),
    [accountLabel, comparisonAccountIds, accountLabels, comparisonBenchmarks],
  );

  useEffect(() => {
    const valid = new Set(chartSeries.map((s) => s.id));
    setHiddenSeries((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [chartSeries]);

  const handleToggleSeries = useCallback((seriesId: string) => {
    setHiddenSeries((prev) => toggleSeriesVisibility(prev, seriesId));
  }, []);

  const summaryBenchmark = comparisonBenchmarks[0] ?? 'SPY';

  const legacyChartData = useMemo((): PerformancePoint[] => {
    if (!multiChartData.length) return [];
    const benchId = comparisonBenchmarks[0]
      ? benchmarkSeriesId(comparisonBenchmarks[0])
      : null;
    return multiChartData.map((p) => ({
      date: p.date,
      portfolio: (p[primarySeriesId()] as number) ?? 0,
      benchmark: benchId ? ((p[benchId] as number) ?? 0) : 0,
    }));
  }, [multiChartData, comparisonBenchmarks]);

  const summary = useMemo(() => {
    if (!legacyChartData.length) return null;
    const chartStart = legacyChartData[0].date;
    const chartEnd = legacyChartData[legacyChartData.length - 1].date;
    return computeSummary(legacyChartData, chartStart, chartEnd);
  }, [legacyChartData]);

  const metricsRange = useMemo(() => {
    if (chartBrush) return { start: chartBrush.startDate, end: chartBrush.endDate };
    if (!rangeStart || !rangeEnd) return null;
    return {
      start: timelineHealth?.rangeCoverage?.availableStart ?? rangeStart,
      end: timelineHealth?.rangeCoverage?.availableEnd ?? rangeEnd,
    };
  }, [chartBrush, rangeStart, rangeEnd, timelineHealth]);

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
      `/api/statements?portfolioAccountId=${encodeURIComponent(accId)}&rangeStart=${start}&rangeEnd=${end}`,
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
            const rest = prev.filter((a) => a.id !== acc.id);
            return [...rest, { ...acc, statementCount: 0 }];
          });
          setAccountFilter(acc.id);
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
          <strong>Aucune donnée pour ce compte.</strong> Importez un CSV IBKR pour ce compte workspace.
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
              <div className={styles.ctrlFull}>
                <label>Comparaisons</label>
                <ComparisonControls
                  benchmarks={comparisonBenchmarks}
                  onBenchmarksChange={setComparisonBenchmarks}
                  otherAccounts={otherAccounts}
                  selectedAccountIds={comparisonAccountIds}
                  onAccountIdsChange={setComparisonAccountIds}
                />
              </div>
            </div>
          )}

          {timelineHealth && <TimelineStatus health={timelineHealth} />}

          {summary && <StatsGrid summary={summary} benchmark={summaryBenchmark} />}

          <ChartRangeBanner
            selectedStart={rangeStart}
            selectedEnd={rangeEnd}
            data={multiChartData}
            loading={chartLoading}
          />

          <div className={styles.chartStack}>
          <PerformanceChart
            series={chartSeries}
            data={multiChartData}
            hidden={hiddenSeries}
            onToggleSeries={handleToggleSeries}
            brush={chartBrush}
            onBrushChange={setChartBrush}
            loading={chartLoading}
            hasStatements={filtered.length > 0}
            noDataInRange={timelineHealth?.rangeCoverage?.hasAnyData === false}
            stacked
          />

          <DrawdownChart
            series={chartSeries}
            data={multiChartData}
            hidden={hiddenSeries}
            loading={chartLoading}
            stacked
            show={
              filtered.length > 0 &&
              timelineHealth?.rangeCoverage?.hasAnyData !== false &&
              multiChartData.length > 0
            }
          />
          </div>

          {metricsRange && (
            <RiskMetricsTable
              series={chartSeries}
              data={multiChartData}
              hidden={hiddenSeries}
              brush={chartBrush}
              loading={chartLoading}
              show={
                filtered.length > 0 &&
                timelineHealth?.rangeCoverage?.hasAnyData !== false &&
                multiChartData.length > 0
              }
            />
          )}

          {multiChartData.length > 0 && (
            <>
              <PeriodPerformanceTable
                title="Performance annuelle"
                subtitle="Rendement de chaque année · cumul = multiple et % total depuis le début de la plage"
                data={multiChartData}
                series={chartSeries}
                hidden={hiddenSeries}
                mode="yearly"
              />
              <PeriodPerformanceTable
                title="Performance mensuelle"
                subtitle="Rendement de chaque mois · cumul depuis le début de la plage affichée"
                data={multiChartData}
                series={chartSeries}
                hidden={hiddenSeries}
                mode="monthly"
              />
              <YearlyReturnsChart
                data={multiChartData}
                series={chartSeries}
                hidden={hiddenSeries}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
