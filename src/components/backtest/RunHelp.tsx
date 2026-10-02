import styles from './Backtester.module.css';

const ITEMS: { what: string; where: string; does: string; reuse?: string }[] = [
  {
    what: '🚀 Lancer le backtest complet (N)',
    where: 'Barre du haut · N = nombre de portfolios dans Construire',
    does:
      'Backtest complet de tous les portfolios de Construire, sur tout l’historique ou sur les dates personnalisées de cette barre. '
      + 'Statistiques, graphiques, périodes et détail par portfolio arrivent dans l’onglet Résultats.',
    reuse:
      'Si un portfolio a déjà tourné avec exactement les mêmes réglages (n’importe quel jour), une fenêtre « Déjà calculé » s’ouvre : '
      + '« ♻ Reprendre · fin au … » reprend ces résultats (le backtest s’arrête à leur date de fin la plus ancienne) et ne calcule que le reste ; '
      + '« ↻ Tout recalculer jusqu’au … » relance tout jusqu’à aujourd’hui. Chaque bouton affiche sa date de fin. La question est posée à chaque fois.',
  },
  {
    what: '▶ Lancer l’allocation',
    where: 'Onglet Allocations · sa barre du haut remplace celle-ci',
    does:
      'Calcul court d’un seul portfolio : juste l’historique nécessaire aux poids d’aujourd’hui (même cible qu’un backtest complet, en plus rapide), '
      + 'puis fondamentaux, secteurs, risque et benchmarks. Pas besoin de lancer le backtest complet avant : la configuration est prise telle qu’elle est dans Construire. '
      + 'Les options de la barre du haut (début, dates, pré-chauffe) ne s’appliquent pas à ce calcul.',
    reuse:
      'Si ce portfolio a déjà été analysé aujourd’hui avec les mêmes réglages, l’analyse enregistrée revient directement, sans fenêtre : '
      + 'un bandeau ♻ l’indique, avec « Recalculer quand même » pour relancer avec les prix de maintenant.',
  },
  {
    what: 'Voir',
    where: 'Runs récents',
    does:
      'Réaffiche un run terminé, sans recalcul. Cette liste ne sert qu’au suivi dans ce navigateur : chaque run terminé est aussi dans l’Historique, '
      + 'et ✕ ne le retire que de la liste, pas de l’Historique.',
  },
  {
    what: 'Charger le dernier run · Ouvrir un fichier résultat · Historique',
    where: 'Onglets Résultats et Historique',
    does: 'Recharge un run déjà enregistré (ou un fichier exporté), sans recalcul.',
  },
];

export default function RunHelp() {
  return (
    <details className={styles.runHelp}>
      <summary>Quel bouton lance quoi ? Quand l’historique est-il repris au lieu de recalculer ?</summary>
      <dl>
        {ITEMS.map((it) => (
          <div key={it.what}>
            <dt>
              <strong>{it.what}</strong>
              <span>{it.where}</span>
            </dt>
            <dd>{it.does}</dd>
            {it.reuse && <dd className={styles.runHelpReuse}>♻ {it.reuse}</dd>}
          </div>
        ))}
      </dl>
      <p className={styles.runHelpFoot}>
        Dans tous les cas, chaque ticker téléchargé est gardé en entier pour toujours dans la base de tickers du moteur (section Tickers), partagée entre tous les runs :
        un recalcul ne retélécharge pas les prix déjà connus. Si des tickers ne sont pas à jour, le lancement demande : les utiliser tels quels, compléter seulement les jours manquants (quelques jours par ticker, vérifiés contre les splits), ou tout retélécharger.
      </p>
    </details>
  );
}
