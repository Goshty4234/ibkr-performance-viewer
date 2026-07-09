'use client';

import type { ChartSeriesDef } from '@/lib/chart-series';
import styles from './ChartLegend.module.css';

interface Props {
  series: ChartSeriesDef[];
  hidden: Set<string>;
  onToggle: (seriesId: string) => void;
}

export default function ChartLegend({ series, hidden, onToggle }: Props) {
  if (series.length < 2) return null;

  return (
    <div>
      <div className={styles.legend} role="listbox" aria-label="Courbes affichées">
        {series.map((s) => {
          const off = hidden.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={!off}
              className={`${styles.item} ${off ? styles.itemOff : ''}`}
              onClick={() => onToggle(s.id)}
            >
              {s.strokeDasharray ? (
                <span
                  className={styles.swatchDashed}
                  style={{ borderColor: s.color }}
                  aria-hidden
                />
              ) : (
                <span className={styles.swatch} style={{ background: s.color }} aria-hidden />
              )}
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
      <p className={styles.hint}>
        Cliquez pour masquer ou afficher une courbe (performance, drawdown et tableau).
      </p>
    </div>
  );
}
