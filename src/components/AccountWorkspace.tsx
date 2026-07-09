'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseIbkrCsv } from '@/lib/ibkr';
import {
  isIbkrPerformanceReportCsv,
  parseIbkrPerformanceReportCsv,
} from '@/lib/ibkr-performance-report';
import { isFlexNavCsv, parseFlexNavCsv } from '@/lib/ibkr-flex-nav';
import { isFlexCombinedCsv, parseFlexCombinedCsv } from '@/lib/ibkr-flex-combined';
import { isFlexCashCsv, parseFlexCashCsv, cashFlowsToDateMap } from '@/lib/ibkr-flex-cash';
import { dbToNavSeries } from '@/lib/nav-mapper';
import { dbToTwrSeries } from '@/lib/twr-mapper';
import { dbToStatement } from '@/lib/db-mapper';
import { dbToAccount, formatAccountLinkLabel, isPendingIbkrId } from '@/lib/account-mapper';
import { formatStatementPeriod } from '@/lib/privacy';
import {
  benchmarkSeriesId,
  buildSeriesDefs,
  primarySeriesId,
  toggleSeriesVisibility,
  type MultiSeriesChartPoint,
} from '@/lib/chart-series';
import { buildComparisonChartData } from '@/lib/comparison-chart';
import {
  assessTwrrQuality,
  computeSummary,
  getAccountTimelineBounds,
  mergeStatements,
  navPointsHaveComponents,
  resolveIbkrTwrDailyPoints,
  shouldPreferStatementCurve,
  twrrCapitalFlowsByDate,
  twrrQualityLabel,
  twrrQualityNotice,
  type TwrrDataQuality,
} from '@/lib/performance';
import type { ChartBrushSelection } from '@/lib/chart-range';
import { analyzeTimeline, clampDateRange, effectiveTimelineBounds } from '@/lib/timeline';
import type {
  BenchmarkSymbol,
  DatePreset,
  DbStatement,
  DbNavSeries,
  DbTwrSeries,
  PerformancePoint,
  PortfolioAccount,
} from '@/lib/types';
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
import styles from './AccountWorkspace.module.css';

interface Props {
  account: PortfolioAccount;
}

export default function AccountWorkspace({ account: initialAccount }: Props) {
  const router = useRouter();
  const [account, setAccount] = useState(initialAccount);
  const [statements, setStatements] = useState<DbStatement[]>([]);
  const [navSeries, setNavSeries] = useState<DbNavSeries | null>(null);
  const [twrSeries, setTwrSeries] = useState<DbTwrSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comparisonBenchmarks, setComparisonBenchmarks] = useState<BenchmarkSymbol[]>(['SPY']);
  const [comparisonAccountIds, setComparisonAccountIds] = useState<string[]>([]);
  const [allAccounts, setAllAccounts] = useState<PortfolioAccount[]>([]);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const [chartBrush, setChartBrush] = useState<ChartBrushSelection | null>(null);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [activePreset, setActivePreset] = useState<DatePreset | null>('MAX');
  const [multiChartData, setMultiChartData] = useState<MultiSeriesChartPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [twrrQuality, setTwrrQuality] = useState<TwrrDataQuality | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [editName, setEditName] = useState(initialAccount.displayName);
  const [lockDraft, setLockDraft] = useState(initialAccount.analysisStartLock ?? '');
  const [savingLock, setSavingLock] = useState(false);

  const loadNavSeries = useCallback(async () => {
    const res = await fetch(
      `/api/nav-series?portfolioAccountId=${encodeURIComponent(account.id)}`,
    );
    if (!res.ok) {
      setNavSeries(null);
      return;
    }
    const data = await res.json();
    setNavSeries(data ? dbToNavSeries(data) : null);
  }, [account.id]);

  const loadTwrSeries = useCallback(async () => {
    const res = await fetch(
      `/api/twr-series?portfolioAccountId=${encodeURIComponent(account.id)}`,
    );
    if (!res.ok) {
      setTwrSeries(null);
      return;
    }
    const data = await res.json();
    setTwrSeries(data ? dbToTwrSeries(data) : null);
  }, [account.id]);

  const loadStatements = useCallback(async () => {
    const res = await fetch(
      `/api/statements?portfolioAccountId=${encodeURIComponent(account.id)}`,
    );
    if (!res.ok) {
      setError('Erreur de chargement');
      setStatements([]);
      return;
    }
    const data = await res.json();
    setStatements(data.map(dbToStatement));
  }, [account.id]);

  const reloadAccount = useCallback(async () => {
    const res = await fetch('/api/accounts');
    if (!res.ok) return;
    const data = await res.json();
    const accounts = data.map(dbToAccount) as PortfolioAccount[];
    const me = accounts.find((a) => a.id === account.id);
    if (me) setAccount(me);
    setAllAccounts(accounts);
  }, [account.id]);

  const reloadData = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStatements(), loadNavSeries(), loadTwrSeries(), reloadAccount()]);
    setLoading(false);
  }, [loadStatements, loadNavSeries, loadTwrSeries, reloadAccount]);

  useEffect(() => { reloadData(); }, [reloadData]);

  useEffect(() => {
    fetch('/api/accounts')
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        setAllAccounts(data.map(dbToAccount));
      })
      .catch(() => {});
  }, []);

  const merged = useMemo(() => mergeStatements(statements), [statements]);
  const dataBounds = useMemo(
    () => getAccountTimelineBounds(statements, navSeries?.points, twrSeries?.points),
    [statements, navSeries, twrSeries],
  );
  const bounds = dataBounds;

  const effectiveLock = account.analysisStartLock ?? null;

  const effectiveBounds = useMemo(
    () => (bounds ? effectiveTimelineBounds(bounds, effectiveLock) : null),
    [bounds, effectiveLock],
  );

  const accountLocksById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of allAccounts) {
      m.set(a.id, a.analysisStartLock ?? null);
    }
    return m;
  }, [allAccounts]);

  const handleRangeChange = useCallback((start: string, end: string) => {
    if (!effectiveBounds) return;
    const clamped = clampDateRange(start, end, effectiveBounds);
    setRangeStart(clamped.start);
    setRangeEnd(clamped.end);
    setActivePreset(null);
  }, [effectiveBounds]);

  const timelineHealth = useMemo(() => {
    if (!rangeStart || !rangeEnd) return null;
    return analyzeTimeline(merged, rangeStart, rangeEnd, dataBounds);
  }, [merged, rangeStart, rangeEnd, dataBounds]);

  const ibkrTwrPoints = useMemo(
    () => resolveIbkrTwrDailyPoints(twrSeries?.points, statements),
    [twrSeries, statements],
  );

  const hasChartData = useMemo(
    () =>
      ibkrTwrPoints.length >= 2 ||
      (twrSeries?.points.length ?? 0) >= 2 ||
      (navSeries?.points.length ?? 0) >= 2 ||
      statements.length > 0,
    [twrSeries, navSeries, statements, ibkrTwrPoints],
  );

  useEffect(() => {
    setLockDraft(account.analysisStartLock ?? '');
  }, [account.analysisStartLock]);

  useEffect(() => {
    if (!effectiveBounds) return;
    if (!rangeStart || !rangeEnd) {
      setRangeStart(effectiveBounds.min);
      setRangeEnd(effectiveBounds.max);
      setActivePreset('MAX');
      return;
    }
    const clamped = clampDateRange(rangeStart, rangeEnd, effectiveBounds);
    if (clamped.start !== rangeStart || clamped.end !== rangeEnd) {
      setRangeStart(clamped.start);
      setRangeEnd(clamped.end);
    }
  }, [effectiveBounds, rangeStart, rangeEnd]);

  useEffect(() => {
    if (!effectiveBounds || !rangeStart || !rangeEnd) {
      setMultiChartData([]);
      setTwrrQuality(null);
      return;
    }
    const hasNav = (navSeries?.points.length ?? 0) >= 2;
    const hasStmts = statements.length > 0;
    const hasTwr = ibkrTwrPoints.length >= 2;
    if (!hasNav && !hasStmts && !hasTwr) {
      setMultiChartData([]);
      setTwrrQuality(null);
      return;
    }
    let cancelled = false;
    async function load() {
      setChartLoading(true);
      try {
        const effStart = rangeStart;
        const effEnd = rangeEnd;
        let quality: TwrrDataQuality | null = null;

        const ibkrTwr = ibkrTwrPoints;
        if (ibkrTwr.length >= 2) {
          quality = 'exact';
        } else if (shouldPreferStatementCurve(statements, rangeStart, rangeEnd)) {
          quality = 'exact';
        } else if (hasNav && navSeries) {
          const hasComponents = navPointsHaveComponents(navSeries.points);
          const navFlows = !hasComponents && navSeries.cashFlows?.length
            ? cashFlowsToDateMap(navSeries.cashFlows)
            : null;
          const cfMap = twrrCapitalFlowsByDate(statements, navFlows);
          quality = assessTwrrQuality(navSeries.points, effStart, effEnd, cfMap);
        } else if (hasStmts) {
          quality = 'exact';
        }

        const portfolio = await buildComparisonChartData({
          primaryAccountId: account.id,
          primaryBundle: { statements, navSeries, twrSeries },
          comparisonAccountIds,
          comparisonBenchmarks,
          rangeStart: effStart,
          rangeEnd: effEnd,
          accountLocksById,
        });

        if (!portfolio.length) {
          setMultiChartData([]);
          setTwrrQuality(null);
          return;
        }
        if (!cancelled) setTwrrQuality(quality);
        if (!cancelled) setMultiChartData(portfolio);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Erreur');
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [
    statements,
    navSeries,
    twrSeries,
    ibkrTwrPoints,
    comparisonBenchmarks,
    comparisonAccountIds,
    rangeStart,
    rangeEnd,
    effectiveBounds,
    accountLocksById,
  ]);

  useEffect(() => {
    setChartBrush(null);
  }, [rangeStart, rangeEnd, comparisonBenchmarks, comparisonAccountIds, account.id]);

  async function handleSaveStartLock() {
    const value = lockDraft.trim() || null;
    setSavingLock(true);
    setError(null);
    const res = await fetch('/api/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: account.id, analysisStartLock: value }),
    });
    setSavingLock(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { error?: string }).error || 'Erreur enregistrement du verrou');
      return;
    }
    const updated = dbToAccount(await res.json());
    setAccount(updated);
    setLockDraft(updated.analysisStartLock ?? value ?? '');
    if (effectiveBounds) {
      const next = effectiveTimelineBounds(bounds!, updated.analysisStartLock);
      const clamped = clampDateRange(rangeStart || next.min, rangeEnd || next.max, next);
      setRangeStart(clamped.start);
      setRangeEnd(clamped.end);
    }
  }

  async function handleClearStartLock() {
    setLockDraft('');
    setSavingLock(true);
    const res = await fetch('/api/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: account.id, analysisStartLock: null }),
    });
    setSavingLock(false);
    if (!res.ok) return;
    const updated = dbToAccount(await res.json());
    setAccount(updated);
  }

  const chartSubtitle = useMemo(() => {
    if (ibkrTwrPoints.length >= 2) {
      const src = (twrSeries?.points.length ?? 0) >= 2 ? 'twr_series' : 'statement';
      return `TWR quotidien officiel IBKR · ${ibkrTwrPoints.length} jours${src === 'twr_series' ? '' : ' (cache)'}`;
    }
    if (twrrQuality === 'exact') {
      return 'TWRR chaîné · Activity Statement (forme journalière estimée)';
    }
    if ((navSeries?.points.length ?? 0) >= 2) {
      return 'TWRR calculé depuis la NAV Flex';
    }
    return 'TWRR chaîné · courbe lissée (peu de détail journalier)';
  }, [statements, navSeries, twrrQuality, ibkrTwrPoints, twrSeries]);

  const needsPerformanceReport = statements.length > 0 && ibkrTwrPoints.length < 2;

  const primaryLabel = account.displayName;

  const otherAccounts = useMemo(
    () => allAccounts.filter((a) => a.id !== account.id),
    [allAccounts, account.id],
  );

  const accountLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allAccounts) {
      map.set(a.id, a.displayName);
    }
    return map;
  }, [allAccounts]);

  const chartSeries = useMemo(
    () => buildSeriesDefs(primaryLabel, comparisonAccountIds, accountLabels, comparisonBenchmarks),
    [primaryLabel, comparisonAccountIds, accountLabels, comparisonBenchmarks],
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
    if (chartBrush) {
      return { start: chartBrush.startDate, end: chartBrush.endDate, fromBrush: true as const };
    }
    if (!rangeStart || !rangeEnd) return null;
    return {
      start: timelineHealth?.rangeCoverage?.availableStart ?? rangeStart,
      end: timelineHealth?.rangeCoverage?.availableEnd ?? rangeEnd,
      fromBrush: false as const,
    };
  }, [chartBrush, rangeStart, rangeEnd, timelineHealth]);

  async function handleFiles(files: FileList) {
    setUploading(true);
    setError(null);
    setNotice(null);
    const errs: string[] = [];
    const notes: string[] = [];

    try {
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.csv')) continue;
      try {
        const text = await file.text();
        const perfReport = isIbkrPerformanceReportCsv(text);

        if (perfReport) {
          const parsed = parseIbkrPerformanceReportCsv(text, file.name);

          const res = await fetch('/api/statements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...parsed, portfolioAccountId: account.id }),
          });
          const j = await res.json().catch(() => ({} as Record<string, unknown>));
          if (!res.ok) throw new Error((j.error as string) || 'Erreur sauvegarde');

          const twrRes = await fetch('/api/twr-series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              portfolioAccountId: account.id,
              accountId: parsed.accountId,
              baseCurrency: parsed.baseCurrency,
              periodStart: parsed.periodStart,
              periodEnd: parsed.periodEnd,
              twrr: parsed.twrr,
              points: parsed.twrDaily,
            }),
          });
          const twrJson = await twrRes.json().catch(() => ({} as Record<string, unknown>));
          if (!twrRes.ok) {
            throw new Error((twrJson.error as string) || 'Erreur sauvegarde TWR journalier');
          }
          if (twrJson.series) {
            setTwrSeries(dbToTwrSeries(twrJson.series as Record<string, unknown>));
          }

          const warn = (j.meta as { warning?: string; twrDailyStored?: boolean })?.warning;
          const twrStored = (j.meta as { twrDailyStored?: boolean })?.twrDailyStored !== false;
          notes.push(
            `Rapport performance : ${parsed.twrDaily?.length ?? 0} jours TWR` +
            ` (${(parsed.twrr * 100).toFixed(1)} % sur la période)`,
          );
          if (!twrStored && warn) notes.push(warn);
          continue;
        }

        const flexCombined = isFlexCombinedCsv(text);
        const flexNav = !flexCombined && isFlexNavCsv(text);
        const flexCash = !flexCombined && !flexNav && isFlexCashCsv(text);

        if (flexCombined) {
          const { nav, cashFlows } = parseFlexCombinedCsv(text, file.name);

          const res = await fetch('/api/nav-series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...nav,
              cashFlows,
              portfolioAccountId: account.id,
            }),
          });
          const j = await res.json().catch(() => ({} as Record<string, unknown>));
          if (!res.ok) throw new Error((j.error as string) || 'Erreur sauvegarde Flex');
          if (j.series) setNavSeries(dbToNavSeries(j.series as Record<string, unknown>));
          const warn = (j.meta as { warning?: string })?.warning;
          notes.push(
            `Flex NAV : ${nav.points.length} jours` +
            (cashFlows.length ? `, ${cashFlows.length} flux capitaux` : ''),
          );
          if (warn) notes.push(warn);
          continue;
        }

        if (flexCash) {
          const flows = parseFlexCashCsv(text, file.name);
          const res = await fetch('/api/nav-series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              portfolioAccountId: account.id,
              cashFlows: flows,
            }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || 'Erreur sauvegarde flux');
          if (j.series) setNavSeries(dbToNavSeries(j.series));
          notes.push(`${flows.length} flux de capitaux importés`);
          continue;
        }

        if (flexNav) {
          const parsed = parseFlexNavCsv(text, file.name);

          const res = await fetch('/api/nav-series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...parsed, portfolioAccountId: account.id }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || 'Erreur sauvegarde NAV');
          if (j.series) setNavSeries(dbToNavSeries(j.series));
          notes.push(`${j.meta?.days ?? parsed.points.length} jours NAV importés`);
          continue;
        }

        const parsed = parseIbkrCsv(text, file.name);

        const res = await fetch('/api/statements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...parsed, portfolioAccountId: account.id }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Erreur sauvegarde');
        if (j.meta?.replaced > 0) {
          notes.push(`${j.meta.replaced} période(s) en chevauchement remplacée(s)`);
        } else if (j.meta?.action === 'created') {
          notes.push(`Activity Statement ${formatStatementPeriod(parsed)} importé`);
        }
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : 'erreur'}`);
      }
    }

    await reloadData();
    if (notes.length) setNotice(notes.join(' · '));
    if (errs.length) setError(errs.join(' · '));
    else if (!notes.length) {
      setError('Aucun fichier CSV reconnu — vérifiez l\'extension .csv');
    }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur à l\'import');
    } finally {
      setUploading(false);
    }
  }

  async function handleDeleteNavSeries() {
    const res = await fetch(
      `/api/nav-series?portfolioAccountId=${encodeURIComponent(account.id)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || 'Erreur suppression NAV');
      return;
    }
    setNavSeries(null);
    await reloadData();
  }

  async function handleDelete(id: string) {
    if (!confirm('Supprimer cette période de la base de données ?')) return;
    const res = await fetch(`/api/statements?id=${id}`, { method: 'DELETE' });
    if (res.ok) await reloadData();
  }

  async function handleDeleteRange(_accId: string, start: string, end: string) {
    const res = await fetch(
      `/api/statements?portfolioAccountId=${encodeURIComponent(account.id)}&rangeStart=${start}&rangeEnd=${end}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const j = await res.json();
      setError(j.error || 'Erreur suppression');
      return;
    }
    await reloadData();
  }

  async function handleRename() {
    const name = editName.trim();
    if (!name || name === account.displayName) {
      setRenaming(false);
      return;
    }
    setError(null);
    const res = await fetch('/api/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: account.id, displayName: name }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || 'Erreur renommage');
      return;
    }
    const updated = dbToAccount(await res.json());
    setAccount(updated);
    setEditName(updated.displayName);
    setRenaming(false);
  }

  async function handleDeleteAccount() {
    if (!confirm(`Supprimer le compte « ${account.displayName} » et toutes ses données ?`)) return;
    const res = await fetch(`/api/accounts?id=${account.id}`, { method: 'DELETE' });
    if (res.ok) router.push('/');
  }

  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumb}>
        <Link href="/">← Tableau de bord</Link>
      </nav>

      <header className={styles.accountHeader}>
        <div className={styles.headerMain}>
          <p className={styles.youAreHere}>Vous êtes dans ce compte</p>
          {renaming ? (
            <div className={styles.renameRow}>
              <input
                className={styles.renameInput}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename();
                  if (e.key === 'Escape') { setRenaming(false); setEditName(account.displayName); }
                }}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={handleRename}>Enregistrer</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRenaming(false); setEditName(account.displayName); }}>Annuler</button>
            </div>
          ) : (
            <h1>{account.displayName}</h1>
          )}
          <p className={styles.ibkrId}>{formatAccountLinkLabel(account.ibkrAccountId)}</p>
        </div>
        <div className={styles.headerActions}>
          {!renaming && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRenaming(true)}>
              Renommer
            </button>
          )}
          <button type="button" className="btn btn-danger btn-sm" onClick={handleDeleteAccount}>
            Supprimer
          </button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}

      <FileUpload
        onFiles={handleFiles}
        uploading={uploading}
        accountHint={account.displayName}
      />

      {!loading && statements.length === 0 && !navSeries && (
        <div className={styles.emptyState}>
          <strong>Première étape :</strong> glissez votre rapport performance IBKR (CSV TWR quotidien)
          ou un Activity Statement / Flex NAV.
          {isPendingIbkrId(account.ibkrAccountId) && (
            <> Le compte sera lié automatiquement au premier import.</>
          )}
        </div>
      )}

      {ibkrTwrPoints.length >= 2 && (
        <div className={styles.notice}>
          Courbe TWR officielle IBKR — dépôts, retraits et transferts déjà exclus.
        </div>
      )}

      {navSeries && statements.length === 0 && (
        <div className={styles.notice}>
          {navPointsHaveComponents(navSeries.points)
            ? 'Courbe TWRR depuis Flex NAV — les dépôts/retraits sont exclus quand détectables.'
            : 'Réimportez votre Flex NAV : les colonnes Stock/Cash manquent, le rendement affiché sera faux.'}
        </div>
      )}

      {needsPerformanceReport && (
        <div className={styles.error}>
          Courbe lissée (ligne droite) : il manque le TWR journalier IBKR.
          Réimportez <strong>Nicolas_Cool_U16150944_December_02_2024_July_08_2026.csv</strong>
          (Rapport Performance IBKR, pas l&apos;Activity Statement).
        </div>
      )}

      {twrrQuality && twrrQualityNotice(twrrQuality) && (
        <div className={twrrQuality === 'raw_nav' ? styles.error : styles.notice}>
          {twrrQualityNotice(twrrQuality)}
        </div>
      )}

      {loading ? (
        <p className={styles.loading}>Chargement…</p>
      ) : (
        <>
          <DataPanel
            statements={statements}
            navSeries={navSeries}
            accountId={account.id}
            accountLabel={account.displayName}
            onDelete={handleDelete}
            onDeleteNavSeries={handleDeleteNavSeries}
            onDeleteRange={handleDeleteRange}
          />

          {effectiveBounds && (
            <div className={styles.controls}>
              <div className={styles.ctrlFull}>
                <label>Période d&apos;analyse</label>
                <DateRangeControls
                  bounds={effectiveBounds}
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  activePreset={activePreset}
                  onPreset={setActivePreset}
                  onRangeChange={handleRangeChange}
                />
                <div className={styles.startLock}>
                  <label htmlFor="start-lock">Début verrouillé (ignore l&apos;historique avant)</label>
                  <div className={styles.startLockRow}>
                    <input
                      id="start-lock"
                      type="date"
                      value={lockDraft ?? ''}
                      min={effectiveBounds.dataMin}
                      max={effectiveBounds.max}
                      onChange={(e) => setLockDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={savingLock || !lockDraft}
                      onClick={handleSaveStartLock}
                    >
                      {savingLock ? '…' : 'Verrouiller'}
                    </button>
                    {account.analysisStartLock && (
                      <button
                        type="button"
                        className="btn"
                        disabled={savingLock}
                        onClick={handleClearStartLock}
                      >
                        Retirer
                      </button>
                    )}
                  </div>
                  {effectiveBounds.locked && (
                    <p className={styles.startLockHint}>
                      Analyse depuis le <strong>{account.analysisStartLock}</strong>
                      {effectiveBounds.dataMin < effectiveBounds.min && (
                        <> — données CSV disponibles dès {effectiveBounds.dataMin}</>
                      )}
                    </p>
                  )}
                </div>
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

          {summary && (
            <StatsGrid
              summary={summary}
              benchmark={summaryBenchmark}
              performanceSub={
                ibkrTwrPoints.length >= 2
                  ? 'TWR quotidien IBKR (officiel)'
                  : twrrQuality
                    ? twrrQualityLabel(twrrQuality)
                    : undefined
              }
            />
          )}

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
            hasStatements={statements.length > 0 || (navSeries?.points.length ?? 0) > 0}
            noDataInRange={
              multiChartData.length === 0 &&
              (timelineHealth?.rangeCoverage?.hasAnyData === false)
            }
            subtitle={chartSubtitle}
            stacked
          />

          <DrawdownChart
            series={chartSeries}
            data={multiChartData}
            hidden={hiddenSeries}
            loading={chartLoading}
            stacked
            show={
              (statements.length > 0 || (navSeries?.points.length ?? 0) > 0) &&
              hasChartData &&
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
                (statements.length > 0 || (navSeries?.points.length ?? 0) > 0) &&
                hasChartData &&
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
