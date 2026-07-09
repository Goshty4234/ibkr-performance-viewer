'use client';

import { useState } from 'react';
import type { DbNavSeries, DbStatement } from '@/lib/types';
import { fmtPct } from '@/lib/performance';
import { formatDateLabel } from '@/lib/dates';
import styles from './DataPanel.module.css';

interface Props {
  statements: DbStatement[];
  navSeries: DbNavSeries | null;
  accountId: string;
  accountLabel: string;
  onDelete: (id: string) => void;
  onDeleteNavSeries: () => Promise<void>;
  onDeleteRange: (accountId: string, start: string, end: string) => Promise<void>;
}

export default function DataPanel({
  statements,
  navSeries,
  accountId,
  accountLabel,
  onDelete,
  onDeleteNavSeries,
  onDeleteRange,
}: Props) {
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deletingNav, setDeletingNav] = useState(false);

  const importCount = statements.length + (navSeries ? 1 : 0);
  if (!importCount) return null;

  async function handleBulkDelete() {
    if (!rangeStart || !rangeEnd) return;
    if (rangeStart > rangeEnd) {
      alert('La date de début doit être avant la date de fin.');
      return;
    }
    const msg = accountId === 'all'
      ? `Supprimer toutes les données du ${formatDateLabel(rangeStart)} au ${formatDateLabel(rangeEnd)} pour TOUS les comptes ?`
      : `Supprimer les données de « ${accountLabel} » du ${formatDateLabel(rangeStart)} au ${formatDateLabel(rangeEnd)} ?`;

    if (!confirm(msg)) return;

    setDeleting(true);
    if (accountId === 'all') {
      const accountIds = [...new Set(statements.map((s) => s.accountId))];
      for (const id of accountIds) {
        await onDeleteRange(id, rangeStart, rangeEnd);
      }
    } else {
      await onDeleteRange(accountId, rangeStart, rangeEnd);
    }
    setDeleting(false);
    setRangeStart('');
    setRangeEnd('');
  }

  async function handleDeleteNav() {
    if (!navSeries) return;
    if (!confirm(`Supprimer la courbe NAV « ${navSeries.filename} » (${navSeries.points.length} jours) ?`)) {
      return;
    }
    setDeletingNav(true);
    await onDeleteNavSeries();
    setDeletingNav(false);
  }

  return (
    <div className={`card ${styles.panel}`}>
      <div className={styles.header}>
        <div>
          <h2>Données importées</h2>
          <p className={styles.sub}>
            {importCount} import{importCount > 1 ? 's' : ''} en base
            {accountId !== 'all' && ` · ${accountLabel}`}
          </p>
        </div>
      </div>

      {statements.length > 0 && (
        <div className={styles.bulkDelete}>
          <span className={styles.bulkLabel}>Supprimer une plage de dates (Activity Statements)</span>
          <div className={styles.bulkRow}>
            <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
            <span>→</span>
            <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleBulkDelete}
              disabled={deleting || !rangeStart || !rangeEnd}
            >
              {deleting ? 'Suppression…' : 'Supprimer la plage'}
            </button>
          </div>
          <p className={styles.bulkHint}>
            Suppression définitive de la base de données — pas seulement masquée.
          </p>
        </div>
      )}

      <div className={styles.list}>
        {navSeries && (
          <div className={styles.item}>
            <div>
              <div className={styles.filename}>{navSeries.filename}</div>
              <div className={styles.meta}>
                Flex NAV · {navSeries.points.length} jours
                {navSeries.cashFlows?.length
                  ? ` · ${navSeries.cashFlows.length} flux capitaux`
                  : ''}{' '}
                ·{' '}
                {formatDateLabel(navSeries.periodStart || navSeries.points[0]?.date)} →{' '}
                {formatDateLabel(navSeries.periodEnd || navSeries.points[navSeries.points.length - 1]?.date)}
              </div>
            </div>
            <span className={`${styles.twrr} ${styles.badgeNav}`}>NAV/jour</span>
            <button
              type="button"
              className={styles.remove}
              onClick={handleDeleteNav}
              disabled={deletingNav}
            >
              {deletingNav ? '…' : 'Supprimer'}
            </button>
          </div>
        )}
        {[...statements]
          .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
          .map((s) => (
            <div key={s.id} className={styles.item}>
              <div>
                <div className={styles.filename}>{s.filename}</div>
                <div className={styles.meta}>
                  {formatDateLabel(s.periodStart)} → {formatDateLabel(s.periodEnd)}
                  {s.accountAlias && accountId === 'all' && ` · ${s.accountAlias}`}
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
