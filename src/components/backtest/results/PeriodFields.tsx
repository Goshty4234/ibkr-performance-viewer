'use client';

import { PERIOD_PRESETS, presetStart } from '@/lib/backtest/period-range';
import styles from '../Results.module.css';

export default function PeriodFields({
  start,
  end,
  min,
  max,
  onChange,
}: {
  start: string;
  end: string;
  min: string;
  max: string;
  onChange: (start: string, end: string) => void;
}) {
  return (
    <>
      <label className={styles.inlineField}>
        Début
        <input type="date" className="input" value={start} min={min} max={max} onChange={(e) => onChange(e.target.value, end)} />
      </label>
      <label className={styles.inlineField}>
        Fin
        <input type="date" className="input" value={end} min={min} max={max} onChange={(e) => onChange(start, e.target.value)} />
      </label>
      <div className={styles.segment}>
        {PERIOD_PRESETS.map((p) => (
          <button key={p.label} type="button" onClick={() => onChange(presetStart(max, min, p.years), max)}>{p.label}</button>
        ))}
      </div>
    </>
  );
}
