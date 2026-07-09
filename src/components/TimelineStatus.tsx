import type { TimelineHealth } from '@/lib/types';
import { formatDateLabel } from '@/lib/dates';
import styles from './TimelineStatus.module.css';

interface Props {
  health: TimelineHealth;
}

export default function TimelineStatus({ health }: Props) {
  const { rangeCoverage, gaps, isStale, dataEnd } = health;
  if (!rangeCoverage) return null;

  const hasWarning =
    rangeCoverage.message ||
    gaps.length > 0 ||
    isStale;

  if (!hasWarning && rangeCoverage.hasAnyData) return null;

  const variant = !rangeCoverage.hasAnyData
    ? styles.error
    : isStale || rangeCoverage.missingAfter
      ? styles.warn
      : styles.info;

  return (
    <div className={`${styles.banner} ${variant}`}>
      {!rangeCoverage.hasAnyData ? (
        <p><strong>Aucune donnée</strong> — {rangeCoverage.message}</p>
      ) : (
        <>
          {rangeCoverage.message && <p>{rangeCoverage.message}</p>}
          {gaps.length > 0 && (
            <ul className={styles.gaps}>
              {gaps.map((g) => (
                <li key={`${g.from}-${g.to}`}>
                  Trou de {g.days} jours : {formatDateLabel(g.from)} → {formatDateLabel(g.to)}
                </li>
              ))}
            </ul>
          )}
          {isStale && dataEnd && (
            <p className={styles.stale}>
              Dernières données : <strong>{formatDateLabel(dataEnd)}</strong>
              {health.daysSinceLastData != null && ` (${health.daysSinceLastData} jours)`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
