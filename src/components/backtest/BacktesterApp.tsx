'use client';

import { useEffect, useState } from 'react';
import { startCloudSync } from '@/lib/backtest/cloud-sync';
import { cleanupOldRuns } from '@/lib/backtest/history';
import { useBacktestStore, type BacktestView } from '@/lib/backtest/store';
import { useEngineStore } from '@/lib/engine/store';
import AllocationsView from './allocations/AllocationsView';
import HistoryView from './HistoryView';
import ImportExportDialog from './ImportExportDialog';
import LibraryDialog from './LibraryDialog';
import PortfolioEditor from './PortfolioEditor';
import PortfolioList from './PortfolioList';
import ResultsView from './ResultsView';
import ReuseDialog, { ReuseNoticeBar } from './ReuseDialog';
import RunBar from './RunBar';
import RunsPanel from './RunsPanel';
import styles from './Backtester.module.css';

const HIDDEN = { display: 'none' } as const;
// Stable elements: React skips these subtrees when only the active view changes.
const BUILD_VIEW = (
  <>
    <PortfolioList />
    <PortfolioEditor />
  </>
);
const RESULTS_VIEW = <ResultsView />;
const ALLOCATIONS_VIEW = <AllocationsView />;

const TABS: { id: BacktestView; label: string }[] = [
  { id: 'build', label: 'Construire' },
  { id: 'results', label: 'Résultats' },
  { id: 'allocations', label: 'Allocations' },
  { id: 'history', label: 'Historique' },
];

export default function BacktesterApp() {
  const view = useBacktestStore((s) => s.view);
  const setView = useBacktestStore((s) => s.setView);
  const hasPayload = useBacktestStore((s) => s.result !== null);
  const portfolioCount = useBacktestStore((s) => s.portfolios.length);
  const resumeRun = useBacktestStore((s) => s.resumeRun);
  const initEngine = useEngineStore((s) => s.init);
  const [dialog, setDialog] = useState<'import' | 'export' | 'library' | null>(null);
  const [visited, setVisited] = useState<Set<BacktestView>>(() => new Set([view]));

  useEffect(() => {
    setVisited((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  }, [view]);
  const mounted = (v: BacktestView) => v === view || visited.has(v);

  useEffect(() => {
    initEngine();
    resumeRun();
    startCloudSync();
    cleanupOldRuns().catch(() => {});
  }, [initEngine, resumeRun]);

  return (
    <div className={styles.app} data-wide>
      <div className={styles.topBar}>
        <div className={styles.tabs} role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view === t.id}
              className={`${styles.tab} ${view === t.id ? styles.tabActive : ''}`}
              onClick={() => setView(t.id)}
            >
              {t.label}
              {t.id === 'build' && <span className={styles.badge}>{portfolioCount}</span>}
              {t.id === 'results' && hasPayload && <span className={styles.badge}>●</span>}
            </button>
          ))}
        </div>
        <div className={styles.topActions}>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('library')}>
            Bibliothèque
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDialog('import')}>
            Importer JSON
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog('export')}>
            Exporter JSON
          </button>
        </div>
      </div>

      <RunBar />
      <RunsPanel />
      {view === 'results' && <ReuseNoticeBar purpose="backtest" />}
      {view === 'allocations' && <ReuseNoticeBar purpose="allocations" />}

      {/* Build and results stay mounted once opened: switching back is instant and keeps scroll/tab state. */}
      {mounted('build') && (
        <div className={styles.build} style={view === 'build' ? undefined : HIDDEN}>
          {BUILD_VIEW}
        </div>
      )}
      {mounted('results') && (
        <div style={view === 'results' ? undefined : HIDDEN}>
          {RESULTS_VIEW}
        </div>
      )}
      {mounted('allocations') && (
        <div style={view === 'allocations' ? undefined : HIDDEN}>
          {ALLOCATIONS_VIEW}
        </div>
      )}
      {view === 'history' && <HistoryView />}

      <ReuseDialog />
      {dialog === 'library' && <LibraryDialog onClose={() => setDialog(null)} />}
      {(dialog === 'import' || dialog === 'export') && <ImportExportDialog mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
