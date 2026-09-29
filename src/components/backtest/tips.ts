/** Hover explanations for the builder, the variant generator and the run bar (wording checked against the engine). */
export const TIPS = {
  // Capital et flux
  initialValue: 'Montant investi au premier jour de la simulation.',
  addedAmount: 'Somme ajoutée à chaque échéance (0 = aucun apport). Les statistiques « sans apports » l’ignorent.',
  addedFrequency: 'Rythme des apports périodiques.',
  rebalancing: 'Rythme auquel le portfolio revient à ses poids cibles (et recalcule le momentum s’il est activé).',
  benchmark: 'Indice de comparaison pour le bêta, l’alpha et les graphiques (ex. ^GSPC, SPY, QQQ).',
  dividendsCash: 'Coché : les dividendes s’accumulent en cash au lieu d’être réinvestis. Décoché : ils sont réinvestis dans le titre qui les verse.',
  idleCash: 'Le cash non investi rapporte le taux des bons du Trésor à 3 mois (^IRX), composé chaque jour. Sinon il rapporte 0 %.',
  fusion: 'Combine plusieurs portfolios existants, chacun avec son propre rebalancement ; la fusion les rééquilibre entre eux.',
  excludeCashflowSync: 'La synchro « apports » depuis le 1er portfolio ignore ce portfolio.',
  excludeRebalSync: 'La synchro « rebalancement » depuis le 1er portfolio ignore ce portfolio.',

  // Momentum
  momentum: 'Au lieu de poids fixes, chaque rebalancement donne plus de poids aux titres qui ont le plus monté sur les fenêtres choisies.',
  strategy:
    'Classique : seuls les titres en hausse reçoivent un poids, proportionnel à leur rendement. '
    + 'Relatif : tous les titres gardent un poids, décalé pour que le plus faible reste juste au-dessus de 0. '
    + 'Near-Zero Symmetry : comme Relatif, mais les rendements proches de 0 (±5 %) reçoivent des poids voisins et les titres très négatifs sont fortement réduits.',
  negative:
    'Quand tous les titres ont un momentum négatif : aller 100 % en cash, répartir à parts égales, '
    + 'ou garder un classement relatif (Relatif / Near-Zero Symmetry).',
  lookback: 'Durée de la fenêtre de rendement, en jours calendaires (ex. 365 = rendement sur un an).',
  exclude: 'Jours les plus récents ignorés à la fin de la fenêtre (ex. 30 = on saute le dernier mois, qui a souvent tendance à se retourner).',
  windowWeight: 'Poids de cette fenêtre dans le score momentum final (les poids des fenêtres devraient totaliser 100 %).',
  discardNegative: 'Un titre dont le rendement sur cette fenêtre est négatif est exclu de ce rebalancement.',
  requireRecentPositive: 'Avec « Rejeter si négatif » : le titre est gardé malgré tout si son rendement récent est positif.',
  betaWeighting:
    'Pondération inverse au bêta : le poids momentum de chaque titre est divisé par |bêta| (mesuré contre le benchmark), puis les poids sont remis à 100 %. '
    + 'Les titres qui amplifient les mouvements du marché reçoivent donc moins de poids.',
  volWeighting:
    'Pondération inverse à la volatilité : le poids momentum de chaque titre est divisé par sa volatilité annualisée, puis les poids sont remis à 100 %. '
    + 'Les titres les plus agités reçoivent donc moins de poids.',
  betaWindow: 'Durée sur laquelle le bêta est mesuré, en jours calendaires.',
  volWindow: 'Durée sur laquelle la volatilité est mesurée, en jours calendaires.',
  riskExclude: 'Jours les plus récents ignorés dans cette mesure.',
  minThreshold: 'Les titres dont le poids calculé est sous ce seuil sont retirés, et leur part est redistribuée aux autres.',
  maxAllocation: 'Aucun titre ne peut dépasser ce poids ; l’excédent est redistribué aux autres.',

  // Filtre moyenne mobile
  ma: 'Un titre sous sa moyenne mobile est exclu de l’allocation jusqu’à ce qu’il repasse au-dessus.',
  maType: 'SMA : moyenne simple, chaque jour pèse pareil. EMA : moyenne exponentielle, les jours récents pèsent plus (réagit plus vite).',
  maWindow: 'Longueur de la moyenne mobile, en jours de bourse (ex. 200).',
  maMultiplier: 'Convertit les jours de bourse en jours calendaires pour charger assez d’historique (1,48 par défaut, comme Streamlit).',
  maGlobalRef: 'Tous les titres sont filtrés selon la moyenne mobile d’un seul ticker (ex. SPY sous sa MA 200 = tout le monde sort).',
  maCross: 'Rebalance immédiatement, sans attendre la prochaine date prévue, quand un titre franchit sa moyenne mobile.',
  maTolerance: 'Bande autour de la moyenne : le croisement ne compte que si le prix la dépasse de plus de ce pourcentage (évite les faux signaux).',
  maConfirmation: 'Nombre de jours consécutifs où le croisement doit tenir avant de rebalancer.',

  // Rebalancement ciblé
  targeted: 'Au lieu de rebalancer à chaque date prévue, rebalance seulement si un titre sort de sa bande min / max.',

  // Options avancées
  equalWeight: 'Garde les N titres les mieux classés et leur donne le même poids (1/N).',
  limitTopN: 'Garde les N titres les mieux classés, avec des poids proportionnels à leur score (remis à 100 %).',
  sectorCap: 'Nombre maximum de titres retenus dans un même secteur (données Yahoo). Clique sur le « i » pour la différence secteur / industrie.',
  industryCap: 'Nombre maximum de titres retenus dans une même industrie (données Yahoo), plus fine que le secteur.',
  minCap:
    'Exclut les titres dont la capitalisation estimée à chaque date est sous ce seuil. '
    + 'Estimation : capitalisation actuelle × (prix de la date ÷ prix actuel). Titre sans donnée = exclu.',
  sp500Entry: 'Un titre n’est éligible qu’à partir de sa date d’entrée dans le S&P 500 (liste Wikipedia), pour limiter le biais du survivant.',
  unknownCategory:
    'Sans secteur ou industrie connus chez Yahoo, un titre est classé « Unknown ». '
    + 'Coché : tous ces titres partagent une même catégorie, soumise à la limite. Décoché : ils ne sont jamais limités.',

  // Barre de lancement
  startWith: 'Quand tous les actifs ont des données : la simulation commence quand le plus récent existe. Dès l’actif le plus ancien : elle commence plus tôt, les autres entrent à leur apparition.',
  firstRebalance: 'Fenêtre momentum complète : le premier rebalancement attend d’avoir assez d’historique pour les fenêtres. Première date de rebalancement : il a lieu à la première date prévue.',
  customDates: 'Limite la simulation à une période précise au lieu de tout l’historique disponible.',
  preheat: 'Démarre le calcul plus tôt pour remplir les fenêtres momentum, puis coupe l’affichage à la date demandée.',
} as const;
