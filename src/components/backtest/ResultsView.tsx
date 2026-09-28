'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { portfolioSeriesId } from '@/lib/backtest/chart-data';
import { listRuns, loadLatestOnce, loadRun, readResultFile } from '@/lib/backtest/history';
import { okSummaries } from '@/lib/backtest/result-data';
import { useBacktestStore } from '@/lib/backtest/store';
import { toggleSeriesVisibility } from '@/lib/chart-series';
import ConfigsTab from './results/ConfigsTab';
import FocusedTab from './results/FocusedTab';
import MarketTab from './results/MarketTab';
import OverviewTab from './results/OverviewTab';
import PeriodsTab from './results/PeriodsTab';
import PortfolioTab from './results/PortfolioTab';
import TickersTab from './results/TickersTab';
import TodayTab from './results/TodayTab';
import styles from './Results.module.css';
import bt from './Backtester.module.css';

const DEFAULT_VISIBLE = 15;

type TabId = 'overview' | 'focused' | 'periods' | 'portfolio' | 'today' | 'tickers' | 'market' | 'configs';

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: 'overview', label: 'Vue d’ensemble', hint: 'Statistiques, performance, drawdown, variations, heatmap' },
  { id: 'focused', label: 'Analyse ciblée', hint: 'Métriques détaillées sur une période au choix' },
  { id: 'periods', label: 'Périodes', hint: 'Tableaux annuels / mensuels et statistiques robustes' },
  { id: 'portfolio', label: 'Portfolio détaillé', hint: 'Allocations, métriques de momentum, actions, fiscalité' },
  { id: 'today', label: 'Aujourd’hui', hint: 'Rebalancement du jour, minuteur, calculateur d’achat' },
  { id: 'tickers', label: 'Tickers', hint: 'Prix, moyennes mobiles, PER' },
  { id: 'market', label: 'Marché', hint: 'VIX et taux sans risque' },
  { id: 'configs', label: 'Configurations', hint: 'Comparaison des paramètres' },
];

/** Mounts a tab on first visit and keeps it alive (hidden) afterwards. */
function TabPane({ active, visited, children }: { active: boolean; visited: boolean; children: ReactNode }) {
  if (!visited) return null;
  return <div className={styles.tabPane} style={active ? undefined : { display: 'none' }}>{children}</div>;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function OpenResultFile({ onError }: { onError: (msg: string) => void }) {
  const showResult = useBacktestStore((s) => s.showResult);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".gz,.json,application/gzip,application/json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try {
            showResult(await readResultFile(f, f.name), null, f.name.replace(/\.json(\.gz)?$/i, ''));
          } catch (err) {
            onError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current?.click()} title="Résultat produit par GitHub Actions ou la ligne de commande">
        Ouvrir un fichier résultat
      </button>
    </>
  );
}

function EmptyResults() {
  const showResult = useBacktestStore((s) => s.showResult);
  const setView = useBacktestStore((s) => s.setView);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadLatest(silent = false) {
    setLoading(true);
    setError('');
    try {
      const [latest] = await listRuns(1);
      if (!latest) { if (!silent) setError('Aucun run enregistré pour l’instant.'); return; }
      const { row, result } = await loadRun(latest.id);
      if (!result) { if (!silent) setError('Le résultat de ce run n’est plus disponible.'); return; }
      showResult(result, row.id, row.label);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLatestOnce()
      .then((hit) => {
        if (hit && !useBacktestStore.getState().result) showResult(hit.result, hit.row.id, hit.row.label);
      })
      .catch(() => {});
  }, [showResult]);

  return (
    <div className={`card ${bt.empty}`}>
      <h2>Aucun résultat affiché</h2>
      <p>Lance un backtest depuis la barre ci-dessus, ou recharge un run précédent.</p>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" className="btn btn-primary" onClick={() => loadLatest()} disabled={loading}>
          {loading ? 'Chargement…' : 'Charger le dernier run'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setView('history')}>Historique</button>
        <OpenResultFile onError={setError} />
      </div>
      {error && <div className={bt.errorBox}>{error}</div>}
    </div>
  );
}

export default function ResultsView() {
  const result = useBacktestStore((s) => s.result);
  const label = useBacktestStore((s) => s.resultLabel);
  const runId = useBacktestStore((s) => s.resultRunId);
  const saveError = useBacktestStore((s) => s.saveError);
  const source = useBacktestStore((s) => s.resultSource);
  const [fileError, setFileError] = useState('');
  const payload = result?.summary ?? null;

  const pfs = useMemo(() => (payload ? okSummaries(payload) : []), [payload]);
  const failed = useMemo(() => (payload ? payload.portfolios.filter((p) => !p.ok) : []), [payload]);
  const benchKeys = useMemo(() => (payload ? Object.keys(payload.benchmarks).sort() : []), [payload]);

  const [benchmarks, setBenchmarks] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [visited, setVisited] = useState<Set<TabId>>(new Set(['overview']));

  useEffect(() => {
    setBenchmarks(benchKeys.slice(0, 1));
    setHidden(new Set(pfs.slice(DEFAULT_VISIBLE).map((p) => portfolioSeriesId(p.index))));
    setSelected(pfs[0]?.index ?? null);
    setVisited(new Set([tab]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, benchKeys, pfs]);

  const openTab = (id: TabId) => {
    setTab(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
  };

  if (!result || !payload) return <EmptyResults />;

  const sim = payload.simulation;
  const toggle = (id: string) => setHidden((prev) => toggleSeriesVisibility(prev, id));
  const hiddenCount = pfs.filter((p) => hidden.has(portfolioSeriesId(p.index))).length;

  return (
    <div className={styles.results}>
      <div className={`card ${styles.summary}`}>
        <div className={styles.summaryMain}>
          <div className={styles.summaryTitle}>{label || 'Backtest'}</div>
          <div className={styles.summaryMeta}>
            <span>{sim.display_start ?? sim.start ?? '?'} → {sim.end ?? '?'}</span>
            <span>{pfs.length} portfolio{pfs.length > 1 ? 's' : ''}</span>
            <span>calcul {fmtDuration(payload.duration_s)}</span>
            <span>moteur v{payload.engine_version}</span>
            {source === 'file' ? (
              <span className={styles.muted}>Fichier local (non enregistré)</span>
            ) : (
              <span className={runId ? styles.saved : saveError ? styles.saveErr : styles.muted}>
                {runId ? 'Enregistré dans l’historique ✓' : saveError ? `Non enregistré : ${saveError}` : 'Enregistrement…'}
              </span>
            )}
          </div>
        </div>
        <div className={styles.summaryControls}>
          {benchKeys.length > 0 && (
            <div className={styles.benchPicker}>
              <span className={styles.muted}>Benchmarks</span>
              {benchKeys.map((t) => {
                const on = benchmarks.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={`${styles.chip} ${on ? styles.chipOn : ''}`}
                    onClick={() => setBenchmarks((b) => (on ? b.filter((x) => x !== t) : [...b, t].sort()))}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          )}
          {hiddenCount > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHidden(new Set())}>
              Afficher les {hiddenCount} masqués
            </button>
          )}
          <OpenResultFile onError={setFileError} />
          {runId && (
            <Link href={`/rapport/${runId}`} target="_blank" className="btn btn-ghost btn-sm" title="Rapport imprimable / PDF">
              Rapport PDF
            </Link>
          )}
        </div>
      </div>

      {fileError && <div className={bt.errorBox}>{fileError}</div>}

      {(failed.length > 0 || payload.invalid_tickers.length > 0 || payload.warnings.length > 0) && (
        <div className={bt.warnBox}>
          <ul>
            {failed.map((p) => <li key={`f${p.index}`}><strong>{p.name}</strong> : {p.error}</li>)}
            {payload.invalid_tickers.length > 0 && <li>Tickers invalides : {payload.invalid_tickers.join(', ')}</li>}
            {payload.warnings.slice(0, 12).map((w, i) => <li key={`w${i}`}>{w}</li>)}
            {payload.warnings.length > 12 && <li>… {payload.warnings.length - 12} autres avertissements</li>}
          </ul>
        </div>
      )}

      {pfs.length === 0 ? (
        <div className={`card ${bt.empty}`}>
          <h2>Aucun portfolio n&apos;a produit de résultat</h2>
        </div>
      ) : (
        <>
          <nav className={styles.tabs} role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                title={t.hint}
                className={`${styles.tab} ${tab === t.id ? styles.tabOn : ''}`}
                onClick={() => openTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <TabPane active={tab === 'overview'} visited={visited.has('overview')}>
            <OverviewTab
              result={result}
              portfolios={pfs}
              hidden={hidden}
              onToggle={toggle}
              benchmarks={benchmarks}
              selected={selected}
              onSelect={setSelected}
            />
          </TabPane>
          <TabPane active={tab === 'focused'} visited={visited.has('focused')}>
            <FocusedTab result={result} portfolios={pfs} />
          </TabPane>
          <TabPane active={tab === 'periods'} visited={visited.has('periods')}>
            <PeriodsTab result={result} hidden={hidden} />
          </TabPane>
          <TabPane active={tab === 'portfolio'} visited={visited.has('portfolio')}>
            <PortfolioTab result={result} portfolios={pfs} selected={selected} onSelect={setSelected} />
          </TabPane>
          <TabPane active={tab === 'today'} visited={visited.has('today')}>
            <TodayTab result={result} portfolios={pfs} selected={selected} onSelect={setSelected} />
          </TabPane>
          <TabPane active={tab === 'tickers'} visited={visited.has('tickers')}>
            <TickersTab result={result} portfolios={pfs} />
          </TabPane>
          <TabPane active={tab === 'market'} visited={visited.has('market')}>
            <MarketTab summary={payload} />
          </TabPane>
          <TabPane active={tab === 'configs'} visited={visited.has('configs')}>
            <ConfigsTab portfolios={payload.portfolios} />
          </TabPane>
        </>
      )}
    </div>
  );
}