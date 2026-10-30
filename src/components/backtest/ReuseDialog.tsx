'use client';

import { useMemo, useState } from 'react';
import { daysBetween, decide, type ReuseOffer } from '@/lib/backtest/reuse';
import { useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `aujourd’hui à ${d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })}`
    : `le ${d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** `2026-10-30` → `30 oct. 2026`, without shifting the day through a timezone. */
function pretty(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[(m || 1) - 1]} ${y}`;
}

/** Before a launch: portfolios already computed with exactly the same settings, taken by default. */
export default function ReuseDialog() {
  const offer = useBacktestStore((s) => s.reuseOffer);
  return offer ? <Prompt key={offer.plan.portfolios.map((p) => p.history_key).join()} offer={offer} /> : null;
}

function Prompt({ offer }: { offer: ReuseOffer }) {
  const resolve = useBacktestStore((s) => s.resolveReuse);
  const available = offer.items.filter((i) => i.sources.length);
  const [checked, setChecked] = useState(() => new Set(available.map((i) => i.position)));
  const decision = useMemo(() => decide(offer, checked), [offer, checked]);
  const late = daysBetween(decision.end, offer.targetEnd);

  const toggle = (pos: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(pos)) next.add(pos);
      return next;
    });
  const cancel = () => resolve({ action: 'cancel' });
  const accept = () => resolve({ action: 'reuse', accepted: [...checked] });

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
                        ? `recalculé jusqu’au ${pretty(decision.end)} (fusion ou date de fin commune)`
                        : `calculé ${when(best.row.created_at)} · s’arrête au ${pretty(best.end)}`}
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

        {late > 0 && (
          <div className={styles.reuseEnd}>
            L’historique s’arrête au <strong>{pretty(decision.end)}</strong> ({plural(late, 'jour')} avant {offer.untilToday ? `aujourd’hui, le ${pretty(offer.targetEnd)}` : `le ${pretty(offer.targetEnd)}`}).
            Le bouton bleu va jusqu’à cette date et met les prix à jour. « Reprendre » garde le résultat déjà calculé et ne le dépasse pas.
          </div>
        )}

        <div className={styles.dialogActions}>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Annuler</button>
          {late > 0 && decision.reuse.size > 0 && (
            <button type="button" className={`btn btn-secondary ${styles.choiceBtn}`} onClick={accept}>
              <span>{`♻ Reprendre · fin au ${pretty(decision.end)}`}</span>
              <small>{`${plural(late, 'jour')} de retard · ne va pas plus loin · instantané`}</small>
            </button>
          )}
          {decision.reuse.size > 0 && (
            <button type="button" className={`btn ${late > 0 ? 'btn-primary' : 'btn-secondary'} ${styles.choiceBtn}`} autoFocus={late > 0} onClick={() => resolve({ action: 'fresh' })}>
              <span>{offer.untilToday ? `↻ Tout recalculer jusqu’à aujourd’hui · ${pretty(offer.targetEnd)}` : `↻ Tout recalculer jusqu’au ${pretty(offer.targetEnd)}`}</span>
              <small>{late > 0 ? 'dépasse l’historique · prix à jour · recalcul complet' : 'même résultat · recalcul complet, plus lent'}</small>
            </button>
          )}
          {late === 0 && (
            <button type="button" className={`btn btn-primary ${styles.choiceBtn}`} autoFocus onClick={accept}>
              <span>{decision.reuse.size ? `♻ Reprendre · fin au ${pretty(decision.end)}` : `Lancer jusqu’au ${pretty(decision.end)}`}</span>
              <small>
                {!decision.compute.length
                  ? 'à jour · instantané'
                  : `${decision.reuse.size} repris · ${decision.compute.length} à calculer`}
              </small>
            </button>
          )}
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
