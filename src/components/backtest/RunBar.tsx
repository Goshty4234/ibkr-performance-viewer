'use client';

import { useState } from 'react';
import { isActive, useBacktestStore } from '@/lib/backtest/store';
import { engineOutdated } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import EngineSetup from './EngineSetup';
import EngineUpdate from './EngineUpdate';
import EngineWait from './EngineWait';
import RunHelp from './RunHelp';
import { TIPS } from './tips';
import styles from './Backtester.module.css';

export default function RunBar() {
  const options = useBacktestStore((s) => s.options);
  const setOptions = useBacktestStore((s) => s.setOptions);
  const activeCount = useBacktestStore((s) => s.runs.filter(isActive).length);
  const launchError = useBacktestStore((s) => s.launchError);
  const startRun = useBacktestStore((s) => s.startRun);
  const count = useBacktestStore((s) => s.portfolios.length);
  const engineStatus = useEngineStore((s) => s.status);
  const engine = useEngineStore((s) => s.engine);
  const [launching, setLaunching] = useState(false);

  const customDates = options.start_date !== null || options.end_date !== null;
  const launch = async () => {
    setLaunching(true);
    try {
      await startRun();
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className={`card ${styles.runBar}`}>
      <div className={styles.optionsGrid}>
        <label className={styles.field} title={TIPS.startWith}>
          Début de la simulation
          <select
            value={options.start_with}
            onChange={(e) => setOptions({ start_with: e.target.value as 'all' | 'oldest' })}
          >
            <option value="all">Quand tous les actifs ont des données</option>
            <option value="oldest">Dès l&apos;actif le plus ancien</option>
          </select>
        </label>
        <label className={styles.field} title={TIPS.firstRebalance}>
          Premier rebalancement
          <select
            value={options.first_rebalance_strategy}
            onChange={(e) => setOptions({ first_rebalance_strategy: e.target.value as 'rebalancing_date' | 'momentum_window_complete' })}
          >
            <option value="momentum_window_complete">Fenêtre momentum complète</option>
            <option value="rebalancing_date">Première date de rebalancement</option>
          </select>
        </label>
        <div className={styles.field} title={TIPS.customDates}>
          Période
          <label className={styles.checkRow} style={{ minHeight: 36 }}>
            <input
              type="checkbox"
              checked={customDates}
              onChange={(e) =>
                setOptions(
                  e.target.checked
                    ? { start_date: '2010-01-01', end_date: new Date().toISOString().slice(0, 10) }
                    : { start_date: null, end_date: null },
                )
              }
            />
            Dates personnalisées
          </label>
        </div>
        {customDates && (
          <>
            <label className={styles.field}>
              Du
              <input
                type="date"
                value={options.start_date ?? ''}
                onChange={(e) => setOptions({ start_date: e.target.value || null })}
              />
            </label>
            <label className={styles.field}>
              Au
              <input
                type="date"
                value={options.end_date ?? ''}
                onChange={(e) => setOptions({ end_date: e.target.value || null })}
              />
            </label>
          </>
        )}
        <div className={styles.field}>
          Momentum
          <label className={styles.checkRow} style={{ minHeight: 36 }} title={TIPS.preheat}>
            <input
              type="checkbox"
              checked={options.auto_adjust_momentum_start}
              onChange={(e) => setOptions({ auto_adjust_momentum_start: e.target.checked })}
            />
            Ajuster le début (pré-chauffe)
          </label>
        </div>
      </div>

      <div className={styles.runSide}>
        <button
          type="button"
          className={`btn btn-primary btn-lg ${styles.runBtn}`}
          disabled={!count || engineStatus === 'detecting' || launching || engineOutdated(engine?.health)}
          onClick={() => void launch()}
          title={`Backtest complet des ${count} portfolio${count > 1 ? 's' : ''} de Construire, résultats dans l’onglet Résultats${engine ? ` · moteur : ${engine.url}` : ''}`}
        >
          {engineStatus === 'detecting' ? (
            <><span className={styles.btnSpin} />Connexion au moteur… patiente</>
          ) : launching ? (
            <><span className={styles.btnSpin} />Lancement en cours…</>
          ) : (
            <>🚀 Lancer le backtest complet ({count})</>
          )}
        </button>
        {engineOutdated(engine?.health) && (
          <span className={styles.engineNote}>Ton moteur est trop ancien pour ce site : mets-le à jour (bouton ci-dessous) ou télécharge la dernière version.</span>
        )}
        {activeCount > 0 && (
          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
            {activeCount} run{activeCount > 1 ? 's' : ''} en cours — tu peux en lancer d&apos;autres en parallèle.
          </span>
        )}
        {engineStatus === 'detecting' && <EngineWait />}
        {engineStatus === 'offline' && <EngineSetup />}
        {(engineStatus === 'ready' || engineStatus === 'detecting') && <EngineUpdate />}
        {launchError && <div className={styles.errorBox}>{launchError}</div>}
      </div>
      <RunHelp />
    </section>
  );
}
