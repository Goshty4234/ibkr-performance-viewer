'use client';

import { useEffect, useState } from 'react';
import { isActive, useBacktestStore } from '@/lib/backtest/store';
import { engineOutdated } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import EngineSetup from '../EngineSetup';
import EngineUpdate from '../EngineUpdate';
import styles from '../Backtester.module.css';

/** Allocations' own launcher: one portfolio at a time, none of the full-backtest options. */
export default function AllocRunBar() {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const focus = useBacktestStore((s) => s.alloc?.focus ?? null);
  const startAllocationRun = useBacktestStore((s) => s.startAllocationRun);
  const launchError = useBacktestStore((s) => s.launchError);
  const activeRun = useBacktestStore((s) => s.runs.find((r) => r.purpose === 'allocations' && isActive(r)) ?? null);
  const engineStatus = useEngineStore((s) => s.status);
  const outdated = useEngineStore((s) => engineOutdated(s.engine?.health));
  const [selectedId, setSelectedId] = useState<string>('');
  const [launching, setLaunching] = useState(false);

  // Follow the portfolio on screen so "Lancer" refreshes what is displayed by default.
  useEffect(() => {
    const shown = focus ? portfolios.find((p) => p.name === focus) : null;
    if (shown) setSelectedId(shown._id);
  }, [focus, portfolios]);

  const selected = portfolios.find((p) => p._id === selectedId) ?? portfolios[0] ?? null;
  const progress = activeRun?.job ? Math.round((activeRun.job.progress ?? 0) * 100) : 0;
  const busy = launching || !!activeRun;

  const launch = async () => {
    if (!selected) return;
    setLaunching(true);
    try {
      await startAllocationRun(selected._id);
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className={`card ${styles.runBar}`}>
      <div className={styles.allocRunMain}>
        <label className={styles.field}>
          Portfolio à analyser
          <select value={selected?._id ?? ''} onChange={(e) => setSelectedId(e.target.value)} disabled={!portfolios.length}>
            {portfolios.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
                {p.fusion_portfolio?.enabled ? ' · fusion' : ` · ${p.stocks.filter((s) => s.ticker).length} titres`}
                {p.use_momentum ? ' · momentum' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className={styles.allocRunText}>
          Calcule l’allocation cible d’aujourd’hui pour <strong>ce portfolio seulement</strong>, tel qu’il est dans Construire
          (pas besoin de lancer le backtest complet avant). Si ce portfolio a déjà été analysé aujourd’hui avec les mêmes réglages,
          l’analyse enregistrée revient directement (bandeau ♻, avec « Recalculer quand même »).
        </p>
      </div>

      <div className={styles.runSide}>
        <button
          type="button"
          className={`btn btn-primary btn-lg ${styles.runBtn}`}
          disabled={!selected || busy || engineStatus === 'detecting' || outdated}
          onClick={() => void launch()}
          title={selected ? `Allocation du jour de « ${selected.name} »` : 'Crée d’abord un portfolio dans Construire'}
        >
          {activeRun ? `Calcul… ${progress}%` : '▶ Lancer l’allocation'}
        </button>
        {activeRun && (
          <div className={styles.allocRunProgress}><span style={{ width: `${Math.max(4, progress)}%` }} /></div>
        )}
        {engineStatus === 'offline' && <EngineSetup />}
        {engineStatus === 'ready' && <EngineUpdate />}
        {!portfolios.length && <span className={styles.runNote}>Aucun portfolio : crée-en un dans Construire.</span>}
        {launchError && <div className={styles.errorBox}>{launchError}</div>}
      </div>
    </section>
  );
}
