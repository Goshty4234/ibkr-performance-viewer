'use client';

import { useState } from 'react';
import type { DbNavSeries, DbStatement } from '@/lib/types';
import { fmtPct } from '@/lib/performance';
import { formatDateLabel } from '@/lib/dates';
import { formatStatementPeriod } from '@/lib/privacy';
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
  const [open, setOpen] = useState(false);
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
      const portfolioIds = [
        ...new Set(statements.map((s) => s.portfolioAccountId).filter(Boolean)),
      ] as string[];
      for (const id of portfolioIds) {
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
    if (!confirm(`Supprimer la courbe NAV (${navSeries.points.length} jours) ?`)) {
      return;
    }
    setDeletingNav(true);
    await onDeleteNavSeries();
    setDeletingNav(false);
  }

  return (
    <div className={`card ${styles.panel}`}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          <strong>Données importées</strong>
          <span className={styles.toggleSub}>
            {importCount} import{importCount > 1 ? 's' : ''}
            {accountId !== 'all' && ` · ${accountLabel}`}
          </span>
        </span>
        <span className={styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
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
                  <div className={styles.filename}>Flex NAV</div>
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
                    <div className={styles.filename}>{formatStatementPeriod(s)}</div>
                    <div className={styles.meta}>
                      {(s.twrDaily?.length ?? 0) > 0
                        ? `Rapport TWR IBKR · ${s.twrDaily!.length} jours · `
                        : 'Activity Statement · '}
                      {formatDateLabel(s.periodStart)} → {formatDateLabel(s.periodEnd)}
                    </div>
                  </div>
                  <span className={`${styles.twrr} ${(s.twrDaily?.length ?? 0) > 0 ? styles.badgeNav : ''} mono ${s.twrr >= 0 ? 'positive' : 'negative'}`}>
                    {fmtPct(s.twrr * 100)}
                  </span>
                  <button type="button" className={styles.remove} onClick={() => onDelete(s.id)}>
                    Supprimer
                  </button>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
