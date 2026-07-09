'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseIbkrCsv } from '@/lib/ibkr';
import { isFlexNavCsv, parseFlexNavCsv } from '@/lib/ibkr-flex-nav';
import { isFlexCombinedCsv, parseFlexCombinedCsv } from '@/lib/ibkr-flex-combined';
import { isFlexCashCsv, parseFlexCashCsv, cashFlowsToDateMap } from '@/lib/ibkr-flex-cash';
import { dbToNavSeries } from '@/lib/nav-mapper';
import { dbToStatement } from '@/lib/db-mapper';
import { dbToAccount, formatIbkrIdDisplay, isPendingIbkrId } from '@/lib/account-mapper';
import {
  alignBenchmark,
  assessTwrrQuality,
  buildPerformanceCurve,
  buildTwrrCurveFromNav,
  computeSummary,
  fetchBenchmark,
  getNavTimelineBounds,
  getTimelineBounds,
  mergeStatements,
  mergeTimelineBounds,
  navPointsHaveComponents,
  shouldPreferStatementCurve,
  twrrCapitalFlowsByDate,
  twrrQualityLabel,
  twrrQualityNotice,
  type TwrrDataQuality,
} from '@/lib/performance';
import { analyzeTimeline } from '@/lib/timeline';
import type {
  BenchmarkSymbol,
  DatePreset,
  DbStatement,
  DbNavSeries,
  PerformancePoint,
  PortfolioAccount,
} from '@/lib/types';
import { BENCHMARK_LABELS } from '@/lib/types';
import DataPanel from './DataPanel';
import DateRangeControls from './DateRangeControls';
import StatsGrid from './StatsGrid';
import PerformanceChart from './PerformanceChart';
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
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkSymbol>('SPY');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [activePreset, setActivePreset] = useState<DatePreset | null>('MAX');
  const [chartData, setChartData] = useState<PerformancePoint[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [twrrQuality, setTwrrQuality] = useState<TwrrDataQuality | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [editName, setEditName] = useState(initialAccount.displayName);

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

  const reloadData = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadStatements(), loadNavSeries()]);
    setLoading(false);
  }, [loadStatements, loadNavSeries]);

  useEffect(() => { reloadData(); }, [reloadData]);

  const merged = useMemo(() => mergeStatements(statements), [statements]);
  const bounds = useMemo(
    () => mergeTimelineBounds(
      getTimelineBounds(statements),
      navSeries ? getNavTimelineBounds(navSeries.points) : null,
    ),
    [statements, navSeries],
  );

  const timelineHealth = useMemo(() => {
    if (!rangeStart || !rangeEnd) return null;
    const navBounds = navSeries?.points.length
      ? getNavTimelineBounds(navSeries.points)
      : null;
    const stmtBounds = getTimelineBounds(statements);
    const combined = mergeTimelineBounds(stmtBounds, navBounds);
    if (combined && navSeries?.points.length && !statements.length) {
      return analyzeTimeline([], rangeStart, rangeEnd, combined);
    }
    if (combined && navSeries?.points.length && statements.length) {
      return analyzeTimeline(merged, rangeStart, rangeEnd, combined);
    }
    return analyzeTimeline(merged, rangeStart, rangeEnd);
  }, [merged, statements, navSeries, rangeStart, rangeEnd]);

  const hasChartData = useMemo(
    () => (navSeries?.points.length ?? 0) >= 2 || statements.length > 0,
    [navSeries, statements],
  );

  useEffect(() => {
    if (!bounds) return;
    if (!rangeStart || !rangeEnd) {
      setRangeStart(bounds.min);
      setRangeEnd(bounds.max);
      setActivePreset('MAX');
    }
  }, [bounds, rangeStart, rangeEnd]);

  useEffect(() => {
    if (!bounds || !rangeStart || !rangeEnd) {
      setChartData([]);
      setTwrrQuality(null);
      return;
    }
    const hasNav = (navSeries?.points.length ?? 0) >= 2;
    const hasStmts = statements.length > 0;
    if (!hasNav && !hasStmts) {
      setChartData([]);
      setTwrrQuality(null);
      return;
    }
    let cancelled = false;
    async function load() {
      setChartLoading(true);
      try {
        const effStart = rangeStart;
        const effEnd = rangeEnd;
        let portfolio: { date: string; portfolio: number }[];
        let quality: TwrrDataQuality | null = null;

        if (shouldPreferStatementCurve(statements, rangeStart, rangeEnd)) {
          const health = analyzeTimeline(merged, rangeStart, rangeEnd);
          const stmtStart = health.rangeCoverage?.availableStart ?? rangeStart;
          const stmtEnd = health.rangeCoverage?.availableEnd ?? rangeEnd;
          portfolio = buildPerformanceCurve(statements, stmtStart, stmtEnd);
          quality = 'exact';
        } else if (hasNav && navSeries) {
          const navFlows = navSeries.cashFlows?.length
            ? cashFlowsToDateMap(navSeries.cashFlows)
            : null;
          const cfMap = twrrCapitalFlowsByDate(statements, navFlows);
          portfolio = buildTwrrCurveFromNav(
            navSeries.points,
            effStart,
            effEnd,
            cfMap,
          );
          quality = assessTwrrQuality(navSeries.points, effStart, effEnd, cfMap);
        } else {
          const health = analyzeTimeline(merged, rangeStart, rangeEnd);
          if (!health.rangeCoverage?.hasAnyData) {
            setChartData([]);
            setTwrrQuality(null);
            return;
          }
          const stmtStart = health.rangeCoverage.availableStart ?? rangeStart;
          const stmtEnd = health.rangeCoverage.availableEnd ?? rangeEnd;
          portfolio = buildPerformanceCurve(statements, stmtStart, stmtEnd);
          quality = 'exact';
        }

        if (!portfolio.length) {
          setChartData([]);
          setTwrrQuality(null);
          return;
        }
        if (!cancelled) setTwrrQuality(quality);
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
  }, [statements, merged, navSeries, benchmark, rangeStart, rangeEnd, bounds]);

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
    let currentIbkrId = account.ibkrAccountId;

    try {
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.csv')) continue;
      try {
        const text = await file.text();
        const flexCombined = isFlexCombinedCsv(text);
        const flexNav = !flexCombined && isFlexNavCsv(text);
        const flexCash = !flexCombined && !flexNav && isFlexCashCsv(text);

        if (flexCombined) {
          const { nav, cashFlows } = parseFlexCombinedCsv(text, file.name);

          if (isPendingIbkrId(currentIbkrId)) {
            const linkRes = await fetch('/api/accounts', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: account.id, ibkrAccountId: nav.accountId }),
            });
            const linkJson = await linkRes.json();
            if (!linkRes.ok) throw new Error(linkJson.error || 'Impossible de lier l\'ID IBKR');
            const updated = dbToAccount(linkJson);
            setAccount(updated);
            setEditName(updated.displayName);
            currentIbkrId = updated.ibkrAccountId;
            notes.push(`ID IBKR détecté : ${currentIbkrId}`);
          } else if (nav.accountId !== currentIbkrId) {
            throw new Error(
              `Ce fichier est pour le compte ${nav.accountId}, pas ${currentIbkrId}`,
            );
          }

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
            `${file.name} : ${nav.points.length} jours NAV` +
            (cashFlows.length ? `, ${cashFlows.length} flux capitaux` : ' (pas de dépôts/retraits dans Cash Transactions)'),
          );
          if (warn) notes.push(warn);
          continue;
        }

        if (flexCash) {
          const flows = parseFlexCashCsv(text, file.name);
          if (isPendingIbkrId(currentIbkrId)) {
            throw new Error('Importez d\'abord un Flex NAV ou Activity Statement pour lier le compte.');
          }
          const res = await fetch('/api/nav-series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              portfolioAccountId: account.id,
              accountId: currentIbkrId,
              cashFlows: flows,
              filename: file.name,
            }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || 'Erreur sauvegarde flux');
          if (j.series) setNavSeries(dbToNavSeries(j.series));
          notes.push(`${file.name} : ${flows.length} flux de capitaux importés`);
          continue;
        }

        if (flexNav) {
          const parsed = parseFlexNavCsv(text, file.name);

          if (isPendingIbkrId(currentIbkrId)) {
            const linkRes = await fetch('/api/accounts', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: account.id, ibkrAccountId: parsed.accountId }),
            });
            const linkJson = await linkRes.json();
            if (!linkRes.ok) {
              throw new Error(linkJson.error || 'Impossible de lier l\'ID IBKR');
            }
            const updated = dbToAccount(linkJson);
            setAccount(updated);
            setEditName(updated.displayName);
            currentIbkrId = updated.ibkrAccountId;
            notes.push(`ID IBKR détecté : ${currentIbkrId}`);
          } else if (parsed.accountId !== currentIbkrId) {
            throw new Error(
              `Ce fichier est pour le compte ${parsed.accountId}, pas ${currentIbkrId}`,
            );
          }

          const res = await fetch('/api/nav-series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...parsed, portfolioAccountId: account.id }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || 'Erreur sauvegarde NAV');
          if (j.series) setNavSeries(dbToNavSeries(j.series));
          notes.push(
            `${file.name} : ${j.meta?.days ?? parsed.points.length} jours NAV importés`,
          );
          continue;
        }

        const parsed = parseIbkrCsv(text, file.name);

        if (isPendingIbkrId(currentIbkrId)) {
          const linkRes = await fetch('/api/accounts', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: account.id, ibkrAccountId: parsed.accountId }),
          });
          const linkJson = await linkRes.json();
          if (!linkRes.ok) {
            throw new Error(linkJson.error || 'Impossible de lier l\'ID IBKR');
          }
          const updated = dbToAccount(linkJson);
          setAccount(updated);
          setEditName(updated.displayName);
          currentIbkrId = updated.ibkrAccountId;
          notes.push(`ID IBKR détecté : ${currentIbkrId}`);
        } else if (parsed.accountId !== currentIbkrId) {
          throw new Error(
            `Ce CSV est pour le compte ${parsed.accountId}, pas ${currentIbkrId}`,
          );
        }
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
          notes.push(`${file.name} ajouté`);
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
          <p className={styles.ibkrId}>{formatIbkrIdDisplay(account.ibkrAccountId)}</p>
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
          <strong>Première étape :</strong> glissez un Activity Statement IBKR (.csv) ou un export Flex NAV quotidien.
          {isPendingIbkrId(account.ibkrAccountId) && (
            <> L&apos;ID IBKR sera lu automatiquement depuis le fichier.</>
          )}
        </div>
      )}

      {navSeries && statements.length === 0 && (
        <div className={styles.notice}>
          {navPointsHaveComponents(navSeries.points)
            ? 'Courbe TWRR depuis Flex NAV — les dépôts/retraits sont exclus quand détectables.'
            : 'Réimportez votre Flex NAV : les colonnes Stock/Cash manquent, le rendement affiché sera faux.'}
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
                  onRangeChange={(s, e) => { setRangeStart(s); setRangeEnd(e); setActivePreset(null); }}
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

          {summary && (
            <StatsGrid
              summary={summary}
              benchmark={benchmark}
              performanceSub={twrrQuality ? twrrQualityLabel(twrrQuality) : undefined}
            />
          )}

          <PerformanceChart
            data={chartData}
            benchmark={benchmark}
            loading={chartLoading}
            hasStatements={statements.length > 0 || (navSeries?.points.length ?? 0) > 0}
            noDataInRange={
              !hasChartData || timelineHealth?.rangeCoverage?.hasAnyData === false
            }
          />
        </>
      )}
    </div>
  );
}
