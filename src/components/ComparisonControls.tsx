'use client';

import type { BenchmarkSymbol, PortfolioAccount } from '@/lib/types';
import { BENCHMARK_LABELS } from '@/lib/types';
import styles from './ComparisonControls.module.css';

const ALL_BENCHMARKS: BenchmarkSymbol[] = ['SPY', 'QQQ', 'XIU'];

interface Props {
  benchmarks: BenchmarkSymbol[];
  onBenchmarksChange: (next: BenchmarkSymbol[]) => void;
  otherAccounts: PortfolioAccount[];
  selectedAccountIds: string[];
  onAccountIdsChange: (ids: string[]) => void;
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
}: Props) {
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
    </div>
  );
}
