'use client';

import { useEffect, useState } from 'react';
import { RETENTION_DAYS } from '@/lib/backtest/history';
import { isActive, type RunState, useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h${String(m % 60).padStart(2, '0')}`;
  if (m) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

function reusedText(n: number | undefined): string {
  return n ? ` · ${n} déjà calculé${n > 1 ? 's' : ''} (réutilisé${n > 1 ? 's' : ''})` : '';
}

function statusText(run: RunState): string {
  const job = run.job;
  switch (run.phase) {
    case 'submitting': return 'Envoi au moteur…';
    case 'queued': return `En file d'attente${job?.queue_position ? ` (position ${job.queue_position})` : ''}…`;
    case 'running': {
      const tasks = job?.tasks_total ? ` · ${job.tasks_done ?? 0}/${job.tasks_total} tâches` : '';
      return `${job?.message || 'Calcul en cours…'}${tasks}${reusedText(job?.tasks_reused)}`;
    }
    case 'fetching': return 'Réception des résultats…';
    case 'done': {
      const fromHistory = run.reusedCount ? ` · ${run.reusedCount} repris de l’historique` : '';
      const saved = run.savedId ? ' · enregistré dans l’Historique' : '';
      return `Terminé en ${fmtElapsed((run.finishedAt ?? 0) - (run.startedAt ?? 0))}${fromHistory}${reusedText(job?.summary?.reused)}${saved}`;
    }
    case 'cancelled': return 'Annulé';
    case 'error': return run.error ?? 'Erreur';
    default: return '';
  }
}

function RunRow({ run, now, current }: { run: RunState; now: number; current: boolean }) {
  const cancelRun = useBacktestStore((s) => s.cancelRun);
  const dismissRun = useBacktestStore((s) => s.dismissRun);
  const openRun = useBacktestStore((s) => s.openRun);
  const [opening, setOpening] = useState(false);
  const active = isActive(run);
  const pct = run.phase === 'done' ? 100 : Math.round((run.job?.progress ?? 0) * 100);

  const open = async () => {
    setOpening(true);
    try {
      await openRun(run.id);
    } finally {
      setOpening(false);
    }
  };

  return (
    <li className={`${styles.runRow} ${current ? styles.runRowCurrent : ''}`}>
      <div className={styles.runRowHead}>
        <span className={styles.runRowLabel} title={run.label}>{run.label}</span>
        <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>
          {run.portfolioCount} pf · {run.engineKind === 'local' ? 'PC' : 'en ligne'}
          {active && ` · ${pct}% · ${fmtElapsed(now - (run.startedAt ?? now))}`}
        </span>
      </div>
      {active && (
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
      )}
      <div className={styles.runRowFoot}>
        <span
          className={styles.progressMsg}
          style={{ color: run.phase === 'error' ? 'var(--red)' : run.phase === 'done' ? 'var(--green)' : undefined }}
          title={statusText(run)}
        >
          {statusText(run)}
          {active && run.error && <span style={{ color: 'var(--orange)' }}> · connexion instable</span>}
        </span>
        <span className={styles.runRowActions}>
          {active && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cancelRun(run.id)}>Annuler</button>
          )}
          {run.phase === 'done' && !current && (
            <button type="button" className="btn btn-primary btn-sm" disabled={opening} onClick={() => void open()}>
              {opening ? '…' : 'Voir'}
            </button>
          )}
          {!active && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={run.savedId ? 'Retirer de cette liste seulement : le run reste dans l’Historique' : 'Retirer de cette liste'}
              onClick={() => dismissRun(run.id)}
            >
              ✕
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

/** Every run launched from this browser: several can run in parallel on the engine pool. */
export default function RunsPanel() {
  const runs = useBacktestStore((s) => s.runs);
  const currentKey = useBacktestStore((s) => s.result?.key ?? null);
  const allocKey = useBacktestStore((s) => s.alloc?.result.key ?? null);
  const isCurrent = (r: RunState) => {
    const keys = [`merge:${r.id}`, ...(r.job ? [`job:${r.job.id}`] : [])];
    return keys.includes(r.purpose === 'allocations' ? allocKey ?? '' : currentKey ?? '');
  };
  const [now, setNow] = useState(Date.now());
  const [collapsed, setCollapsed] = useState(false);
  const setView = useBacktestStore((s) => s.setView);
  const activeCount = runs.filter(isActive).length;

  useEffect(() => {
    if (!activeCount) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [activeCount]);

  if (!runs.length) return null;
  const finished = runs.filter((r) => !isActive(r));

  return (
    <section className={`card ${styles.runsPanel}`}>
      <div className={styles.runsHead}>
        <button type="button" className={styles.runsToggle} onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          {collapsed ? '▸' : '▾'} Runs {activeCount > 0 ? `en cours (${activeCount})` : 'récents'}
          {finished.length > 0 && activeCount > 0 && <span style={{ color: 'var(--text-faint)' }}> · {finished.length} terminé{finished.length > 1 ? 's' : ''}</span>}
        </button>
        <span className={styles.runsHeadActions}>
          {finished.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Vide cette liste seulement : l’Historique n’est pas touché"
              onClick={() => finished.forEach((r) => useBacktestStore.getState().dismissRun(r.id))}
            >
              Vider la liste
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setView('history')}>Historique →</button>
        </span>
      </div>
      {!collapsed && (
        <p className={styles.runsNote}>
          Suivi des runs lancés depuis ce navigateur. Chaque run terminé est aussi enregistré dans l’Historique (compte connecté, gardé {RETENTION_DAYS} jours, ou plus s’il est épinglé).
          ✕ retire seulement de cette liste, jamais de l’Historique.
        </p>
      )}
      {!collapsed && (
        <ul className={styles.runList}>
          {runs.map((r) => (
            <RunRow key={r.id} run={r} now={now} current={isCurrent(r)} />
          ))}
        </ul>
      )}
    </section>
  );
}
