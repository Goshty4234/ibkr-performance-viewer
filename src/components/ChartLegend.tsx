'use client';

import type { ChartSeriesDef } from '@/lib/chart-series';
import { isolateSeriesVisibility } from '@/lib/chart-series';
import styles from './ChartLegend.module.css';

interface Props {
  series: ChartSeriesDef[];
  hidden: Set<string>;
  onToggle: (seriesId: string) => void;
  /** Double-clic : n’afficher que cette courbe (encore une fois en solo → tout réafficher). */
  onHiddenChange?: (hidden: Set<string>) => void;
}

export default function ChartLegend({ series, hidden, onToggle, onHiddenChange }: Props) {
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
              title={onHiddenChange ? 'Clic : masquer/afficher · Double-clic : cette courbe seule' : undefined}
              onClick={(e) => {
                // Skip the second click of a double-click so isolate is not preceded by a toggle.
                if (e.detail > 1) return;
                onToggle(s.id);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                if (!onHiddenChange) return;
                onHiddenChange(isolateSeriesVisibility(series.map((x) => x.id), s.id, hidden));
              }}
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
        {onHiddenChange
          ? 'Clic : masquer ou afficher · Double-clic : cette courbe seule (encore une fois pour tout réafficher).'
          : 'Cliquez pour masquer ou afficher une courbe (performance, drawdown et tableau).'}
      </p>
    </div>
  );
}
