import type { DatePreset } from '@/lib/types';
import { DATE_PRESET_LABELS } from '@/lib/types';
import { applyDatePreset } from '@/lib/timeline';
import styles from './DateRangeControls.module.css';

interface Props {
  bounds: { min: string; max: string };
  rangeStart: string;
  rangeEnd: string;
  activePreset: DatePreset | null;
  onPreset: (preset: DatePreset) => void;
  onRangeChange: (start: string, end: string) => void;
}

const PRESETS: DatePreset[] = ['1W', '1M', 'MTD', '3M', '6M', '1Y', 'YTD', 'MAX'];

export default function DateRangeControls({
  bounds,
  rangeStart,
  rangeEnd,
  activePreset,
  onPreset,
  onRangeChange,
}: Props) {
  const start = rangeStart ?? '';
  const end = rangeEnd ?? '';
  const ready = Boolean(start && end);

  return (
    <div className={styles.wrap}>
      <div className={styles.presets}>
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`${styles.preset} ${activePreset === p ? styles.presetActive : ''}`}
            onClick={() => {
              const { start, end } = applyDatePreset(p, bounds);
              onPreset(p);
              onRangeChange(start, end);
            }}
          >
            {DATE_PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      {ready && (
      <div className={styles.custom}>
        <input
          type="date"
          value={start}
          min={bounds.min}
          max={end}
          onChange={(e) => onRangeChange(e.target.value, end)}
        />
        <span className={styles.sep}>→</span>
        <input
          type="date"
          value={end}
          min={start}
          max={bounds.max}
          onChange={(e) => onRangeChange(start, e.target.value)}
        />
      </div>
      )}
    </div>
  );
}
