import type { DbStatement } from '@/lib/types';
import { fmtPct } from '@/lib/performance';
import { formatDateLabel } from '@/lib/dates';
import { formatStatementPeriod } from '@/lib/privacy';
import styles from './StatementList.module.css';

interface Props {
  statements: DbStatement[];
  onDelete: (id: string) => void;
}

export default function StatementList({ statements, onDelete }: Props) {
  if (!statements.length) return null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>Historique importé</span>
        <span className={styles.count}>{statements.length} période{statements.length > 1 ? 's' : ''}</span>
      </div>
      <div className={styles.list}>
        {statements.map((s) => (
          <div key={s.id} className={styles.item}>
            <div>
              <div className={styles.filename}>{formatStatementPeriod(s)}</div>
              <div className={styles.meta}>
                {formatDateLabel(s.periodStart)} → {formatDateLabel(s.periodEnd)}
              </div>
            </div>
            <span className={`${styles.twrr} mono ${s.twrr >= 0 ? 'positive' : 'negative'}`}>
              {fmtPct(s.twrr * 100)}
            </span>
            <button type="button" className={styles.remove} onClick={() => onDelete(s.id)}>
              Supprimer
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
