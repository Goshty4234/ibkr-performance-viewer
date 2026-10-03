import { fmtPct, pct } from '@/lib/storage/format';
import styles from './Storage.module.css';

/** Horizontal usage bar: orange from 70 %, red from 90 %. */
export default function Meter({ used, total, label }: { used: number; total: number | null; label?: string }) {
  const p = total ? Math.min(100, pct(used, total)) : 0;
  const cls = p >= 90 ? styles.meterDanger : p >= 70 ? styles.meterWarn : '';
  return (
    <div role="img" aria-label={label ?? `${fmtPct(p)} utilisé`}>
      <div className={styles.meter}>
        <div className={`${styles.meterFill} ${cls}`} style={{ width: `${total ? Math.max(p, used > 0 ? 0.8 : 0) : 0}%` }} />
      </div>
    </div>
  );
}
