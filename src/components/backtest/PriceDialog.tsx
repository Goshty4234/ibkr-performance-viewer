'use client';

import { useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

const plural = (n: number, word: string) => `${n.toLocaleString('fr-CA')} ${word}${n > 1 ? 's' : ''}`;

/** Before a launch: some tickers are stored but not up to date. Use them as they are, add only the missing days, or download everything again. */
export default function PriceDialog() {
  const offer = useBacktestStore((s) => s.priceOffer);
  const resolve = useBacktestStore((s) => s.resolvePrices);
  if (!offer) return null;
  const cancel = () => resolve('cancel');
  const stored = offer.current + offer.stale;
  const range = offer.stale_oldest_last === offer.stale_newest_last
    ? `au ${offer.stale_oldest_last}`
    : `entre le ${offer.stale_oldest_last} et le ${offer.stale_newest_last}`;

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className={`${styles.dialog} ${styles.dialogMid}`} role="dialog" aria-modal="true" onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}>
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>Prix des tickers</span>
          <button type="button" className={styles.iconBtn} onClick={cancel} aria-label="Fermer">✕</button>
        </div>
        <p className={styles.dupText}>
          {plural(stored, 'ticker')} sur {offer.total.toLocaleString('fr-CA')} sont déjà dans la base de tickers du moteur.{' '}
          <strong>{plural(offer.stale, 'ticker')}</strong> s’arrête{offer.stale > 1 ? 'nt' : ''} {range} et ne {offer.stale > 1 ? 'sont' : 'est'} pas à jour.
          {offer.missing > 0 && <> {plural(offer.missing, 'ticker')} jamais téléchargé{offer.missing > 1 ? 's' : ''} : historique complet dans tous les cas.</>}
        </p>

        <div className={styles.dialogActions}>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Annuler</button>
          <button type="button" className={`btn btn-secondary ${styles.choiceBtn}`} onClick={() => resolve('stored')}>
            <span>⚡ Utiliser tel quel · fin vers le {offer.stale_oldest_last}</span>
            <small>aucun appel Yahoo pour ces tickers</small>
          </button>
          <button type="button" className={`btn btn-secondary ${styles.choiceBtn}`} onClick={() => resolve('full')}>
            <span>↻ Tout retélécharger</span>
            <small>historiques complets, plus long</small>
          </button>
          <button type="button" className={`btn btn-primary ${styles.choiceBtn}`} autoFocus onClick={() => resolve('topup')}>
            <span>＋ Compléter les jours manquants</span>
            <small>seulement les jours récents · à jour</small>
          </button>
        </div>
      </div>
    </div>
  );
}
