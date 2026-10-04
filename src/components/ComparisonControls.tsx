'use client';

import { useEffect, useState } from 'react';
import type { BenchmarkSymbol, PortfolioAccount } from '@/lib/types';
import { BENCHMARK_LABELS } from '@/lib/types';
import { listBacktestChoices, type BacktestChoice, type BacktestPick } from '@/lib/backtest/compare-curves';
import styles from './ComparisonControls.module.css';

const ALL_BENCHMARKS: BenchmarkSymbol[] = ['SPY', 'QQQ', 'XIU'];

interface Props {
  benchmarks: BenchmarkSymbol[];
  onBenchmarksChange: (next: BenchmarkSymbol[]) => void;
  otherAccounts: PortfolioAccount[];
  selectedAccountIds: string[];
  onAccountIdsChange: (ids: string[]) => void;
  backtests: BacktestPick[];
  onBacktestsChange: (next: BacktestPick[]) => void;
}

function toggleInList<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export default function ComparisonControls({
  benchmarks,
  onBenchmarksChange,
  otherAccounts,
  selectedAccountIds,
  onAccountIdsChange,
  backtests,
  onBacktestsChange,
}: Props) {
  const [choices, setChoices] = useState<BacktestChoice[] | null>(null);
  const [runId, setRunId] = useState('');
  const [index, setIndex] = useState('');

  useEffect(() => {
    let cancelled = false;
    listBacktestChoices()
      .then((c) => { if (!cancelled) setChoices(c); })
      .catch(() => { if (!cancelled) setChoices([]); });
    return () => { cancelled = true; };
  }, []);

  const run = choices?.find((c) => c.runId === runId);

  function addBacktest() {
    if (!run) return;
    const pf = run.portfolios.find((p) => String(p.index) === index);
    if (!pf) return;
    if (backtests.some((b) => b.runId === run.runId && b.index === pf.index)) return;
    onBacktestsChange([...backtests, { runId: run.runId, index: pf.index, label: `${pf.name} (${run.runLabel})` }]);
    setIndex('');
  }

  return (
    <div className={styles.comparison}>
      <div>
        <div className={styles.groupLabel}>Benchmarks</div>
        <div className={styles.chips}>
          {ALL_BENCHMARKS.map((sym) => {
            const on = benchmarks.includes(sym);
            return (
              <label key={sym} className={`${styles.chip} ${on ? styles.chipOn : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onBenchmarksChange(toggleInList(benchmarks, sym))}
                />
                {BENCHMARK_LABELS[sym]}
              </label>
            );
          })}
        </div>
      </div>
      <div>
        <div className={styles.groupLabel}>Autres comptes</div>
        {otherAccounts.length === 0 ? (
          <p className={styles.empty}>Aucun autre compte disponible.</p>
        ) : (
          <div className={styles.chips}>
            {otherAccounts.map((acc) => {
              const on = selectedAccountIds.includes(acc.id);
              return (
                <label key={acc.id} className={`${styles.chip} ${on ? styles.chipOn : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onAccountIdsChange(toggleInList(selectedAccountIds, acc.id))}
                  />
                  {acc.displayName}
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div>
        <div className={styles.groupLabel}>Runs du backtester</div>
        {backtests.length > 0 && (
          <div className={styles.chips}>
            {backtests.map((b) => (
              <span key={`${b.runId}:${b.index}`} className={`${styles.chip} ${styles.chipOn}`}>
                {b.label}
                <button
                  type="button"
                  className={styles.chipX}
                  aria-label={`Retirer ${b.label}`}
                  onClick={() => onBacktestsChange(backtests.filter((x) => !(x.runId === b.runId && x.index === b.index)))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {choices === null ? (
          <p className={styles.empty}>Chargement des runs…</p>
        ) : choices.length === 0 ? (
          <p className={styles.empty}>Aucun run sauvegardé : lance un backtest dans Construire pour pouvoir le comparer ici.</p>
        ) : (
          <div className={styles.addRow}>
            <select value={runId} onChange={(e) => { setRunId(e.target.value); setIndex(''); }}>
              <option value="">Choisir un run…</option>
              {choices.map((c) => (
                <option key={c.runId} value={c.runId}>
                  {c.runLabel} · {c.createdAt.slice(0, 10)} ({c.portfolios.length})
                </option>
              ))}
            </select>
            <select value={index} onChange={(e) => setIndex(e.target.value)} disabled={!run}>
              <option value="">Choisir un portefeuille…</option>
              {run?.portfolios.map((p) => (
                <option key={p.index} value={p.index}>{p.name}</option>
              ))}
            </select>
            <button type="button" className={styles.addBtn} onClick={addBacktest} disabled={!index}>
              Ajouter
            </button>
          </div>
        )}
        <p className={styles.hint}>
          La courbe du backtest est son rendement pur (sans ajouts de capital). Si les courbes ne commencent pas
          le même jour, tout est rebasé à 0 % au début commun ; une courbe qui se termine plus tôt s&apos;arrête là.
        </p>
      </div>
    </div>
  );
}
