'use client';

import { useMemo, useState } from 'react';
import { daysBetween, decide, type ReuseOffer } from '@/lib/backtest/reuse';
import { setAutoReuse, useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `aujourd’hui à ${d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`
    : `le ${d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Before a launch: portfolios already computed with exactly the same settings, taken by default. */
export default function ReuseDialog() {
  const offer = useBacktestStore((s) => s.reuseOffer);
  return offer ? <Prompt key={offer.plan.portfolios.map((p) => p.history_key).join()} offer={offer} /> : null;
}

function Prompt({ offer }: { offer: ReuseOffer }) {
  const resolve = useBacktestStore((s) => s.resolveReuse);
  const available = offer.items.filter((i) => i.sources.length);
  const [checked, setChecked] = useState(() => new Set(available.map((i) => i.position)));
  const [remember, setRemember] = useState(false);
  const decision = useMemo(() => decide(offer, checked), [offer, checked]);
  const late = daysBetween(decision.end, offer.targetEnd);

  const toggle = (pos: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(pos)) next.add(pos);
      return next;
    });
  const cancel = () => resolve({ action: 'cancel' });
  const accept = () => {
    if (remember) setAutoReuse(true);
    resolve({ action: 'reuse', accepted: [...checked] });
  };

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className={`${styles.dialog} ${styles.dialogMid}`} role="dialog" aria-modal="true" onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}>
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>
            {available.length === offer.items.length ? 'Déjà calculé' : `${available.length} portfolio${available.length > 1 ? 's' : ''} sur ${offer.items.length} déjà calculé${available.length > 1 ? 's' : ''}`}
          </span>
          <button type="button" className={styles.iconBtn} onClick={cancel} aria-label="Fermer">✕</button>
        </div>
        <p className={styles.dupText}>
          Ces portfolios ont déjà tourné avec <strong>exactement</strong> les mêmes réglages (tickers, options, début de simulation…).
          Seule la date de fin peut différer. Les reprendre donne le même résultat, sans recalcul.
        </p>

        <div className={styles.reuseList}>
          {offer.items.map((item) => {
            const best = item.sources[0];
            const on = checked.has(item.position);
            const taken = decision.reuse.has(item.position);
            const behind = best ? daysBetween(best.end, offer.targetEnd) : 0;
            return (
              <label key={item.position} className={`${styles.reuseRow} ${best ? '' : styles.reuseRowOff}`}>
                <input type="checkbox" disabled={!best} checked={on} onChange={() => toggle(item.position)} />
                <span className={styles.reuseName}>
                  {item.name}
                  <span className={styles.reuseInfo}>
                    {!best
                      ? 'jamais calculé avec ces réglages'
                      : on && !taken
                        ? `recalculé jusqu’au ${decision.end} (fusion ou date de fin commune)`
                        : `calculé ${when(best.row.created_at)} · données jusqu’au ${best.end}`}
                  </span>
                </span>
                {!best || !on ? (
                  <span className={styles.pill}>à calculer</span>
                ) : behind <= 0 ? (
                  <span className={`${styles.pill} ${styles.pillOk}`}>à jour</span>
                ) : (
                  <span className={`${styles.pill} ${styles.pillLate}`}>{plural(behind, 'jour')} de retard</span>
                )}
              </label>
            );
          })}
        </div>

        <div className={styles.reuseEnd}>
          {late > 0 ? (
            <>Fin du backtest : <strong>{decision.end}</strong> ({plural(late, 'jour')} avant {offer.targetEnd}), la fin la plus ancienne des résultats repris.</>
          ) : (
            <>Fin du backtest : <strong>{decision.end}</strong>, à jour.</>
          )}
          <br />
          {decision.compute.length
            ? `${plural(decision.reuse.size, 'portfolio')} repris · ${plural(decision.compute.length, 'portfolio')} à calculer.`
            : 'Rien à calculer : résultat instantané.'}
        </div>

        <label className={styles.checkRow}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Toujours reprendre sans demander quand tout est à jour
        </label>
        <div className={styles.dialogActions}>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Annuler</button>
          <button type="button" className="btn btn-secondary" onClick={() => resolve({ action: 'fresh' })}>Tout recalculer à jour</button>
          <button type="button" className="btn btn-primary" autoFocus onClick={accept}>
            {decision.reuse.size ? 'Reprendre et lancer' : 'Lancer'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Banner above a result that was reopened instead of recomputed, with a way to recompute. */
export function ReuseNoticeBar({ purpose }: { purpose: 'backtest' | 'allocations' }) {
  const notice = useBacktestStore((s) => s.reuseNotice);
  const dismiss = useBacktestStore((s) => s.dismissReuseNotice);
  if (!notice || notice.purpose !== purpose) return null;
  return (
    <div className={styles.reuseBar}>
      <span>
        {notice.exact
          ? <>♻ Résultat identique déjà calculé {when(notice.createdAt)} — repris instantanément au lieu de relancer.</>
          : <>♻ Analyse du jour reprise (calculée {when(notice.createdAt)}, prix de ce moment-là, marché ouvert).</>}
      </span>
      <span className={styles.reuseActions}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { dismiss(); notice.rerun(); }}>Recalculer quand même</button>
        <button type="button" className={styles.iconBtn} onClick={dismiss} aria-label="Masquer">✕</button>
      </span>
    </div>
  );
}
